// Bansos Gateway — usage attribution + lease lifecycle (Task 9).
//
// Proves two independent contracts:
//
// 1. `src/lib/db/repos/usageRepo.js`'s `saveRequestUsage` persists
//    `entry.meta` into the real `usageHistory.meta` column instead of the
//    old hardcoded `{}` — both on INSERT and on the dedupe-match UPDATE path
//    (mirrors the existing `endpoint` backfill: fills a meta gap, never
//    clobbers meta that's already populated). This block uses a REAL
//    temp-dir SQLite DB (same pattern as tests/unit/bansos-repo.test.js) and
//    calls saveRequestUsage directly (awaited) so there's no fire-and-forget
//    timing race with the assertion.
//
// 2. Every completion handler (`nonStreamingHandler.js`, `sseToJsonHandler.js`,
//    `streamingHandler.js`) threads a Bansos request's `bansosContext` into
//    exactly one usageHistory-bound `saveUsageStats` call (via the shared
//    `buildBansosUsageMeta` helper in `requestDetail.js`) and releases the
//    rate-limiter lease at the correct point in the request lifecycle:
//      - non-streaming / forced-SSE-to-JSON: only on the true terminal
//        success return, NEVER on an early BAD_GATEWAY error return (those
//        can still trigger chat.js's account-fallback retry under the SAME
//        lease — releasing there would free a concurrency slot mid-retry).
//      - streaming success: from onStreamComplete (flush()).
//      - streaming error/disconnect/stall-timeout: from a wrapped
//        streamController (wrapStreamControllerForBansos), which ALSO
//        writes the interrupted usageHistory row these paths would
//        otherwise never get (status:"interrupted", tokensUnavailable:true
//        in meta — never a silently-asserted measured zero).
// This block mocks @/lib/usageDb.js (matching the existing convention in
// tests/unit/kiro-nonstream-error.test.js and
// tests/unit/openai-responses-nonstream.test.js) so assertions are
// synchronous and deterministic — no dependency on the real DB's
// fire-and-forget write actually landing before the test checks it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Block A: usageRepo.js real-DB meta persistence (Step 3) ────────────────
describe("usageRepo.saveRequestUsage — meta persistence (real DB)", () => {
  let tempDir;
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bansos-usage-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  async function loadRepo() {
    return await import("@/lib/db/repos/usageRepo.js");
  }
  async function loadAdapter() {
    const { getAdapter } = await import("@/lib/db/driver.js");
    return await getAdapter();
  }

  it("persists entry.meta into the usageHistory.meta column on insert", async () => {
    const { saveRequestUsage } = await loadRepo();
    const requestId = "req-abc-123";

    await saveRequestUsage({
      timestamp: "2026-08-07T10:00:00.000Z",
      provider: "grok-cli",
      model: "grok-4.5",
      connectionId: "conn-1",
      apiKey: "bansos-key",
      endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 42, completion_tokens: 7 },
      status: "success",
      meta: { bansosUserId: "user-1", bansosApiKeyId: "key-1", bansosRequestId: requestId },
    });

    const db = await loadAdapter();
    const row = db.get(`SELECT * FROM usageHistory ORDER BY id DESC LIMIT 1`);
    expect(row.provider).toBe("grok-cli");
    expect(row.model).toBe("grok-4.5");
    expect(row.promptTokens).toBe(42);
    expect(row.completionTokens).toBe(7);
    expect(JSON.parse(row.meta)).toEqual(expect.objectContaining({
      bansosUserId: "user-1",
      bansosApiKeyId: "key-1",
      bansosRequestId: requestId,
    }));
  });

  it("ordinary calls with no meta still write '{}' (byte-for-byte unchanged from before this fix)", async () => {
    const { saveRequestUsage } = await loadRepo();

    await saveRequestUsage({
      timestamp: "2026-08-07T10:01:00.000Z",
      provider: "openai",
      model: "gpt-4o",
      tokens: { prompt_tokens: 5, completion_tokens: 1 },
    });

    const db = await loadAdapter();
    const row = db.get(`SELECT * FROM usageHistory ORDER BY id DESC LIMIT 1`);
    expect(row.meta).toBe("{}");
    expect(row.status).toBe("ok"); // unchanged default when no status is passed
  });

  it("dedupe-match backfills meta into an existing row that has none (mirrors the endpoint backfill)", async () => {
    const { saveRequestUsage } = await loadRepo();
    const sharedTimestamp = "2026-08-07T10:02:00.000Z";
    const dedupeKey = {
      timestamp: sharedTimestamp, provider: "grok-cli", model: "grok-4.5",
      connectionId: "conn-1", apiKey: "bansos-key",
      tokens: { prompt_tokens: 10, completion_tokens: 2 },
    };

    // First write: no meta (simulates a race where an unattributed write landed first).
    await saveRequestUsage({ ...dedupeKey });
    // Second write: identical dedupe key, but this time carrying attribution.
    await saveRequestUsage({
      ...dedupeKey,
      meta: { bansosUserId: "user-2", bansosApiKeyId: "key-2", bansosRequestId: "req-2" },
    });

    const db = await loadAdapter();
    const rows = db.all(`SELECT * FROM usageHistory WHERE timestamp = ?`, [sharedTimestamp]);
    expect(rows).toHaveLength(1); // still a single row — no duplicate insert
    expect(JSON.parse(rows[0].meta)).toEqual(expect.objectContaining({
      bansosUserId: "user-2", bansosApiKeyId: "key-2", bansosRequestId: "req-2",
    }));
  });

  it("dedupe-match never overwrites meta that's already populated", async () => {
    const { saveRequestUsage } = await loadRepo();
    const sharedTimestamp = "2026-08-07T10:03:00.000Z";
    const dedupeKey = {
      timestamp: sharedTimestamp, provider: "grok-cli", model: "grok-4.5",
      connectionId: "conn-1", apiKey: "bansos-key",
      tokens: { prompt_tokens: 10, completion_tokens: 2 },
    };

    await saveRequestUsage({ ...dedupeKey, meta: { bansosUserId: "original-user" } });
    await saveRequestUsage({ ...dedupeKey, meta: { bansosUserId: "should-not-win" } });

    const db = await loadAdapter();
    const rows = db.all(`SELECT * FROM usageHistory WHERE timestamp = ?`, [sharedTimestamp]);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].meta)).toEqual({ bansosUserId: "original-user" });
  });
});

