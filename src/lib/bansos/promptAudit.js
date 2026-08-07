// Bansos Gateway — seven-day, redactable prompt audit trail (Task 10).
//
// Four exports, per the task brief:
//   - extractPromptRepresentation(body): body.messages ONLY → a bounded,
//     structurally-faithful snapshot. Never touches headers,
//     clientRawRequest, or any provider/response object — this module's
//     only input, end to end, is the request body a Bansos client sent.
//     "Prompt" here means the same thing it means in
//     src/sse/handlers/chat.js's resolveBansosChatRequest prompt-size guard
//     (Task 8): the serialized `messages` array, not the whole body.
//   - redactBansosSecrets(value): two-layer, copy-on-write redaction.
//   - startBansosPromptAudit(context, body): builds the redacted+bounded
//     representation and inserts the audit row. Fire-and-forget, fail-open.
//   - finalizeBansosPromptAudit(context, outcome): finalizes the row at
//     request completion. Fire-and-forget, fail-open.
//
// Fail-open is load-bearing: every exported function that touches the repo
// layer wraps its ENTIRE body in try/catch and never throws. Audit logging
// must never fail, delay, or otherwise affect real inference — a lost audit
// row is an acceptable outcome; a broken chat response is not. Matching the
// existing fire-and-forget convention used throughout this codebase for
// non-critical persistence (see saveRequestDetail(...).catch(...) call sites
// in open-sse/handlers/chatCore/*.js), neither function here is awaited
// internally — the repo call is issued and its promise is given a `.catch`,
// but this module's own functions return before that promise settles.
//
// Naming collision note (see task-10-brief.md / the plan's Task 10 notes):
// bansosRepo.js also exports a function named `finalizeBansosPromptAudit`,
// with a DIFFERENT signature ((requestId, data) vs. this module's
// (context, outcome)). Aliased on import below so there is no shadowing.
import {
  insertBansosPromptAudit,
  finalizeBansosPromptAudit as finalizeBansosPromptAuditRow,
} from "@/lib/db/repos/bansosRepo.js";
import { BANSOS_LIMITS } from "./constants.js";

const REDACTION_MARKER = "[REDACTED]";
const TRUNCATION_MARKER = "...[TRUNCATED]";

// ── extractPromptRepresentation ─────────────────────────────────────────

/**
 * Serialize a chat request body's `messages` array (roles, content, tool
 * calls — whatever's structurally present) into a bounded, structured
 * representation suitable for redaction + audit storage. Not a lossless
 * round-trip — just a structurally-faithful snapshot of what was sent.
 *
 * Deliberately reads ONLY `body.messages`. Never accepts/reads headers,
 * `clientRawRequest`, or any provider/response object — callers must never
 * pass those in, and this function has no code path that could use them
 * even if they were passed.
 *
 * @param {object} body - the ORIGINAL (pre-model-rewrite) request body.
 * @returns {{ messages: object[] }}
 */
export function extractPromptRepresentation(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  // structuredClone: deep-copies every message (and nested content/tool_call
  // objects) so the caller's original body/messages are never mutated or
  // shared by reference with what we go on to redact/store. Same convention
  // already used for this exact reason in resolveBansosChatRequest
  // (src/sse/handlers/chat.js) when it clones body before the model rewrite.
  return { messages: structuredClone(messages) };
}

// ── redactBansosSecrets ──────────────────────────────────────────────────

// Layer 1 (structural): any object property whose NAME matches this,
// case-insensitively, has its value replaced wholesale — regardless of what
// the value looks like, and without recursing into it (a matched key's
// value is never inspected further; the whole subtree is gone).
const SECRET_KEY_NAME_RE = /password|secret|credential|api[_-]?key|token/i;

