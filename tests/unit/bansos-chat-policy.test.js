// Bansos Gateway — chat-path policy gate + request-context threading (Task 8).
//
// Proves that `src/sse/handlers/chat.js`'s `handleChat` recognizes a request
// on the Bansos public host and, before ever calling `getModelInfo` or
// dispatching to a provider (`open-sse/handlers/chatCore.js`'s
// `handleChatCore`), enforces in order: verified-ID presence, active-user
// lookup, the emergency kill switch, request/prompt size limits, the fixed
// public model, and the per-user rate/concurrency limiter. Also proves an
// ordinary (non-Bansos-host) request — including one carrying forged
// `x-9r-bansos-user-id`/`x-9r-bansos-key-id` headers — never enters this
// branch, and that a Bansos rate-limiter lease is released on every
// pre-response failure but NOT on a successful hand-off to `handleChatCore`.
//
// This file mocks every direct dependency of chat.js so no real DB/network
// is touched. It does NOT mock @/lib/bansos/policy.js or
// @/lib/bansos/constants.js — those are pure and safe to run for real
// (matches tests/unit/bansos-guard.test.js's convention).
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => false),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(async () => null),
  handleChatCore: vi.fn(),
  handleComboChat: vi.fn(async ({ body, models, handleSingleModel }) => handleSingleModel(body, models[0])),
  handleFusionChat: vi.fn(async ({ body, models, handleSingleModel }) => handleSingleModel(body, models[0])),
  detectRequiredCapabilities: vi.fn(() => new Set()),
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((fn) => fn),
  getActiveAdapterStrategy: vi.fn(() => "fallback"),
  handleBypassRequest: vi.fn(() => null),
  updateProviderCredentials: vi.fn(async () => {}),
  checkAndRefreshToken: vi.fn(async (_provider, creds) => creds),
  getProjectIdForConnection: vi.fn(async () => null),
  acquireBansosChat: vi.fn(),
  getBansosUserById: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));

vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: mocks.handleComboChat,
  handleFusionChat: mocks.handleFusionChat,
  detectRequiredCapabilities: mocks.detectRequiredCapabilities,
}));

vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: mocks.augmentModelsWithCapacityAdapter,
  withCapacityAdapterStripping: mocks.withCapacityAdapterStripping,
  getActiveAdapterStrategy: mocks.getActiveAdapterStrategy,
}));

vi.mock("open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: mocks.handleBypassRequest,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: mocks.updateProviderCredentials,
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: mocks.getProjectIdForConnection,
}));

vi.mock("@/lib/bansos/rateLimiter.js", () => ({
  acquireBansosChat: mocks.acquireBansosChat,
}));

vi.mock("@/lib/db/index.js", () => ({
  getBansosUserById: mocks.getBansosUserById,
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const BANSOS_HOST = "api.priaoslo.web.id";
const PUBLIC_MODEL = "bansos/grok-4.5";
const INTERNAL_MODEL = "gcli/grok-4.5";

const ACTIVE_USER = {
  id: "user_123",
  name: "Test User",
  requestsPerMinute: 10,
  maxConcurrentRequests: 2,
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeRequest({
  host = "router.example.com",
  headers = {},
  body = { model: PUBLIC_MODEL, messages: [{ role: "user", content: "hi" }] },
  url = "http://localhost/v1/chat/completions",
  contentLength,
} = {}) {
  const rawHeaders = { host, ...headers };
  if (contentLength !== undefined) rawHeaders["content-length"] = String(contentLength);
  const h = new Headers(rawHeaders);
  return {
    url,
    headers: h,
    json: vi.fn(async () => body),
  };
}

const DEFAULT_SETTINGS = {
  requireApiKey: false,
  comboStrategy: "fallback",
  comboStrategies: {},
  comboStickyRoundRobinLimit: 1,
  ccFilterNaming: false,
  rtkEnabled: false,
  headroomEnabled: false,
  cavemanEnabled: false,
  ponytailEnabled: false,
  pxpipeEnabled: false,
  bansosGatewayEnabled: undefined,
};

function bansosHeaders({ userId = "user_123", keyId = "key_456" } = {}) {
  const headers = {};
  if (userId !== null) headers["x-9r-bansos-user-id"] = userId;
  if (keyId !== null) headers["x-9r-bansos-key-id"] = keyId;
  return headers;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS });
  mocks.getBansosUserById.mockResolvedValue({ ...ACTIVE_USER });
  mocks.acquireBansosChat.mockReturnValue({ ok: true, release: vi.fn() });
  mocks.getComboModels.mockResolvedValue(null);
  mocks.augmentModelsWithCapacityAdapter.mockImplementation((models) => models);
  mocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("ok") });
  mocks.getModelInfo.mockResolvedValue({ provider: "gcli", model: "grok-4.5" });
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn-1", authType: "apiKey" });
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
});

