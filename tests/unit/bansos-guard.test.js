// Bansos Gateway public-host security boundary (Task 5).
//
// Proves dashboardGuard.js's proxy() recognizes requests to the Bansos host
// (api.priaoslo.web.id) and routes them through a completely separate,
// narrower gate that never falls through to the ordinary dashboard/API/
// public-LLM-API logic — regardless of path, method, cookies, CLI token, or
// "local request" status.
//
// This file has its own isolated vitest module registry, so it mocks every
// module dashboardGuard.js imports at module scope. It does NOT mock
// @/lib/bansos/policy.js or @/lib/bansos/constants.js — those are pure and
// safe to run for real (see policy's own bansos-policy.test.js for their
// direct coverage).
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
    headers: init?.headers,
  })),
  // NextResponse.next() with no argument returns the identity-stable
  // sentinel; called WITH an argument (the Bansos success path's
  // `{ request: { headers } }`), it returns the argument itself so tests can
  // inspect exactly what was forwarded downstream.
  nextFn: vi.fn((init) => (init === undefined ? mocks.nextResponse : init)),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  verifyBansosKey: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: mocks.nextFn,
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

vi.mock("@/lib/bansos/keyService.js", () => ({
  verifyBansosKey: mocks.verifyBansosKey,
  BANSOS_KEY_PREFIX: "bns_",
}));

const { proxy } = await import("../../src/dashboardGuard.js");

const BANSOS_HOST = "api.priaoslo.web.id";
const VALID_SHAPED_KEY = "bns_a1b2c3d4e5f60000000000000000000000000000000000";

function request(pathname, headers = {}, method = "GET") {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
    method,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bansos guard — host gate never falls through", () => {
  it("leaves a non-Bansos host's public LLM API flow completely untouched", async () => {
    const response = await proxy(request("/v1/chat/completions", { host: "router.example.com" }, "POST"));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
    expect(mocks.verifyBansosKey).not.toHaveBeenCalled();
  });
});

describe("bansos guard — endpoint/method allowlist is checked before auth", () => {
  it("404s on /dashboard for the Bansos host without reading cookies or calling verifyBansosKey", async () => {
    const req = request("/dashboard", { host: BANSOS_HOST }, "GET");
    const response = await proxy(req);

    expect(response.status).toBe(404);
    expect(mocks.verifyBansosKey).not.toHaveBeenCalled();
    expect(req.cookies.get).not.toHaveBeenCalled();
  });

  it("404s on /api/bansos for the Bansos host", async () => {
    const response = await proxy(request("/api/bansos/keys", { host: BANSOS_HOST }, "GET"));
    expect(response.status).toBe(404);
  });

  it("404s on /v1/responses for the Bansos host, even with a well-formed bearer token", async () => {
    const response = await proxy(request("/v1/responses", {
      host: BANSOS_HOST,
      authorization: `Bearer ${VALID_SHAPED_KEY}`,
    }, "POST"));

    expect(response.status).toBe(404);
    expect(mocks.verifyBansosKey).not.toHaveBeenCalled();
  });

  it("404s on the wrong method for /v1/models (POST instead of GET)", async () => {
    const response = await proxy(request("/v1/models", { host: BANSOS_HOST }, "POST"));
    expect(response.status).toBe(404);
  });

  it("404s on the wrong method for /v1/chat/completions (GET instead of POST)", async () => {
    const response = await proxy(request("/v1/chat/completions", { host: BANSOS_HOST }, "GET"));
    expect(response.status).toBe(404);
  });

  it("404s on an unsupported method (DELETE) against an otherwise-allowed path", async () => {
    const response = await proxy(request("/v1/chat/completions", { host: BANSOS_HOST }, "DELETE"));
    expect(response.status).toBe(404);
  });

  it("accepts the post-rewrite form /api/v1/models and proceeds past the allowlist to auth (401, not 404)", async () => {
    const response = await proxy(request("/api/v1/models", { host: BANSOS_HOST }, "GET"));
    expect(response.status).toBe(401);
  });

  it("accepts the post-rewrite form /api/v1/chat/completions and proceeds past the allowlist to auth (401, not 404)", async () => {
    const response = await proxy(request("/api/v1/chat/completions", { host: BANSOS_HOST }, "POST"));
    expect(response.status).toBe(401);
  });
});

