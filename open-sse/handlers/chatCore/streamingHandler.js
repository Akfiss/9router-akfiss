import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine, buildBansosUsageMeta } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { finalizeBansosPromptAudit } from "@/lib/bansos/promptAudit.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

/**
 * Wrap a streamController (see open-sse/utils/streamHandler.js's
 * createStreamController) so a Bansos request's concurrency lease is
 * released whenever the stream actually ends — success, error, disconnect,
 * or stall-timeout — none of which have a single synchronous completion
 * point the way the non-streaming handlers do.
 *
 * `handleComplete` fires on the normal end-of-stream path — the SAME path
 * that *usually* already ran `onStreamComplete` (via the transform stream's
 * flush(), see open-sse/utils/stream.js) and wrote the success usageHistory
 * row. But flush()'s entire body — including both call sites of
 * onStreamComplete — is wrapped in a try/catch that swallows without
 * rethrowing: if anything throws before reaching onStreamComplete (e.g. a
 * translator/parser exception on a malformed final chunk from any
 * upstream), flush() still returns normally, the stream still closes, and
 * handleComplete() still fires — but onStreamComplete never ran and no row
 * was ever written for an otherwise successfully-served request. `handleComplete`
 * therefore checks `completionState` (the marker `buildOnStreamComplete`'s
 * `onStreamComplete` sets the moment it actually runs — passed in here via
 * `onStreamComplete.completionState`, since chatCore.js threads the exact
 * same `onStreamComplete` function, unmodified, into `handleStreamingResponse`)
 * and falls back to writing the same "interrupted / tokens unavailable" row
 * the error/disconnect paths use, rather than silently leaving zero rows.
 *
 * `handleError`/`handleDisconnect` fire on every path that does NOT go
 * through flush()/onStreamComplete (upstream error, client disconnect,
 * stall-timeout abort). These never get a chance to write a usageHistory
 * row otherwise, so the wrapped versions write one here — status
 * "interrupted", tokens zeroed (the DB's numeric columns aren't nullable in
 * practice, but the row is NOT a claim of "confirmed zero tokens" — meta
 * carries `tokensUnavailable: true` specifically so a reader can tell that
 * apart from a genuine zero-token request) — then release.
 *
 * A local `finalized` flag guards the "at most one usageHistory row per
 * request" invariant, and this wrapper enforces it ITSELF rather than
 * relying on createStreamController's internal `disconnected` guard: that
 * flag only protects the RAW controller's own side effects (logging,
 * onDisconnect/onError callback invocation) from double-firing — it does
 * nothing for side effects layered on top of it here. `finalized` is set by
 * WHICHEVER of handleComplete/handleError/handleDisconnect runs first, and
 * all three check it before doing any usageHistory-row work, so a
 * handleComplete followed by a late handleError/handleDisconnect (or any
 * other ordering) can never append a second row for the same request.
 * (Today's plumbing happens to make a same-request double-fire unreachable
 * in practice — controller.close() runs synchronously right after
 * handleComplete(), a .cancel() on an already-closed stream is a spec
 * no-op, and the stall timer is cleared before flush() runs — but that's an
 * implicit runtime guarantee elsewhere, not something this wrapper's own
 * code enforced before; it does now.)
 * `release()` itself is already idempotent (rateLimiter.js), so it needs no
 * such guard — calling it more than once is harmless.
 *
 * Exported for direct unit testing — see tests/unit/bansos-usage-attribution.test.js.
 *
 * @param {object} completionState - shared per-request marker returned by
 *   `buildOnStreamComplete` (`{ completed: boolean }`), or undefined. When
 *   undefined/`completed` is falsy, handleComplete safely assumes
 *   onStreamComplete has NOT run and writes the fallback row.
 */