describe("Bansos chat policy — rejection order (all before getModelInfo/dispatch)", () => {
  it("rejects with 401 when the verified identity headers are missing", async () => {
    const req = makeRequest({ host: BANSOS_HOST, headers: {} });
    const response = await handleChat(req);

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error.code).toBe("missing_bansos_identity");
    expect(mocks.getBansosUserById).not.toHaveBeenCalled();
    expect(mocks.acquireBansosChat).not.toHaveBeenCalled();
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("rejects with 401 when only the user-id header is present", async () => {
    const req = makeRequest({ host: BANSOS_HOST, headers: { "x-9r-bansos-user-id": "user_123" } });
    const response = await handleChat(req);

    expect(response.status).toBe(401);
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
  });

  it("rejects with 403 when the verified user is unknown or inactive", async () => {
    mocks.getBansosUserById.mockResolvedValue({ ...ACTIVE_USER, isActive: false });
    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders() });
    const response = await handleChat(req);

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.error.code).toBe("user_disabled");
    expect(mocks.acquireBansosChat).not.toHaveBeenCalled();
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("rejects with 403 when getBansosUserById returns null (unknown user id)", async () => {
    mocks.getBansosUserById.mockResolvedValue(null);
    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders() });
    const response = await handleChat(req);

    expect(response.status).toBe(403);
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
  });

  it("rejects with 503 when the emergency kill switch is off", async () => {
    mocks.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, bansosGatewayEnabled: false });
    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders() });
    const response = await handleChat(req);

    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.error.code).toBe("gateway_disabled");
    expect(mocks.acquireBansosChat).not.toHaveBeenCalled();
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("treats bansosGatewayEnabled undefined/absent as enabled (default-enabled kill switch)", async () => {
    mocks.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, bansosGatewayEnabled: undefined });
    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders() });
    const response = await handleChat(req);

    // Should proceed past the kill switch and succeed all the way to dispatch.
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(response.status).not.toBe(503);
  });

  it("rejects with 413 when Content-Length exceeds maxRequestBody (2 MiB)", async () => {
    const req = makeRequest({
      host: BANSOS_HOST,
      headers: bansosHeaders(),
      contentLength: 3 * 1024 * 1024,
    });
    const response = await handleChat(req);

    expect(response.status).toBe(413);
    const json = await response.json();
    expect(json.error.code).toBe("request_too_large");
    expect(mocks.acquireBansosChat).not.toHaveBeenCalled();
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("rejects with 413 when the serialized messages array exceeds maxPromptSize (64 KiB)", async () => {
    const bigContent = "x".repeat(70 * 1024);
    const req = makeRequest({
      host: BANSOS_HOST,
      headers: bansosHeaders(),
      body: { model: PUBLIC_MODEL, messages: [{ role: "user", content: bigContent }] },
    });
    const response = await handleChat(req);

    expect(response.status).toBe(413);
    const json = await response.json();
    expect(json.error.code).toBe("prompt_too_large");
    expect(mocks.acquireBansosChat).not.toHaveBeenCalled();
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("rejects with 400 when the requested model is not the exact public model", async () => {
    const req = makeRequest({
      host: BANSOS_HOST,
      headers: bansosHeaders(),
      body: { model: "gpt-4", messages: [] },
    });
    const response = await handleChat(req);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe("invalid_model");
    expect(mocks.acquireBansosChat).not.toHaveBeenCalled();
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("rejects with 429 + Retry-After when the RPM limit is exceeded", async () => {
    mocks.acquireBansosChat.mockReturnValue({ ok: false, reason: "rpm_limit_exceeded", retryAfterSeconds: 30 });
    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders() });
    const response = await handleChat(req);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    const json = await response.json();
    expect(json.error.code).toBe("rpm_limit_exceeded");
    expect(json.error.type).toBe("rate_limit_error");
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("rejects with 429 + Retry-After when the concurrency limit is exceeded", async () => {
    mocks.acquireBansosChat.mockReturnValue({ ok: false, reason: "concurrency_limit_exceeded", retryAfterSeconds: 1 });
    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders() });
    const response = await handleChat(req);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    const json = await response.json();
    expect(json.error.code).toBe("concurrency_limit_exceeded");
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
});

describe("Bansos chat policy — local/ordinary requests never enter the branch", () => {
  it("gates strictly on Host, not on header presence: ignores the Bansos branch for a non-Bansos host even with well-formed IDs present", async () => {
    mocks.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, requireApiKey: false });
    const req = makeRequest({
      host: "router.example.com",
      headers: bansosHeaders(),
      body: { model: "gpt-4", messages: [] },
    });
    await handleChat(req);

    expect(mocks.getBansosUserById).not.toHaveBeenCalled();
    expect(mocks.acquireBansosChat).not.toHaveBeenCalled();
  });

  it("does not authenticate a forged-header local request via the Bansos path (ordinary requireApiKey gate still applies)", async () => {
    mocks.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, requireApiKey: true });
    mocks.extractApiKey.mockReturnValue(null);
    const req = makeRequest({
      host: "router.example.com",
      headers: bansosHeaders({ userId: "attacker-forged-user", keyId: "attacker-forged-key" }),
      body: { model: "gpt-4", messages: [] },
    });
    const response = await handleChat(req);

    // Ordinary requireApiKey path rejects for missing API key — proves the
    // request was processed by the ordinary gate, not silently authorized
    // via the forged Bansos headers.
    expect(response.status).toBe(401);
    expect(mocks.getBansosUserById).not.toHaveBeenCalled();
    expect(mocks.acquireBansosChat).not.toHaveBeenCalled();
  });

  it("leaves the ordinary requireApiKey flow byte-for-byte reachable when host is not Bansos", async () => {
    mocks.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, requireApiKey: true });
    mocks.extractApiKey.mockReturnValue("sk-real-key");
    mocks.isValidApiKey.mockResolvedValue(true);
    const req = makeRequest({ host: "router.example.com", body: { model: "gpt-4", messages: [] } });
    await handleChat(req);

    expect(mocks.isValidApiKey).toHaveBeenCalledWith("sk-real-key");
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
  });
});