describe("bansos guard — only Authorization: Bearer bns_... is accepted", () => {
  it("rejects a missing Authorization header with 401", async () => {
    const response = await proxy(request("/v1/models", { host: BANSOS_HOST }, "GET"));
    expect(response.status).toBe(401);
    expect(mocks.verifyBansosKey).not.toHaveBeenCalled();
  });

  it("rejects a non-Bearer Authorization scheme with 401", async () => {
    const response = await proxy(request("/v1/models", {
      host: BANSOS_HOST,
      authorization: "Basic dXNlcjpwYXNz",
    }, "GET"));

    expect(response.status).toBe(401);
    expect(mocks.verifyBansosKey).not.toHaveBeenCalled();
  });

  it("rejects an ordinary sk-... bearer key with 401 without ever calling verifyBansosKey", async () => {
    const response = await proxy(request("/v1/models", {
      host: BANSOS_HOST,
      authorization: "Bearer sk-ordinary-9router-key",
    }, "GET"));

    expect(response.status).toBe(401);
    expect(mocks.verifyBansosKey).not.toHaveBeenCalled();
  });

  it("rejects credentials supplied via x-api-key instead of Authorization", async () => {
    const response = await proxy(request("/v1/models", {
      host: BANSOS_HOST,
      "x-api-key": VALID_SHAPED_KEY,
    }, "GET"));

    expect(response.status).toBe(401);
    expect(mocks.verifyBansosKey).not.toHaveBeenCalled();
  });

  it("rejects credentials supplied via x-goog-api-key instead of Authorization", async () => {
    const response = await proxy(request("/v1/models", {
      host: BANSOS_HOST,
      "x-goog-api-key": VALID_SHAPED_KEY,
    }, "GET"));

    expect(response.status).toBe(401);
    expect(mocks.verifyBansosKey).not.toHaveBeenCalled();
  });

  it("rejects credentials supplied via ?key= query param instead of Authorization", async () => {
    const response = await proxy(request(`/v1/models?key=${VALID_SHAPED_KEY}`, {
      host: BANSOS_HOST,
    }, "GET"));

    expect(response.status).toBe(401);
    expect(mocks.verifyBansosKey).not.toHaveBeenCalled();
  });

  it("never consults CLI token, dashboard cookie, or the local-request exemption for a Bansos request", async () => {
    const req = request("/v1/models", {
      host: BANSOS_HOST,
      "x-9r-real-ip": "127.0.0.1", // would satisfy isLocalRequest on the ordinary path
      "x-9r-cli-token": "cli-token",
    }, "GET");

    const response = await proxy(req);

    expect(response.status).toBe(401); // no bearer token -> still rejected, despite "local" signals
    expect(mocks.getConsistentMachineId).not.toHaveBeenCalled();
    expect(mocks.verifyDashboardAuthToken).not.toHaveBeenCalled();
    expect(req.cookies.get).not.toHaveBeenCalled();
  });

  it("calls verifyBansosKey exactly once, with the bare plaintext, once a bns_-prefixed bearer token is supplied", async () => {
    mocks.verifyBansosKey.mockResolvedValue({ ok: false, status: 401, code: "key_not_found" });

    await proxy(request("/v1/models", {
      host: BANSOS_HOST,
      authorization: `Bearer ${VALID_SHAPED_KEY}`,
    }, "GET"));

    expect(mocks.verifyBansosKey).toHaveBeenCalledTimes(1);
    expect(mocks.verifyBansosKey).toHaveBeenCalledWith(VALID_SHAPED_KEY);
  });
});

describe("bansos guard — verifyBansosKey outcomes", () => {
  it("returns 401 for an unknown key", async () => {
    mocks.verifyBansosKey.mockResolvedValue({ ok: false, status: 401, code: "key_not_found" });

    const response = await proxy(request("/v1/models", {
      host: BANSOS_HOST,
      authorization: `Bearer ${VALID_SHAPED_KEY}`,
    }, "GET"));

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("key_not_found");
  });

  it("returns 401 for a revoked key", async () => {
    mocks.verifyBansosKey.mockResolvedValue({ ok: false, status: 401, code: "key_revoked" });

    const response = await proxy(request("/v1/models", {
      host: BANSOS_HOST,
      authorization: `Bearer ${VALID_SHAPED_KEY}`,
    }, "GET"));

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("key_revoked");
  });

  it("returns 403 for a valid key whose owning user is disabled", async () => {
    mocks.verifyBansosKey.mockResolvedValue({ ok: false, status: 403, code: "user_disabled" });

    const response = await proxy(request("/v1/models", {
      host: BANSOS_HOST,
      authorization: `Bearer ${VALID_SHAPED_KEY}`,
    }, "GET"));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("user_disabled");
  });

  it("stamps verified opaque IDs into forwarded request headers on success", async () => {
    mocks.verifyBansosKey.mockResolvedValue({
      ok: true,
      user: { id: "user_123" },
      key: { id: "key_456" },
    });

    const response = await proxy(request("/v1/chat/completions", {
      host: BANSOS_HOST,
      authorization: `Bearer ${VALID_SHAPED_KEY}`,
    }, "POST"));

    expect(mocks.nextFn).toHaveBeenCalledTimes(1);
    const forwarded = mocks.nextFn.mock.calls[0][0];
    expect(forwarded).toBeTruthy();
    expect(forwarded.request.headers.get("x-9r-bansos-user-id")).toBe("user_123");
    expect(forwarded.request.headers.get("x-9r-bansos-key-id")).toBe("key_456");
    // Distinguishable from the bare no-arg NextResponse.next() sentinel.
    expect(response).not.toBe(mocks.nextResponse);
  });

  it("never forwards the plaintext token in any header on success", async () => {
    mocks.verifyBansosKey.mockResolvedValue({
      ok: true,
      user: { id: "user_123" },
      key: { id: "key_456" },
    });

    await proxy(request("/v1/chat/completions", {
      host: BANSOS_HOST,
      authorization: `Bearer ${VALID_SHAPED_KEY}`,
    }, "POST"));

    const forwarded = mocks.nextFn.mock.calls[0][0];
    const headerValues = [...forwarded.request.headers.values()].join(" ");
    expect(forwarded.request.headers.get("authorization")).toBeFalsy();
    expect(headerValues).not.toContain(VALID_SHAPED_KEY);
  });
});