// Layer 2 (text-pattern, defense in depth): scans STRING values — including
// ones that survived layer 1 (e.g. free-text content, not a property value)
// — for secret-shaped substrings. Each pattern's matched span is replaced;
// order doesn't matter for correctness since replacement text ("[REDACTED]"/
// "Bearer [REDACTED]"/etc.) never itself matches any of these patterns.
const PEM_PRIVATE_KEY_RE = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g;
const COOKIE_HEADER_RE = /\b(Cookie|Set-Cookie):\s*[^\n\r]*/gi;
const OAUTH_TOKEN_FIELD_RE = /\b(access_token|refresh_token)\b(\s*[:=]\s*)"?([A-Za-z0-9\-._~+/]+=*)"?/gi;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
// Three base64url segments separated by dots — the shape of a JWT
// (header.payload.signature). No signature validity is required or checked.
const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
// `bns_...` (Bansos's own key format, keyService.js) / `sk-...` (generic
// OpenAI-style key prefix). Length floor keeps this from firing on short,
// innocuous hyphenated words.
const PREFIXED_KEY_RE = /\b(?:bns_|sk-)[A-Za-z0-9_-]{10,}\b/g;

function redactTextPatterns(text) {
  let out = text;
  out = out.replace(PEM_PRIVATE_KEY_RE, REDACTION_MARKER);
  out = out.replace(COOKIE_HEADER_RE, (_match, headerName) => `${headerName}: ${REDACTION_MARKER}`);
  out = out.replace(OAUTH_TOKEN_FIELD_RE, (_match, key, sep) => `${key}${sep}${REDACTION_MARKER}`);
  out = out.replace(BEARER_TOKEN_RE, `Bearer ${REDACTION_MARKER}`);
  out = out.replace(JWT_RE, REDACTION_MARKER);
  out = out.replace(PREFIXED_KEY_RE, REDACTION_MARKER);
  return out;
}

/**
 * Recursively redact secrets from a structured value (object/array/string/
 * primitive), returning a redacted COPY — the input is never mutated.
 *
 * @param {*} value
 * @returns {*} a redacted copy of `value` (primitives are returned as-is;
 *   they carry no structure and strings are handled by the text-pattern
 *   layer, not treated as "primitive passthrough").
 */
export function redactBansosSecrets(value) {
  if (typeof value === "string") return redactTextPatterns(value);
  if (Array.isArray(value)) return value.map(redactBansosSecrets);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SECRET_KEY_NAME_RE.test(key) ? REDACTION_MARKER : redactBansosSecrets(val);
    }
    return out;
  }
  return value; // number, boolean, null, undefined
}

// ── Unicode-safe truncation ──────────────────────────────────────────────

// Backs `end` off while the byte AT the cut boundary is a UTF-8 continuation
// byte (top two bits `10`, i.e. 0x80–0xBF) — meaning the cut would otherwise
// land strictly inside a multi-byte codepoint. This also correctly excludes
// a dangling LEAD byte with no room left for its continuation bytes: once
// `end` backs up onto the lead byte itself, that byte's top bits are `11`
// (0xC0+), the loop condition is false, and the lead byte is excluded too.
function backOffToCodepointBoundary(buf, end) {
  let safeEnd = end;
  while (safeEnd > 0 && (buf[safeEnd] & 0xc0) === 0x80) safeEnd--;
  return safeEnd;
}

/**
 * Truncate `str` to at most `maxBytes` UTF-8 bytes, never splitting a
 * multi-byte codepoint, appending a visible marker when truncation actually
 * happens. The marker's own bytes are reserved out of the budget up front,
 * so the returned string's total UTF-8 byte length never exceeds `maxBytes`
 * (for any `maxBytes` at least as large as the marker itself, which holds
 * for BANSOS_LIMITS.maxPromptSize in practice).
 *
 * @returns {{ text: string, truncated: boolean }}
 */
function truncateUtf8SafeWithMarker(str, maxBytes) {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return { text: str, truncated: false };

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  const safeEnd = backOffToCodepointBoundary(buf, budget);
  const truncatedText = buf.subarray(0, safeEnd).toString("utf8");
  return { text: truncatedText + TRUNCATION_MARKER, truncated: true };
}

// ── startBansosPromptAudit ────────────────────────────────────────────────