describe("Bansos chat policy — success path rewrites model and attaches bansosContext", () => {
  it("dispatches with the internal model, preserves the original body, and passes a well-shaped bansosContext through to handleChatCore", async () => {
    const releaseFn = vi.fn();
    mocks.acquireBansosChat.mockReturnValue({ ok: true, release: releaseFn });
    const originalBody = { model: PUBLIC_MODEL, messages: [{ role: "user", content: "hi" }] };
    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders(), body: originalBody });

    await handleChat(req);

    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    const call = mocks.handleChatCore.mock.calls[0][0];

    // Internal model dispatch
    expect(call.body.model).toBe(`gcli/${"grok-4.5"}`);
    expect(call.modelInfo).toEqual({ provider: "gcli", model: "grok-4.5" });

    // bansosContext shape (verbatim per brief)
    expect(call.bansosContext).toMatchObject({
      userId: "user_123",
      apiKeyId: "key_456",
      publicModel: PUBLIC_MODEL,
      internalModel: INTERNAL_MODEL,
      release: releaseFn,
    });
    expect(typeof call.bansosContext.requestId).toBe("string");
    expect(call.bansosContext.requestId.length).toBeGreaterThan(0);
    expect(typeof call.bansosContext.startedAt).toBe("number");

    // Original client body must never be mutated (audit trail via
    // clientRawRequest.body still holds the pre-rewrite public model name).
    expect(originalBody.model).toBe(PUBLIC_MODEL);
    expect(call.clientRawRequest.body.model).toBe(PUBLIC_MODEL);
  });

  it("threads the same bansosContext through the capacity-adapter multi-model path", async () => {
    const releaseFn = vi.fn();
    mocks.acquireBansosChat.mockReturnValue({ ok: true, release: releaseFn });
    // Force the capacity-adapter branch: pretend augmentation added a 2nd model.
    mocks.augmentModelsWithCapacityAdapter.mockImplementation((models) => [...models, "openai/gpt-4o"]);

    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders() });
    await handleChat(req);

    expect(mocks.handleComboChat).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    const call = mocks.handleChatCore.mock.calls[0][0];
    expect(call.bansosContext).toMatchObject({ userId: "user_123", release: releaseFn });
  });
});

