// Bansos Gateway — seven-day prompt audit trail (Task 10).
//
// Proves `src/lib/bansos/promptAudit.js`'s four exports:
//   - extractPromptRepresentation(body): a bounded, structurally-faithful
//     snapshot of body.messages only (never headers/clientRawRequest/
//     provider-response objects — those are never even passed in).
//   - redactBansosSecrets(value): two-layer redaction — structural
//     (property-name match, regardless of value shape) and text-pattern
//     (defense in depth, catches secrets embedded in free-text values too).
//   - startBansosPromptAudit(context, body): builds the redacted+truncated
//     representation and calls the repo's insertBansosPromptAudit — fire
//     and forget, fail-open.
//   - finalizeBansosPromptAudit(context, outcome): calls the repo's
//     finalizeBansosPromptAudit (aliased on import as
//     finalizeBansosPromptAuditRow inside promptAudit.js to avoid shadowing
//     — see promptAudit.js's own import line) — fire and forget, fail-open.
//
// This file mocks @/lib/db/repos/bansosRepo.js (Task 1's territory — never
// touched by this task) so no real DB is exercised; @/lib/bansos/constants.js
// is NOT mocked (pure, matches the existing bansos test convention of
// running policy/constants modules for real).
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BEARER_TOKEN_SAMPLE,
  TEXT_PATTERN_SECRET_SAMPLES,
  NESTED_SECRET_OBJECT_SAMPLE,
} from "./fixtures/bansos/secrets.js";

const mocks = vi.hoisted(() => ({
  repoInsert: vi.fn(async (data) => ({ ...data, completedAt: null })),
  repoFinalize: vi.fn(async (requestId, data) => ({ requestId, ...data })),
}));

vi.mock("@/lib/db/repos/bansosRepo.js", () => ({
  insertBansosPromptAudit: mocks.repoInsert,
  finalizeBansosPromptAudit: mocks.repoFinalize,
}));

const { BANSOS_LIMITS } = await import("@/lib/bansos/constants.js");
const {
  extractPromptRepresentation,
  redactBansosSecrets,
  startBansosPromptAudit,
  finalizeBansosPromptAudit,
} = await import("@/lib/bansos/promptAudit.js");

const TRUNCATION_MARKER = "...[TRUNCATED]";
const REDACTION_MARKER = "[REDACTED]";

function makeBansosContext(overrides = {}) {
  return {
    userId: "user-123",
    apiKeyId: "key-456",
    requestId: "req-789",
    publicModel: "bansos/grok-4.5",
    internalModel: "gcli/grok-4.5",
    release: vi.fn(),
    startedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repoInsert.mockImplementation(async (data) => ({ ...data, completedAt: null }));
  mocks.repoFinalize.mockImplementation(async (requestId, data) => ({ requestId, ...data }));
});

// ── extractPromptRepresentation ─────────────────────────────────────────
describe("extractPromptRepresentation", () => {
  it("captures messages (roles, content, tool calls) into a structured representation", () => {
    const body = {
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi there" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "42" },
      ],
    };

    const repr = extractPromptRepresentation(body);

    expect(repr.messages).toHaveLength(4);
    expect(repr.messages[0]).toMatchObject({ role: "system", content: "be nice" });
    expect(repr.messages[2].tool_calls[0]).toMatchObject({ id: "call_1", function: { name: "lookup" } });
    expect(repr.messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "42" });
  });

  it("only reads body.messages — other body fields (model, stream, temperature) never surface in the representation", () => {
    const body = {
      model: "bansos/grok-4.5",
      stream: true,
      temperature: 0.7,
      api_key: "sk-should-not-leak-via-this-path",
      messages: [{ role: "user", content: "hi" }],
    };

    const repr = extractPromptRepresentation(body);

    expect(Object.keys(repr)).toEqual(["messages"]);
    expect(JSON.stringify(repr)).not.toContain("temperature");
    expect(JSON.stringify(repr)).not.toContain("sk-should-not-leak-via-this-path");
  });

  it("returns an empty messages array when body.messages is missing or not an array", () => {
    expect(extractPromptRepresentation({})).toEqual({ messages: [] });
    expect(extractPromptRepresentation({ messages: "not-an-array" })).toEqual({ messages: [] });
    expect(extractPromptRepresentation(null)).toEqual({ messages: [] });
    expect(extractPromptRepresentation(undefined)).toEqual({ messages: [] });
  });

  it("does not mutate the original body or its message objects", () => {
    const original = { messages: [{ role: "user", content: "hi" }] };
    const snapshot = JSON.parse(JSON.stringify(original));

    const repr = extractPromptRepresentation(original);
    repr.messages[0].content = "mutated-in-the-copy";

    expect(original).toEqual(snapshot);
  });
});