/**
 * Build the redacted, bounded prompt representation for a Bansos request
 * and insert its audit row. Call this from
 * src/sse/handlers/chat.js's resolveBansosChatRequest, AFTER the policy
 * gate has fully accepted the request (never on an early-rejection path —
 * those never reach a provider, so there is nothing to audit) and BEFORE
 * the model-rewrite, passing the ORIGINAL (pre-rewrite) body.
 *
 * Fail-open: never throws. Fire-and-forget: never awaits the repo insert
 * internally, so a slow/failed DB write can never delay/block the actual
 * chat dispatch this is auditing.
 *
 * @param {object} context - bansosContext, per Task 8's frozen shape
 *   ({ userId, apiKeyId, requestId, publicModel, internalModel, ... }).
 * @param {object} body - the ORIGINAL client-submitted body (pre-rewrite).
 */
export function startBansosPromptAudit(context, body) {
  try {
    if (!context) return;

    const representation = extractPromptRepresentation(body);
    const redacted = redactBansosSecrets(representation);
    const serialized = JSON.stringify(redacted);
    const { text: prompt, truncated: promptTruncated } =
      truncateUtf8SafeWithMarker(serialized, BANSOS_LIMITS.maxPromptSize);

    const createdAt = new Date();
    const expiresAt = new Date(
      createdAt.getTime() + BANSOS_LIMITS.promptRetentionDays * 24 * 60 * 60 * 1000
    ).toISOString();

    insertBansosPromptAudit({
      requestId: context.requestId,
      userId: context.userId,
      apiKeyId: context.apiKeyId,
      publicModel: context.publicModel,
      internalModel: context.internalModel,
      createdAt: createdAt.toISOString(),
      expiresAt,
      stream: body?.stream,
      prompt,
      promptTruncated,
    }).catch((err) => {
      console.warn("[BansosPromptAudit] insertBansosPromptAudit failed:", err?.message || err);
    });
  } catch (err) {
    console.warn("[BansosPromptAudit] startBansosPromptAudit failed (fail-open):", err?.message || err);
  }
}

// ── finalizeBansosPromptAudit ─────────────────────────────────────────────

/**
 * Finalize a Bansos request's prompt-audit row at request completion —
 * success, error, or interrupted. Pairs with each of Task 9's existing
 * `bansosContext.release()` / usage-attribution call sites (nonStreamingHandler.js,
 * sseToJsonHandler.js, streamingHandler.js, chat.js's dispatchSingleModelChat)
 * and reuses their exact same completion guards, so this is naturally
 * exactly-once per request — no additional guard needed here beyond the
 * repo's own exactly-once `completedAt` check
 * (src/lib/db/repos/bansosRepo.js's finalizeBansosPromptAudit).
 *
 * Fail-open + fire-and-forget, same contract as startBansosPromptAudit.
 * No-op when `context` is falsy — every non-Bansos call site must be a
 * complete no-op, mirroring `bansosContext.release()`'s own falsy-guard
 * convention used at every one of these call sites.
 *
 * @param {object} context - bansosContext, or falsy for a non-Bansos request.
 * @param {object} outcome - { status, httpStatus, errorCategory, tokens,
 *   durationMs, ttftMs } — all optional; omitted fields fall back to the
 *   existing row's value (see bansosRepo.js's finalizeBansosPromptAudit).
 */
export function finalizeBansosPromptAudit(context, outcome = {}) {
  try {
    if (!context) return;

    finalizeBansosPromptAuditRow(context.requestId, {
      status: outcome.status,
      httpStatus: outcome.httpStatus,
      errorCategory: outcome.errorCategory,
      tokens: outcome.tokens,
      durationMs: outcome.durationMs,
      ttftMs: outcome.ttftMs,
    }).catch((err) => {
      console.warn("[BansosPromptAudit] finalizeBansosPromptAudit (repo) failed:", err?.message || err);
    });
  } catch (err) {
    console.warn("[BansosPromptAudit] finalizeBansosPromptAudit failed (fail-open):", err?.message || err);
  }
}