describe("Bansos chat policy — lease release on pre-response failure (Task 8 scope only)", () => {
  it("releases the lease when handleChatCore throws before any handoff", async () => {
    const releaseFn = vi.fn();
    mocks.acquireBansosChat.mockReturnValue({ ok: true, release: releaseFn });
    mocks.handleChatCore.mockRejectedValue(new Error("boom"));

    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders() });
    await expect(handleChat(req)).rejects.toThrow("boom");

    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it("releases the lease when no active credentials exist for the provider (never reaches handleChatCore)", async () => {
    const releaseFn = vi.fn();
    mocks.acquireBansosChat.mockReturnValue({ ok: true, release: releaseFn });
    mocks.getProviderCredentials.mockResolvedValue(null);

    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders() });
    const response = await handleChat(req);

    expect(response.status).toBe(404);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it("releases the lease when handleChatCore resolves success:false with no further fallback", async () => {
    const releaseFn = vi.fn();
    mocks.acquireBansosChat.mockReturnValue({ ok: true, release: releaseFn });
    mocks.handleChatCore.mockResolvedValue({
      success: false,
      status: 502,
      response: new Response(JSON.stringify({ error: "bad gateway" }), { status: 502 }),
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });

    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders() });
    const response = await handleChat(req);

    expect(response.status).toBe(502);
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it("does NOT release the lease on a successful hand-off (Task 9 owns that)", async () => {
    const releaseFn = vi.fn();
    mocks.acquireBansosChat.mockReturnValue({ ok: true, release: releaseFn });
    mocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("ok") });

    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders() });
    await handleChat(req);

    expect(releaseFn).not.toHaveBeenCalled();
  });

  it("keeps the lease held across an internal account-fallback retry (still one client-facing request)", async () => {
    const releaseFn = vi.fn();
    mocks.acquireBansosChat.mockReturnValue({ ok: true, release: releaseFn });
    mocks.getProviderCredentials
      .mockResolvedValueOnce({ connectionId: "conn-1", authType: "apiKey" })
      .mockResolvedValueOnce({ connectionId: "conn-2", authType: "apiKey" });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 500, response: new Response("err", { status: 500 }) })
      .mockResolvedValueOnce({ success: true, response: new Response("ok") });

    const req = makeRequest({ host: BANSOS_HOST, headers: bansosHeaders() });
    await handleChat(req);

    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(releaseFn).not.toHaveBeenCalled();
  });
});