// ── redactBansosSecrets — structural layer ──────────────────────────────
describe("redactBansosSecrets — structural layer (property-name match)", () => {
  it("redacts password/secret/credential/api-key/token-named properties at every nesting depth, regardless of value shape", () => {
    const redacted = redactBansosSecrets(NESTED_SECRET_OBJECT_SAMPLE);

    expect(redacted.password).toBe(REDACTION_MARKER);
    expect(redacted.profile.apiKey).toBe(REDACTION_MARKER);
    expect(redacted.profile.nested["api-key"]).toBe(REDACTION_MARKER);
    expect(redacted.profile.nested.api_key).toBe(REDACTION_MARKER);
    expect(redacted.profile.nested.secret).toBe(REDACTION_MARKER);
    expect(redacted.profile.nested.user_token).toBe(REDACTION_MARKER);
    expect(redacted.profile.nested.refreshToken).toBe(REDACTION_MARKER);

    // A matched key's value is replaced WHOLESALE — never recursed into,
    // even when the value itself is a nested object with its own fields.
    expect(redacted.profile.nested.credential).toBe(REDACTION_MARKER);
    expect(JSON.stringify(redacted)).not.toContain("clientSecret");
    expect(JSON.stringify(redacted)).not.toContain("should-never-surface-either-way");
  });

  it("leaves non-matching keys and their values untouched", () => {
    const redacted = redactBansosSecrets(NESTED_SECRET_OBJECT_SAMPLE);
    expect(redacted.role).toBe("user");
    expect(redacted.content).toBe("hello, this part is not sensitive");
  });

  it("returns a redacted COPY — never mutates the input", () => {
    const before = JSON.parse(JSON.stringify(NESTED_SECRET_OBJECT_SAMPLE));
    redactBansosSecrets(NESTED_SECRET_OBJECT_SAMPLE);
    expect(NESTED_SECRET_OBJECT_SAMPLE).toEqual(before);
  });

  it("redacts secret-named keys inside arrays of objects (e.g. tool_calls-shaped structures)", () => {
    const value = { tool_calls: [{ id: "1", function: { name: "auth", arguments: { api_key: "leaky" } } }] };
    const redacted = redactBansosSecrets(value);
    expect(redacted.tool_calls[0].function.arguments.api_key).toBe(REDACTION_MARKER);
  });

  it("passes through primitives (numbers, booleans, null) unchanged", () => {
    expect(redactBansosSecrets(42)).toBe(42);
    expect(redactBansosSecrets(true)).toBe(true);
    expect(redactBansosSecrets(null)).toBe(null);
  });
});

// ── redactBansosSecrets — text-pattern layer (defense in depth) ─────────
describe("redactBansosSecrets — text-pattern layer (secrets embedded in free-text string values)", () => {
  for (const sample of TEXT_PATTERN_SECRET_SAMPLES) {
    it(`redacts a ${sample.name} embedded in a plain string (no matching property name involved)`, () => {
      const redacted = redactBansosSecrets(sample.text);
      expect(typeof redacted).toBe("string");
      expect(redacted).toContain(REDACTION_MARKER);
      expect(redacted).not.toContain(sample.raw);
    });

    it(`redacts a ${sample.name} embedded inside a nested content array (not just a top-level string)`, () => {
      const value = { messages: [{ role: "user", content: [{ type: "text", text: sample.text }] }] };
      const redacted = redactBansosSecrets(value);
      const redactedText = redacted.messages[0].content[0].text;
      expect(redactedText).toContain(REDACTION_MARKER);
      expect(redactedText).not.toContain(sample.raw);
    });
  }

  it("does not falsely flag ordinary prose with no secret-shaped content", () => {
    const ordinary = "The weather today is sunny with a gentle breeze from the west.";
    expect(redactBansosSecrets(ordinary)).toBe(ordinary);
  });
});