// ── Blocks B–G: handler-level threading (Steps 4–5), @/lib/usageDb.js mocked ─
const mocks = vi.hoisted(() => ({
  saveRequestUsage: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
  saveRequestDetail: mocks.saveRequestDetail,
  appendRequestLog: mocks.appendRequestLog,
}));

// Hoisted so Block G ("handleStreamingResponse — controller wrapping wiring")
// can capture the streamController that streamingHandler.js passes into
// pipeWithDisconnect, without actually running the real disconnect-aware
// stream plumbing (which needs a live network response).
const streamHandlerMocks = vi.hoisted(() => ({
  pipeWithDisconnect: vi.fn(),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  pipeWithDisconnect: streamHandlerMocks.pipeWithDisconnect,
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { saveUsageStats, buildBansosUsageMeta } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { handleStreamingResponse, buildOnStreamComplete, wrapStreamControllerForBansos } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");

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

const stubReqLogger = () => ({
  logClientRawRequest: vi.fn(), logRawRequest: vi.fn(),
  logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(),
  logTargetRequest: vi.fn(), logError: vi.fn(),
  appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn(), appendOpenAIChunk: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveRequestUsage.mockResolvedValue(undefined);
  mocks.saveRequestDetail.mockResolvedValue(undefined);
  mocks.appendRequestLog.mockResolvedValue(undefined);
});

describe("buildBansosUsageMeta", () => {
  it("maps bansosContext fields to bansos-prefixed meta keys (NOT the context's own field names)", () => {
    const ctx = makeBansosContext();
    const meta = buildBansosUsageMeta(ctx);
    expect(meta).toEqual(expect.objectContaining({
      bansosUserId: "user-123",
      bansosApiKeyId: "key-456",
      bansosRequestId: "req-789",
    }));
  });

  it("returns undefined for a null/undefined bansosContext", () => {
    expect(buildBansosUsageMeta(null)).toBeUndefined();
    expect(buildBansosUsageMeta(undefined)).toBeUndefined();
  });

  it("merges caller-supplied extra keys (e.g. tokensUnavailable)", () => {
    const meta = buildBansosUsageMeta(makeBansosContext(), { tokensUnavailable: true });
    expect(meta.tokensUnavailable).toBe(true);
  });
});

describe("saveUsageStats — meta/status threading (requestDetail.js)", () => {
  it("ordinary call (no meta/status) writes meta:{} and no forced status — unchanged from before this fix", () => {
    saveUsageStats({ provider: "openai", model: "gpt-4o", tokens: { prompt_tokens: 10, completion_tokens: 5 }, silent: true });

    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    const entry = mocks.saveRequestUsage.mock.calls[0][0];
    expect(entry.meta).toEqual({});
    expect(entry.status).toBeUndefined();
  });

  it("forwards meta + status when a caller (Bansos handler) supplies them", () => {
    const meta = { bansosUserId: "user-123", bansosApiKeyId: "key-456", bansosRequestId: "req-789" };
    saveUsageStats({ provider: "grok-cli", model: "grok-4.5", tokens: { prompt_tokens: 10, completion_tokens: 5 }, silent: true, meta, status: "success" });

    const entry = mocks.saveRequestUsage.mock.calls[0][0];
    expect(entry.meta).toEqual(meta);
    expect(entry.status).toBe("success");
  });

  it("status:'interrupted' bypasses the all-zero-tokens skip so an interrupted row still gets written", () => {
    saveUsageStats({
      provider: "grok-cli", model: "grok-4.5",
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      silent: true, status: "interrupted",
      meta: { bansosUserId: "user-123", tokensUnavailable: true },
    });

    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage.mock.calls[0][0].status).toBe("interrupted");
  });

  it("ordinary all-zero-tokens call is still skipped (no status override) — preserves existing behavior", () => {
    saveUsageStats({ provider: "openai", model: "gpt-4o", tokens: { prompt_tokens: 0, completion_tokens: 0 }, silent: true });
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });
});

describe("handleNonStreamingResponse — Bansos attribution + release (Step 1: non-stream completion)", () => {
  function successProviderResponse() {
    return new Response(JSON.stringify({
      id: "chatcmpl-1", object: "chat.completion", created: 1700000000,
      choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { headers: { "content-type": "application/json" } });
  }

  const baseArgs = (overrides = {}) => ({
    providerResponse: successProviderResponse(),
    provider: "grok-cli", model: "grok-4.5",
    sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI,
    body: { model: "gcli/grok-4.5", messages: [{ role: "user", content: "hi" }] }, stream: false,
    translatedBody: {}, finalBody: null, requestStartTime: Date.now(),
    connectionId: "conn-1", apiKey: "bansos-internal",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    onRequestSuccess: null, reqLogger: stubReqLogger(), toolNameMap: null, customToolNames: null,
    trackDone: vi.fn(), appendLog: vi.fn(), pxpipe: null, reqTag: "", log: null,
    ...overrides,
  });

  it("on success: writes exactly one attributed usageHistory row and releases the lease exactly once", async () => {
    const bansosContext = makeBansosContext();
    const result = await handleNonStreamingResponse(baseArgs({ bansosContext }));

    expect(result.success).toBe(true);
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    const entry = mocks.saveRequestUsage.mock.calls[0][0];
    expect(entry.provider).toBe("grok-cli");
    expect(entry.status).toBe("success");
    expect(entry.meta).toEqual(expect.objectContaining({
      bansosUserId: "user-123", bansosApiKeyId: "key-456", bansosRequestId: "req-789",
    }));
    expect(bansosContext.release).toHaveBeenCalledTimes(1);
  });

  it("ordinary (non-Bansos) success: meta is {}, no forced status, no release call attempted", async () => {
    const result = await handleNonStreamingResponse(baseArgs({ bansosContext: null }));

    expect(result.success).toBe(true);
    const entry = mocks.saveRequestUsage.mock.calls[0][0];
    expect(entry.meta).toEqual({});
    expect(entry.status).toBeUndefined();
  });

  it("on an upstream error (bad JSON body): does NOT release — this can still trigger chat.js's account-fallback retry under the same lease", async () => {
    const bansosContext = makeBansosContext();
    const badJsonResponse = new Response("not json", { headers: { "content-type": "application/json" } });

    const result = await handleNonStreamingResponse(baseArgs({ providerResponse: badJsonResponse, bansosContext }));

    expect(result.success).toBeFalsy();
    expect(result.status).toBe(502);
    expect(bansosContext.release).not.toHaveBeenCalled();
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it("on an upstream error (invalid SSE body when content-type is text/event-stream): does NOT release", async () => {
    const bansosContext = makeBansosContext();
    const badSseResponse = new Response("garbage, not sse", { headers: { "content-type": "text/event-stream" } });

    const result = await handleNonStreamingResponse(baseArgs({ providerResponse: badSseResponse, bansosContext }));

    expect(result.success).toBeFalsy();
    expect(bansosContext.release).not.toHaveBeenCalled();
  });
});

describe("handleForcedSSEToJson — Bansos attribution + release (Step 1: non-stream completion, forced-stream provider)", () => {
  function sseProviderResponse(raw) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    }), { headers: { "content-type": "text/event-stream" } });
  }

  const successSSE = [
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"grok-4.5","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"grok-4.5","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3}}',
    "data: [DONE]",
    "",
  ].join("\n\n");

  const baseArgs = (overrides = {}) => ({
    providerResponse: sseProviderResponse(successSSE),
    sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI,
    // NOTE: provider must NOT resolve to a PROVIDERS[p].format ===
    // "openai-responses" registry entry (e.g. "grok-cli" is registered as
    // openai-responses) — that would route this into the Codex/Responses
    // branch (convertResponsesStreamToJson) instead of the standard Chat
    // Completions SSE branch (parseSSEToOpenAIResponse) this block targets.
    // "openai" is registered with format "openai", so it correctly takes
    // the standard branch.
    provider: "openai", model: "gpt-4o",
    body: { model: "gpt-4o", messages: [] }, stream: false,
    translatedBody: {}, finalBody: null, requestStartTime: Date.now(),
    connectionId: "conn-1", apiKey: "bansos-internal",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    onRequestSuccess: null, customToolNames: null,
    trackDone: vi.fn(), appendLog: vi.fn(), reqTag: "", log: null,
    ...overrides,
  });

  it("on success: writes exactly one attributed usageHistory row and releases the lease exactly once", async () => {
    const bansosContext = makeBansosContext();
    const result = await handleForcedSSEToJson(baseArgs({ bansosContext }));

    expect(result.success).toBe(true);
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    const entry = mocks.saveRequestUsage.mock.calls[0][0];
    expect(entry.status).toBe("success");
    expect(entry.meta).toEqual(expect.objectContaining({
      bansosUserId: "user-123", bansosApiKeyId: "key-456", bansosRequestId: "req-789",
    }));
    expect(bansosContext.release).toHaveBeenCalledTimes(1);
  });

  it("on an invalid upstream SSE stream: does NOT release (fallback loop may retry under the same lease)", async () => {
    const bansosContext = makeBansosContext();
    const invalidSSE = ['data: {"error":{"message":"upstream failed"}}', "data: [DONE]", ""].join("\n\n");

    const result = await handleForcedSSEToJson(baseArgs({ providerResponse: sseProviderResponse(invalidSSE), bansosContext }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(bansosContext.release).not.toHaveBeenCalled();
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });
});

describe("buildOnStreamComplete — Bansos attribution + release (Step 1: stream completion)", () => {
  const baseArgs = (overrides = {}) => ({
    provider: "grok-cli", model: "grok-4.5", connectionId: "conn-1", apiKey: "bansos-internal",
    requestStartTime: Date.now(), body: { messages: [] }, stream: true,
    finalBody: null, translatedBody: {}, clientRawRequest: { endpoint: "/v1/chat/completions" },
    pxpipe: null, reqTag: "", log: null,
    ...overrides,
  });

  it("on stream completion with bansosContext: writes an attributed row and releases exactly once", () => {
    const bansosContext = makeBansosContext();
    const { onStreamComplete } = buildOnStreamComplete(baseArgs({ bansosContext }));

    onStreamComplete({ content: "hello", thinking: null }, { prompt_tokens: 20, completion_tokens: 10 }, Date.now());

    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    const entry = mocks.saveRequestUsage.mock.calls[0][0];
    expect(entry.status).toBe("success");
    expect(entry.meta).toEqual(expect.objectContaining({
      bansosUserId: "user-123", bansosApiKeyId: "key-456", bansosRequestId: "req-789",
    }));
    expect(bansosContext.release).toHaveBeenCalledTimes(1);
  });

  it("ordinary stream completion (no bansosContext): meta is {}, no status, nothing to release", () => {
    const { onStreamComplete } = buildOnStreamComplete(baseArgs({ bansosContext: null }));
    onStreamComplete({ content: "hello", thinking: null }, { prompt_tokens: 20, completion_tokens: 10 }, Date.now());

    const entry = mocks.saveRequestUsage.mock.calls[0][0];
    expect(entry.meta).toEqual({});
    expect(entry.status).toBeUndefined();
  });
});

describe("wrapStreamControllerForBansos — interrupted usage + release (Step 1: upstream error, timeout, client abort)", () => {
  function makeFakeController() {
    return {
      signal: {}, startTime: Date.now(),
      isConnected: vi.fn(() => true),
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
      abort: vi.fn(),
    };
  }
  const ctxInfo = { provider: "grok-cli", model: "grok-4.5", connectionId: "conn-1", apiKey: "bansos-internal", endpoint: "/v1/chat/completions" };

  it("handleError: calls the original handler, writes an interrupted row with tokensUnavailable, and releases", () => {
    const raw = makeFakeController();
    const bansosContext = makeBansosContext();
    const wrapped = wrapStreamControllerForBansos(raw, bansosContext, ctxInfo);

    const err = new Error("upstream exploded");
    wrapped.handleError(err);

    expect(raw.handleError).toHaveBeenCalledWith(err);
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    const entry = mocks.saveRequestUsage.mock.calls[0][0];
    expect(entry.status).toBe("interrupted");
    expect(entry.meta).toEqual(expect.objectContaining({
      bansosUserId: "user-123", bansosApiKeyId: "key-456", bansosRequestId: "req-789",
      tokensUnavailable: true,
    }));
    expect(bansosContext.release).toHaveBeenCalledTimes(1);
  });

  it("handleDisconnect (client abort): same contract as handleError", () => {
    const raw = makeFakeController();
    const bansosContext = makeBansosContext();
    const wrapped = wrapStreamControllerForBansos(raw, bansosContext, ctxInfo);

    wrapped.handleDisconnect("client_closed");

    expect(raw.handleDisconnect).toHaveBeenCalledWith("client_closed");
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage.mock.calls[0][0].status).toBe("interrupted");
    expect(bansosContext.release).toHaveBeenCalledTimes(1);
  });

  it("handleComplete: calls the original handler and releases, but writes NO usage row (success path already wrote one via onStreamComplete)", () => {
    const raw = makeFakeController();
    const bansosContext = makeBansosContext();
    const wrapped = wrapStreamControllerForBansos(raw, bansosContext, ctxInfo);

    wrapped.handleComplete();

    expect(raw.handleComplete).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
    expect(bansosContext.release).toHaveBeenCalledTimes(1);
  });

  it("writes the interrupted row at most once even if more than one hook fires for the same request", () => {
    const raw = makeFakeController();
    const bansosContext = makeBansosContext();
    const wrapped = wrapStreamControllerForBansos(raw, bansosContext, ctxInfo);

    wrapped.handleError(new Error("stall timeout"));
    wrapped.handleComplete(); // defensive extra call — should not double-write

    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
  });
});

describe("handleStreamingResponse — controller wrapping wiring (Step 1: timeout / client abort plumbing)", () => {
  let capturedController;
  const pipeWithDisconnectMock = streamHandlerMocks.pipeWithDisconnect;
  pipeWithDisconnectMock.mockImplementation((providerResponse, transformStream, streamController) => {
    capturedController = streamController;
    return new ReadableStream({ start(c) { c.close(); } });
  });

  function makeFakeController() {
    return {
      signal: {}, startTime: Date.now(),
      isConnected: vi.fn(() => true),
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
      abort: vi.fn(),
    };
  }

  const baseArgs = (overrides = {}) => ({
    providerResponse: new Response(new ReadableStream({ start(c) { c.close(); } }), { headers: { "content-type": "text/event-stream" } }),
    provider: "grok-cli", model: "grok-4.5",
    sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI,
    userAgent: "", body: { messages: [] }, stream: true,
    translatedBody: {}, finalBody: null, requestStartTime: Date.now(),
    connectionId: "conn-1", apiKey: "bansos-internal",
    clientRawRequest: { endpoint: "/v1/chat/completions" }, onRequestSuccess: null,
    reqLogger: null, toolNameMap: null, customToolNames: null,
    onStreamComplete: vi.fn(), streamDetailId: "detail-1",
    pxpipe: null, reqTag: "", log: null,
    ...overrides,
  });

  beforeEach(() => {
    capturedController = undefined;
    pipeWithDisconnectMock.mockClear();
  });

  it("wraps the stream controller when bansosContext is present, and the wrapped controller releases on error", async () => {
    const rawController = makeFakeController();
    const bansosContext = makeBansosContext();

    await handleStreamingResponse(baseArgs({ streamController: rawController, bansosContext }));

    expect(pipeWithDisconnectMock).toHaveBeenCalledTimes(1);
    expect(capturedController).not.toBe(rawController);

    capturedController.handleError(new Error("stall timeout"));
    expect(rawController.handleError).toHaveBeenCalled();
    expect(bansosContext.release).toHaveBeenCalledTimes(1);
  });

  it("passes the exact same streamController reference through for ordinary (non-Bansos) requests", async () => {
    const rawController = makeFakeController();

    await handleStreamingResponse(baseArgs({ streamController: rawController, bansosContext: null }));

    expect(capturedController).toBe(rawController);
  });
});