export function wrapStreamControllerForBansos(streamController, bansosContext, { provider, model, connectionId, apiKey, endpoint }, completionState) {
  let finalized = false;

  const writeInterruptedRow = () => {
    saveUsageStats({
      provider, model, connectionId, apiKey, endpoint,
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "interrupted",
      meta: buildBansosUsageMeta(bansosContext, { tokensUnavailable: true }),
      label: "STREAM USAGE",
      silent: true,
    });
    // Task 10: finalize the prompt-audit row alongside the usageHistory
    // write above — this helper already runs under the `finalized` guard
    // (called only once, from whichever of handleError/handleDisconnect/the
    // completionState-missing fallback in handleComplete fires first), so
    // this is naturally exactly-once per request with no new guard needed.
    finalizeBansosPromptAudit(bansosContext, { status: "interrupted" });
  };

  const finalizeInterrupted = () => {
    if (finalized) return;
    finalized = true;
    writeInterruptedRow();
  };

  return {
    ...streamController,
    handleError: (err) => {
      streamController.handleError(err);
      finalizeInterrupted();
      bansosContext.release();
    },
    handleDisconnect: (reason) => {
      streamController.handleDisconnect(reason);
      finalizeInterrupted();
      bansosContext.release();
    },
    handleComplete: () => {
      streamController.handleComplete();
      if (!finalized) {
        finalized = true;
        // Normal success path already wrote a usageHistory row via
        // onStreamComplete — UNLESS flush() swallowed an exception before
        // ever reaching it (see the JSDoc above). Missing/false
        // completionState.completed means "assume it did NOT run" — the
        // safe default, since silently ending up with zero rows is worse
        // than a flagged "unavailable" one.
        if (!completionState?.completed) writeInterruptedRow();
      }
      bansosContext.release();
    },
  };
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, pxpipe, reqTag, log, bansosContext, credentials }) {
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" and crashes the chat router. Read the body,
  // pull a short human-readable message from the <title>, sanitize it, and
  // return a clean JSON error instead. The message is stripped of HTML tags
  // and clamped so untrusted upstream text never reaches the client verbatim
  // (the UI may render error.message as HTML).
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    const bodyText = await providerResponse.text().catch(() => '');
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const shortMsg = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, '').trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    const status = providerResponse.status || 502;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return {
      success: false,
      response: new Response(JSON.stringify({ error: { message: `[${status}]: ${shortMsg}` } }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials });

  // Responses passthrough: synthesize response.failed + [DONE] if the stream aborts/stalls before a terminal event
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough ? buildAbortedResponsesTerminalBytes : null;
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;

  // Bansos requests: wrap the controller so error/disconnect/stall-timeout
  // (which never reach onStreamComplete/flush()) still write an interrupted
  // usageHistory row and release the lease. Ordinary requests get the exact
  // same `streamController` reference untouched — no new behavior for them.
  // `onStreamComplete.completionState` is the shared marker buildOnStreamComplete
  // attached to the SAME onStreamComplete function chatCore.js threads in
  // here unmodified — see wrapStreamControllerForBansos's JSDoc for why
  // handleComplete needs it (Finding 1: flush() can swallow an exception
  // before ever calling onStreamComplete).
  const effectiveStreamController = bansosContext
    ? wrapStreamControllerForBansos(streamController, bansosContext, { provider, model, connectionId, apiKey, endpoint: clientRawRequest?.endpoint }, onStreamComplete?.completionState)
    : streamController;
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, effectiveStreamController, onAbortTerminal, stallTimeoutMs);

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log, bansosContext }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  // Shared, per-request completion marker (Finding 1 fix, task-9 review
  // round 1) — a fresh plain object per call, never module-global. Set to
  // `true` the moment this callback actually runs and calls saveUsageStats
  // below. wrapStreamControllerForBansos's handleComplete reads this (via
  // `onStreamComplete.completionState`, attached below) to distinguish "the
  // transform stream's flush() (open-sse/utils/stream.js) ran to completion
  // AND reached onStreamComplete" from "flush() ran to completion but
  // swallowed an exception before ever reaching onStreamComplete" — the
  // latter would otherwise silently produce zero usageHistory rows for an
  // already-served request.
  const completionState = { completed: false };

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      pxpipe,
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    // Persist stream usage to DB (no console line; the "📊 done" line below is authoritative)
    saveUsageStats({
      provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", silent: true,
      meta: buildBansosUsageMeta(bansosContext), status: bansosContext ? "success" : undefined
    });
    // Mark that onStreamComplete actually ran and wrote its row — see the
    // completionState JSDoc above. Set unconditionally (not just for
    // Bansos) since it's harmless for ordinary requests and keeps this one
    // flag meaning one thing: "saveUsageStats above was reached."
    completionState.completed = true;
    // Task 10: finalize the prompt-audit row at this same success point —
    // guarded by the same completionState/finalized machinery Task 9 built
    // (this only runs once per request on the real success path; a later
    // handleComplete/handleError/handleDisconnect in
    // wrapStreamControllerForBansos sees completionState.completed:true and
    // skips writing its own interrupted row).
    finalizeBansosPromptAudit(bansosContext, { status: "success", tokens: usage, durationMs: latency.total, ttftMs: latency.ttft });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency }));

    // Success completion point for a Bansos lease. This fires from the
    // transform stream's flush() — the normal end-of-stream path.
    // wrapStreamControllerForBansos's handleComplete also calls release()
    // after this fires (release() is idempotent, so that's a no-op, not a
    // double-release bug) and, as of the Finding 1/2 fixes, checks
    // `completionState.completed` (set immediately above) plus its own
    // `finalized` guard before deciding whether it needs to write a
    // fallback row itself — see wrapStreamControllerForBansos's JSDoc for
    // the full ordering contract this and that function now jointly
    // enforce (previously just assumed from unrelated Streams-runtime
    // behavior, not actually guaranteed by this code).
    if (bansosContext) bansosContext.release();
  };

  onStreamComplete.completionState = completionState;
  return { onStreamComplete, streamDetailId, completionState };
}