// ── startBansosPromptAudit ───────────────────────────────────────────────
describe("startBansosPromptAudit", () => {
  it("calls insertBansosPromptAudit with the right shape: identity fields, expiresAt = createdAt + 7 days, redacted+serialized prompt", () => {
    const context = makeBansosContext();
    const body = { model: "bansos/grok-4.5", stream: true, messages: [{ role: "user", content: "hello" }] };
    const before = Date.now();

    startBansosPromptAudit(context, body);

    expect(mocks.repoInsert).toHaveBeenCalledTimes(1);
    const call = mocks.repoInsert.mock.calls[0][0];

    expect(call.requestId).toBe("req-789");
    expect(call.userId).toBe("user-123");
    expect(call.apiKeyId).toBe("key-456");
    expect(call.publicModel).toBe("bansos/grok-4.5");
    expect(call.internalModel).toBe("gcli/grok-4.5");
    expect(call.stream).toBe(true);
    expect(call.promptTruncated).toBe(false);

    expect(typeof call.prompt).toBe("string");
    const parsed = JSON.parse(call.prompt);
    expect(parsed.messages[0]).toMatchObject({ role: "user", content: "hello" });

    // expiresAt ~ createdAt + BANSOS_LIMITS.promptRetentionDays days.
    const expiresAtMs = new Date(call.expiresAt).getTime();
    const expectedMinMs = before + BANSOS_LIMITS.promptRetentionDays * 24 * 60 * 60 * 1000;
    const expectedMaxMs = Date.now() + BANSOS_LIMITS.promptRetentionDays * 24 * 60 * 60 * 1000;
    expect(expiresAtMs).toBeGreaterThanOrEqual(expectedMinMs - 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(expectedMaxMs + 1000);
  });

  it("redacts secrets before persisting — the stored prompt never contains the raw secret", () => {
    const context = makeBansosContext();
    const body = {
      messages: [{ role: "user", content: `Here is my key: ${BEARER_TOKEN_SAMPLE}` }],
    };

    startBansosPromptAudit(context, body);

    const call = mocks.repoInsert.mock.calls[0][0];
    expect(call.prompt).toContain(REDACTION_MARKER);
    expect(call.prompt).not.toContain("sk-live-9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c");
  });

  it("is a no-op (never calls the repo) when context is falsy", () => {
    startBansosPromptAudit(null, { messages: [] });
    startBansosPromptAudit(undefined, { messages: [] });
    expect(mocks.repoInsert).not.toHaveBeenCalled();
  });

  it("never passes headers, clientRawRequest, or a response object through — only requestId/userId/apiKeyId/model fields and the derived prompt string are sent to the repo", () => {
    const context = makeBansosContext();
    const body = { messages: [{ role: "user", content: "hi" }] };

    startBansosPromptAudit(context, body);

    const call = mocks.repoInsert.mock.calls[0][0];
    const allowedKeys = new Set([
      "requestId", "userId", "apiKeyId", "publicModel", "internalModel",
      "expiresAt", "stream", "prompt", "promptTruncated", "createdAt",
    ]);
    for (const key of Object.keys(call)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  it("does not block/delay the caller — returns before the repo call's promise settles (fire-and-forget)", () => {
    let resolved = false;
    mocks.repoInsert.mockImplementation(() => new Promise((resolve) => {
      // Never resolves during this test — if startBansosPromptAudit awaited
      // this internally, the function call below would hang the test.
      setTimeout(() => { resolved = true; resolve({}); }, 0);
    }));

    const context = makeBansosContext();
    startBansosPromptAudit(context, { messages: [] });

    // Synchronous return — the repo promise has not had a chance to settle.
    expect(resolved).toBe(false);
  });

  describe("Unicode-safe truncation at BANSOS_LIMITS.maxPromptSize bytes", () => {
    // Every emoji below is a 4-byte UTF-8 sequence. Padding the run's start
    // by 0..3 ASCII bytes shifts the maxPromptSize-byte cut point through
    // all 4 possible alignments relative to a 4-byte codepoint boundary —
    // guaranteeing at least 3 of these 4 cases land the naive cut point
    // strictly inside a codepoint (which a byte-split bug would corrupt into
    // U+FFFD replacement characters), regardless of how many ASCII bytes of
    // JSON-envelope overhead (quotes, keys, braces) precede the run.
    for (let padding = 0; padding <= 3; padding++) {
      it(`truncates without splitting a multi-byte codepoint (alignment shift = ${padding} byte${padding === 1 ? "" : "s"})`, () => {
        const context = makeBansosContext();
        const prefix = "x".repeat(padding);
        const bigContent = prefix + "🚀".repeat(20000); // 80000 bytes of emoji, well over 64 KiB
        const body = { messages: [{ role: "user", content: bigContent }] };

        startBansosPromptAudit(context, body);

        const call = mocks.repoInsert.mock.calls.at(-1)[0];
        expect(call.promptTruncated).toBe(true);
        expect(call.prompt.includes("�")).toBe(false);
        expect(call.prompt.endsWith(TRUNCATION_MARKER)).toBe(true);
        expect(Buffer.byteLength(call.prompt, "utf8")).toBeLessThanOrEqual(BANSOS_LIMITS.maxPromptSize);
      });
    }

    it("does not truncate (and sets promptTruncated:false) for a prompt well under the limit", () => {
      const context = makeBansosContext();
      startBansosPromptAudit(context, { messages: [{ role: "user", content: "short" }] });

      const call = mocks.repoInsert.mock.calls[0][0];
      expect(call.promptTruncated).toBe(false);
      expect(call.prompt.endsWith(TRUNCATION_MARKER)).toBe(false);
    });
  });

  describe("fail-open behavior", () => {
    it("does not throw when the repo layer throws synchronously", () => {
      mocks.repoInsert.mockImplementation(() => { throw new Error("db exploded"); });
      const context = makeBansosContext();

      expect(() => startBansosPromptAudit(context, { messages: [] })).not.toThrow();
    });

    it("does not throw (and does not produce an unhandled rejection) when the repo layer rejects asynchronously", async () => {
      mocks.repoInsert.mockRejectedValue(new Error("db exploded async"));
      const context = makeBansosContext();

      expect(() => startBansosPromptAudit(context, { messages: [] })).not.toThrow();
      // Let the rejected promise's .catch() handler run before the test ends.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("does not throw when the body is malformed in a way that could break serialization (circular reference)", () => {
      const context = makeBansosContext();
      const circular = { role: "user", content: "hi" };
      circular.self = circular;
      const body = { messages: [circular] };

      expect(() => startBansosPromptAudit(context, body)).not.toThrow();
    });
  });
});

// ── finalizeBansosPromptAudit ────────────────────────────────────────────
describe("finalizeBansosPromptAudit", () => {
  it("calls the repo's finalizeBansosPromptAudit with (requestId, outcome fields)", () => {
    const context = makeBansosContext();
    const outcome = { status: "success", httpStatus: 200, tokens: { prompt_tokens: 10, completion_tokens: 5 }, durationMs: 1234, ttftMs: 56 };

    finalizeBansosPromptAudit(context, outcome);

    expect(mocks.repoFinalize).toHaveBeenCalledTimes(1);
    const [requestId, data] = mocks.repoFinalize.mock.calls[0];
    expect(requestId).toBe("req-789");
    expect(data).toMatchObject({
      status: "success",
      httpStatus: 200,
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      durationMs: 1234,
      ttftMs: 56,
    });
  });

  it("passes errorCategory through for an error outcome", () => {
    const context = makeBansosContext();
    finalizeBansosPromptAudit(context, { status: "error", httpStatus: 429, errorCategory: "rpm_limit_exceeded" });

    const [, data] = mocks.repoFinalize.mock.calls[0];
    expect(data.errorCategory).toBe("rpm_limit_exceeded");
    expect(data.httpStatus).toBe(429);
  });

  it("omits fields the caller didn't provide rather than inventing values (repo defaults from the existing row)", () => {
    const context = makeBansosContext();
    finalizeBansosPromptAudit(context, { status: "interrupted" });

    const [, data] = mocks.repoFinalize.mock.calls[0];
    expect(data.status).toBe("interrupted");
    expect(data.httpStatus).toBeUndefined();
    expect(data.tokens).toBeUndefined();
  });

  it("is a no-op (never calls the repo) when context is falsy", () => {
    finalizeBansosPromptAudit(null, { status: "success" });
    finalizeBansosPromptAudit(undefined, { status: "success" });
    expect(mocks.repoFinalize).not.toHaveBeenCalled();
  });

  describe("fail-open behavior", () => {
    it("does not throw when the repo layer throws synchronously", () => {
      mocks.repoFinalize.mockImplementation(() => { throw new Error("db exploded"); });
      const context = makeBansosContext();

      expect(() => finalizeBansosPromptAudit(context, { status: "success" })).not.toThrow();
    });

    it("does not throw when the repo layer rejects asynchronously", async () => {
      mocks.repoFinalize.mockRejectedValue(new Error("db exploded async"));
      const context = makeBansosContext();

      expect(() => finalizeBansosPromptAudit(context, { status: "error" })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
