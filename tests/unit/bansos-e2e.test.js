// Bansos Gateway — vertical acceptance suite (Task 14).
//
// Exercises the COMPLETE public request contract through the real chain:
//   dashboardGuard.proxy() -> src/sse/handlers/chat.js -> open-sse's
//   handleChatCore -> the real translator/stream machinery
// against a real temporary SQLite adapter (same pattern as
// tests/unit/bansos-repo.test.js / bansos-usage-attribution.test.js's Block
// A). The ONLY mocked module on the request path is
// open-sse/executors/index.js's getExecutor() — the true outbound-provider
// network boundary (see tests/unit/fixtures/bansos/mockExecutor.js for the
// fixture and its design rationale). "next/server" is also mocked, but only
// because NextResponse.next({request:{headers}})'s real middleware
// header-forwarding wire format (x-middleware-override-headers /
// x-middleware-request-* encoding) is a Next.js-internal implementation
// detail, not something any prior Bansos test decodes either (see
// tests/unit/bansos-guard.test.js, whose mock shape this file reuses
// verbatim) — everything else on the chain, including the REAL
// dashboardGuard.js, keyService.js (real hashing/verification against the
// real DB), policy.js, rateLimiter.js, promptAudit.js, bansosRepo.js,
// chat.js, chatCore.js, and the translator/streamHandler engine, runs for
// real.
//
// What this file deliberately does NOT re-derive (see Task 14's brief +
// progress.md for the explicit instruction not to re-prove what's already
// unit-proven elsewhere):
//   - The exactly-once usage-attribution + lease-release ordering matrix
//     across success/error/timeout/disconnect/stream-completion, at the
//     handler level — see tests/unit/bansos-usage-attribution.test.js. This
//     file exercises those SAME lifecycle branches, but only once each, at
//     the vertical/integration level (real guard->chat->chatCore->stream
//     chain), not the exhaustive completionState/finalized ordering proofs.
//   - Kill-switch admin persistence and dashboard UI wiring — see
//     tests/unit/bansos-admin-routes.test.js / bansos-dashboard.test.js
//     (Tasks 12/13's own suites).
//   - Idempotent prompt erasure via the admin route — see
//     tests/unit/bansos-admin-routes.test.js:640-651 ("erases the prompt and
//     returns 200 ... returns 404 when the repo reports no row was
//     changed"). This file's own idempotent-erasure test below calls the
//     real repo function directly (not the admin route) against a row a
//     REAL live request produced, which is additive coverage, not a
//     duplicate.
//   - Endpoint/method allowlist exhaustive enumeration — see
//     tests/unit/bansos-guard.test.js. This file includes one smoke test per
//     acceptance-matrix bullet to prove the SAME allowlist is wired into the
//     real vertical chain, not a full re-enumeration.
//   - /v1/models' one-model catalog shape — see
//     tests/unit/bansos-models-route.test.js. Not retested here (this file
//     only dispatches chat completions through the real chain; the models
//     route is a self-contained branch with no chat.js/chatCore involvement).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMockExecutorState,
  installMockExecutor,
  jsonSuccessResponse,
  streamSuccessResponse,
  midStreamErrorResponse,
  neverEndingStreamResponse,
  providerErrorResponse,
} from "./fixtures/bansos/mockExecutor.js";

const BANSOS_HOST = "api.priaoslo.web.id";
const PUBLIC_MODEL = "bansos/grok-4.5";

// The first test in this file pays for cold-start costs the rest of the
// suite doesn't (native better-sqlite3 binary load, module transform of the
// whole guard->chat->chatCore->translator chain) — comfortably over
// vitest's 5000ms default on a loaded machine. Every real assertion in this
// file resolves in well under a second once warm; this only guards against
// that one-time cost.
vi.setConfig({ testTimeout: 20000 });

// ── "next/server" mock — see file header for why this boundary is mocked ──
const nextServerMocks = vi.hoisted(() => ({
  nextResponseSentinel: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body, headers: init?.headers })),
  nextFn: vi.fn((init) => (init === undefined ? nextServerMocks.nextResponseSentinel : init)),
  redirectFn: vi.fn((url) => ({ status: 307, url })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: nextServerMocks.nextFn,
    json: nextServerMocks.jsonResponse,
    redirect: nextServerMocks.redirectFn,
  },
}));

// ── getExecutor() mock — the true outbound-provider network boundary ──────
const executorState = createMockExecutorState();
const mockExecutor = installMockExecutor(executorState);

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => mockExecutor,
  hasSpecializedExecutor: () => false,
}));

beforeEach(() => {
  vi.clearAllMocks();
  executorState.calls.length = 0;
  executorState.next.length = 0;
});

// ── Real temporary SQLite DB per test (same pattern as bansos-repo.test.js) ─
let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bansos-e2e-"));
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

// Fresh imports every test (post-resetModules, post-DATA_DIR) — see
// src/lib/dataDir.js: DATA_DIR is captured once at module-load time, so a
// stale import from a previous test would silently read/write the wrong
// (deleted) temp directory.
async function loadStack() {
  const dashboardGuard = await import("@/dashboardGuard.js");
  const chat = await import("@/sse/handlers/chat.js");
  const db = await import("@/lib/db/index.js");
  const keyService = await import("@/lib/bansos/keyService.js");
  const rateLimiter = await import("@/lib/bansos/rateLimiter.js");
  const retention = await import("@/lib/bansos/retention.js");
  return { ...dashboardGuard, ...chat, db, keyService, rateLimiter, retention };
}

// ── Request-building helpers ───────────────────────────────────────────────

function makeGuardRequest(pathname, headers = {}, method = "GET") {
  const normalizedHeaders = new Headers(headers);
  const url = `https://${headers.host || "localhost"}${pathname}`;
  return {
    nextUrl: { pathname, searchParams: new URL(url).searchParams },
    headers: normalizedHeaders,
    cookies: { get: () => undefined },
    url,
    method,
  };
}

// Runs a request through the REAL guard, then — unless the guard itself
// terminated the request — through the REAL chat.js, exactly mirroring how
// Next.js's real middleware->route-handler rewrite pipeline forwards
// (possibly guard-modified) headers into the route handler.
async function dispatch({ proxy, handleChat }, { pathname, headers, method = "POST", body }) {
  const guardReq = makeGuardRequest(pathname, headers, method);
  const guardResult = await proxy(guardReq);

  // A guard-issued NextResponse.json(...) — request never reaches chat.js.
  if (guardResult && typeof guardResult.status === "number" && "body" in guardResult && !("url" in guardResult)) {
    return { stage: "guard", response: guardResult };
  }
  // A guard-issued redirect — never applicable to /v1/* paths, but guard
  // defensively.
  if (guardResult && typeof guardResult.status === "number" && "url" in guardResult) {
    return { stage: "guard", response: guardResult };
  }

  const forwardedHeaders = guardResult?.request?.headers instanceof Headers
    ? guardResult.request.headers
    : guardReq.headers;

  const chatReq = {
    headers: forwardedHeaders,
    url: guardReq.url,
    json: async () => body,
  };
  const response = await handleChat(chatReq);
  return { stage: "chat", response };
}

async function jsonOf(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// Polls a real (fire-and-forget-backed) query until it returns a truthy
// result or a short deadline elapses — startBansosPromptAudit/
// finalizeBansosPromptAudit/saveUsageStats are all deliberately
// fire-and-forget (never awaited by the handler code that calls them), so a
// vertical test using the REAL DB (not a mocked usageDb/promptAudit module,
// unlike tests/unit/bansos-usage-attribution.test.js) must tolerate that
// async gap rather than racing it.
async function waitFor(fn, { timeoutMs = 2000, intervalMs = 15 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── DB seeding helpers ──────────────────────────────────────────────────────

async function seedGrokCliConnection(db) {
  return db.createProviderConnection({
    provider: "grok-cli",
    authType: "oauth",
    name: "mock-grok-cli-account",
    accessToken: "mock-access-token",
    refreshToken: "mock-refresh-token",
    // Far-future expiry: keeps checkAndRefreshToken's proactive-refresh
    // branch a no-op, so this vertical test never has to mock (or actually
    // trigger) a real network token refresh.
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    isActive: true,
  });
}

async function seedBansosUser({ db, keyService }, overrides = {}) {
  const user = await db.createBansosUser({
    name: "Acceptance Tester",
    requestsPerMinute: 10,
    maxConcurrentRequests: 2,
    ...overrides,
  });
  const { plaintext } = await keyService.createBansosKey({ userId: user.id, name: "primary" });
  return { user, plaintext };
}

function chatBody(overrides = {}) {
  return { model: PUBLIC_MODEL, messages: [{ role: "user", content: "ping" }], stream: false, ...overrides };
}

// ============================================================================
// Credential isolation
// ============================================================================
describe("Credential isolation (Bansos host vs. ordinary host)", () => {
  it("rejects a missing Authorization header on the Bansos host with 401, and the executor is never invoked", async () => {
    const stack = await loadStack();
    const { stage, response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST }, body: chatBody(),
    });

    expect(stage).toBe("guard");
    expect(response.status).toBe(401);
    expect(executorState.calls).toHaveLength(0);
  });

  it("rejects an ordinary local sk-... key presented on the Bansos host — Bansos auth never falls back to validateApiKey", async () => {
    const stack = await loadStack();
    const { response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST, authorization: "Bearer sk-some-ordinary-key" },
      body: chatBody(),
    });

    expect(response.status).toBe(401);
    expect(executorState.calls).toHaveLength(0);
  });

  it("rejects a genuine Bansos bns_ key presented as an ordinary key on a local/ordinary host — Bansos keys never authenticate through validateApiKey", async () => {
    const stack = await loadStack();
    await stack.db.updateSettings({ requireApiKey: true });
    const { plaintext } = await seedBansosUser(stack);

    const { response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: "localhost", authorization: `Bearer ${plaintext}` },
      body: chatBody({ model: "gcli/grok-4.5" }),
    });

    expect(response.status).toBe(401);
    expect(executorState.calls).toHaveLength(0);
  });

  it("rejects a revoked Bansos key with 401 and never dispatches", async () => {
    const stack = await loadStack();
    const { user, plaintext } = await seedBansosUser(stack);
    const { keys } = await stack.db.listBansosKeysByUser(user.id, {});
    await stack.db.revokeBansosKey(keys[0].id, user.id);

    const { response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` },
      body: chatBody(),
    });

    expect(response.status).toBe(401);
    expect(executorState.calls).toHaveLength(0);
  });

  it("rejects a valid key whose owning user was disabled with 403 and never dispatches", async () => {
    const stack = await loadStack();
    const { user, plaintext } = await seedBansosUser(stack);
    await stack.db.updateBansosUser(user.id, { isActive: false });

    const { response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` },
      body: chatBody(),
    });

    expect(response.status).toBe(403);
    expect(executorState.calls).toHaveLength(0);
  });
});

// ============================================================================
// Endpoint / method / model allowlist
// ============================================================================
describe("Endpoint / method / model allowlist", () => {
  it("404s a disallowed path (/dashboard) on the Bansos host before authentication is ever attempted", async () => {
    const stack = await loadStack();
    const { stage, response } = await dispatch(stack, {
      pathname: "/dashboard", method: "GET", headers: { host: BANSOS_HOST }, body: null,
    });
    expect(stage).toBe("guard");
    expect(response.status).toBe(404);
  });

  it("404s the wrong method for /v1/chat/completions (GET instead of POST)", async () => {
    const stack = await loadStack();
    const { response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "GET", headers: { host: BANSOS_HOST }, body: null,
    });
    expect(response.status).toBe(404);
  });

  it("rejects a non-public model name with 400 once past auth, and never dispatches", async () => {
    const stack = await loadStack();
    const { plaintext } = await seedBansosUser(stack);

    const { stage, response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` },
      body: chatBody({ model: "gpt-4o" }),
    });

    expect(stage).toBe("chat");
    expect(response.status).toBe(400);
    expect(executorState.calls).toHaveLength(0);
  });

  it("dispatches gcli/grok-4.5 to the executor for a well-formed, allowed request — never the public model name", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { plaintext } = await seedBansosUser(stack);
    executorState.next.push({ response: jsonSuccessResponse() });

    const { response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` },
      body: chatBody(),
    });

    expect(response.status).toBe(200);
    expect(executorState.calls).toHaveLength(1);
    expect(executorState.calls[0].model).toBe("grok-4.5");
    expect(JSON.stringify(executorState.calls[0].body)).not.toContain("bansos");
  });
});

// ============================================================================
// Forged / spoofed host and header combinations
// ============================================================================
describe("Forged Host and forwarded-identity combinations", () => {
  it("ignores forged Bansos identity headers on a non-Bansos host — the ordinary requireApiKey gate applies instead, never the Bansos branch", async () => {
    const stack = await loadStack();
    await stack.db.updateSettings({ requireApiKey: true });

    const { response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: {
        host: "localhost",
        "x-9r-bansos-user-id": "forged-user",
        "x-9r-bansos-key-id": "forged-key",
      },
      body: chatBody({ model: "gcli/grok-4.5" }),
    });

    // Rejected for the ordinary reason (missing API key), not because the
    // forged Bansos headers were honored.
    expect(response.status).toBe(401);
    const body = await jsonOf(response);
    expect(body?.error?.message).toBe("Missing API key");
    expect(body?.error?.code).not.toMatch(/bansos/i);
    expect(executorState.calls).toHaveLength(0);
  });

  it("treats a Bansos-shaped Host arriving with an X-Forwarded-Host-style header the same — isBansosHost only ever consults the Host header itself", async () => {
    const stack = await loadStack();
    const { response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST, "x-forwarded-host": "router.example.com" },
      body: chatBody(),
    });
    // No Authorization header -> still the Bansos 401, proving the Bansos
    // branch (not the ordinary ...-forwarded-host-trusting branch) is the
    // one that ran.
    expect(response.status).toBe(401);
  });
});

// ============================================================================
// Rate + concurrency limits
// ============================================================================
describe("Per-user rate + concurrency limits (shared across keys)", () => {
  it("accepts the first 10 requests within a 10 RPM budget and rejects the 11th with 429 + Retry-After", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { plaintext } = await seedBansosUser(stack, { requestsPerMinute: 10, maxConcurrentRequests: 10 });

    for (let i = 0; i < 10; i++) {
      executorState.next.push({ response: jsonSuccessResponse() });
      const { response } = await dispatch(stack, {
        pathname: "/v1/chat/completions", method: "POST",
        headers: { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` },
        body: chatBody(),
      });
      expect(response.status).toBe(200);
    }

    const { stage, response: eleventh } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` },
      body: chatBody(),
    });

    expect(stage).toBe("chat");
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("Retry-After")).toBeTruthy();
    expect(executorState.calls).toHaveLength(10); // the 11th never reached the executor
  });

  it("rejects the 3rd concurrent request when maxConcurrentRequests is 2, and a 4th succeeds once a slot is released", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { plaintext } = await seedBansosUser(stack, { requestsPerMinute: 20, maxConcurrentRequests: 2 });
    const headers = { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` };

    // Two in-flight streaming requests that never terminate on their own —
    // the test controls their lifecycle explicitly via response.body.cancel().
    executorState.next.push({ response: neverEndingStreamResponse(), responseFormat: "openai" });
    const first = await dispatch(stack, { pathname: "/v1/chat/completions", headers, body: chatBody({ stream: true }) });
    expect(first.response.status).toBe(200);

    executorState.next.push({ response: neverEndingStreamResponse(), responseFormat: "openai" });
    const second = await dispatch(stack, { pathname: "/v1/chat/completions", headers, body: chatBody({ stream: true }) });
    expect(second.response.status).toBe(200);

    const third = await dispatch(stack, { pathname: "/v1/chat/completions", headers, body: chatBody() });
    expect(third.response.status).toBe(429);
    const thirdBody = await jsonOf(third.response);
    expect(thirdBody.error.code).toBe("concurrency_limit_exceeded");

    // Free one slot by cancelling the first in-flight stream (client
    // disconnect), then confirm a new request now succeeds.
    await first.response.body.cancel("test_cleanup");
    await new Promise((r) => setTimeout(r, 20));

    executorState.next.push({ response: jsonSuccessResponse() });
    const fourth = await dispatch(stack, { pathname: "/v1/chat/completions", headers, body: chatBody() });
    expect(fourth.response.status).toBe(200);

    await second.response.body.cancel("test_cleanup");
  });
});

// ============================================================================
// Lease release across the full streaming lifecycle
// ============================================================================
describe("Lease release across success / error / stream-completion / disconnect / mid-stream error", () => {
  // Reads the real production rate/concurrency-limiter singleton's
  // in-memory state directly (src/lib/bansos/rateLimiter.js's
  // getBansosLimiterSnapshot) rather than dispatching a fresh probe
  // request. A probe-request approach is tempting but confounded for the
  // provider-error scenario below: chat.js's account-fallback loop
  // (markAccountUnavailable) locks the *account* (not the lease) for
  // BANSOS_LIMITS-independent seconds after a provider error, so a probe
  // sent immediately afterward can be rejected by that unrelated lockout
  // even though the concurrency lease itself was correctly released —
  // asserting on the limiter's own bookkeeping is the precise, real,
  // production-code proof this test needs.
  async function activeLeaseCount(stack, userId) {
    const snapshot = stack.rateLimiter.getBansosLimiterSnapshot();
    return snapshot.users[userId]?.activeLeases ?? 0;
  }

  it("releases after a non-streaming success (handleForcedSSEToJson)", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { user, plaintext } = await seedBansosUser(stack, { requestsPerMinute: 20, maxConcurrentRequests: 1 });
    const headers = { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` };

    executorState.next.push({ response: jsonSuccessResponse() });
    const first = await dispatch(stack, { pathname: "/v1/chat/completions", headers, body: chatBody() });
    expect(first.response.status).toBe(200);

    // Real OpenAI chat-completion shape, not just a 200 — this is the
    // handleForcedSSEToJson output (open-sse/handlers/chatCore/
    // sseToJsonHandler.js): the client asked for stream:false, grok-cli
    // force-streamed a genuine Responses-API SSE sequence regardless (see
    // jsonSuccessResponse()'s doc comment), and this converts+translates
    // that back into a standard Chat Completions body before it ever
    // reaches the client.
    const body = await jsonOf(first.response);
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Hello from the Bansos mock executor.");

    expect(await activeLeaseCount(stack, user.id)).toBe(0);
  });

  it("releases after a terminal provider error (fallback exhausted — no other account to retry under the same lease)", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { user, plaintext } = await seedBansosUser(stack, { requestsPerMinute: 20, maxConcurrentRequests: 1 });
    const headers = { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` };

    executorState.next.push({ response: providerErrorResponse({ status: 429 }) });
    const first = await dispatch(stack, { pathname: "/v1/chat/completions", headers, body: chatBody() });
    expect(first.response.status).toBe(429);

    expect(await activeLeaseCount(stack, user.id)).toBe(0);
  });

  it("releases after a real streaming success — the client observes a genuine data: [DONE] sentinel", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { user, plaintext } = await seedBansosUser(stack, { requestsPerMinute: 20, maxConcurrentRequests: 1 });
    const headers = { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` };

    executorState.next.push({ response: streamSuccessResponse(), responseFormat: "openai" });
    const first = await dispatch(stack, { pathname: "/v1/chat/completions", headers, body: chatBody({ stream: true }) });
    expect(first.response.status).toBe(200);

    const sseText = await first.response.text();
    expect(sseText).toContain("data: [DONE]");
    expect(sseText).toContain("Hello from the Bansos mock executor.");

    expect(await activeLeaseCount(stack, user.id)).toBe(0);
  });

  it("releases after a mid-stream upstream error", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { user, plaintext } = await seedBansosUser(stack, { requestsPerMinute: 20, maxConcurrentRequests: 1 });
    const headers = { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` };

    executorState.next.push({ response: midStreamErrorResponse(), responseFormat: "openai" });
    const first = await dispatch(stack, { pathname: "/v1/chat/completions", headers, body: chatBody({ stream: true }) });
    expect(first.response.status).toBe(200); // the SSE Response itself starts fine — the error is mid-stream

    await first.response.text().catch(() => {}); // drain to the propagated stream error

    expect(await activeLeaseCount(stack, user.id)).toBe(0);
  });

  it("releases after a client disconnect (stream .cancel())", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { user, plaintext } = await seedBansosUser(stack, { requestsPerMinute: 20, maxConcurrentRequests: 1 });
    const headers = { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` };

    executorState.next.push({ response: neverEndingStreamResponse(), responseFormat: "openai" });
    const first = await dispatch(stack, { pathname: "/v1/chat/completions", headers, body: chatBody({ stream: true }) });
    expect(first.response.status).toBe(200);

    await first.response.body.cancel("client_closed");
    await new Promise((r) => setTimeout(r, 20));

    expect(await activeLeaseCount(stack, user.id)).toBe(0);
  });
});

// ============================================================================
// Usage attribution
// ============================================================================
describe("Usage attribution — one row per success, matching totals, none for rejections", () => {
  it("writes exactly one attributed usageHistory row for a successful request, counted in the cross-user Bansos totals", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { user, plaintext } = await seedBansosUser(stack);
    executorState.next.push({ response: jsonSuccessResponse() });

    const { response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` },
      body: chatBody(),
    });
    expect(response.status).toBe(200);

    const breakdown = await waitFor(async () => {
      const b = await stack.db.getBansosUsageBreakdown(user.id);
      return b.totalRequests > 0 ? b : null;
    });
    expect(breakdown.totalRequests).toBe(1);

    const totals = await stack.db.getBansosUsageTotalsAcrossUsers();
    expect(totals.totalRequests).toBe(1);
  });

  it("writes no usage row at all for a rate-limit-rejected request", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { plaintext } = await seedBansosUser(stack, { requestsPerMinute: 1, maxConcurrentRequests: 5 });
    const headers = { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` };

    executorState.next.push({ response: jsonSuccessResponse() });
    await dispatch(stack, { pathname: "/v1/chat/completions", headers, body: chatBody() });

    const rejected = await dispatch(stack, { pathname: "/v1/chat/completions", headers, body: chatBody() });
    expect(rejected.response.status).toBe(429);

    await new Promise((r) => setTimeout(r, 30)); // let the accepted request's fire-and-forget write land
    const totals = await stack.db.getBansosUsageTotalsAcrossUsers();
    expect(totals.totalRequests).toBe(1); // only the first, accepted request
  });
});

// ============================================================================
// Prompt audit: redaction, no response content, expiry, idempotent erasure
// ============================================================================
describe("Prompt audit — redaction, response-content absence, expiry cleanup, idempotent erasure", () => {
  it("persists a redacted prompt for a real request, with no response-content field anywhere on the row", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { user, plaintext } = await seedBansosUser(stack);
    executorState.next.push({ response: jsonSuccessResponse() });

    const secretMessage = { role: "user", content: "my api_key is sk-super-secret-value-123456" };
    await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` },
      body: chatBody({ messages: [secretMessage] }),
    });

    const audits = await waitFor(async () => {
      const { audits } = await stack.db.listBansosPromptAudits({ userId: user.id });
      return audits.length > 0 ? audits : null;
    });

    expect(audits).toHaveLength(1);
    const row = audits[0];
    // bansosPromptAudit's schema has no response-content column at all
    // (see src/lib/db/repos/bansosRepo.js's rowToAudit) — the strongest form
    // of "never includes responses" is that there is nowhere to put one.
    expect(row).not.toHaveProperty("response");
    expect(row.prompt).toBeTruthy();
    expect(row.prompt).not.toContain("sk-super-secret-value-123456");
  });

  it("nulls an expired prompt via the real retention sweep, and a second sweep is a no-op (idempotent)", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { user, plaintext } = await seedBansosUser(stack);
    executorState.next.push({ response: jsonSuccessResponse() });

    await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` },
      body: chatBody(),
    });

    await waitFor(async () => {
      const { audits } = await stack.db.listBansosPromptAudits({ userId: user.id });
      return audits.length > 0 ? audits : null;
    });

    const farFuture = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();
    const firstSweepChanged = await stack.retention.runBansosPromptCleanup(farFuture);
    expect(firstSweepChanged).toBeGreaterThanOrEqual(1);

    const { audits: afterFirst } = await stack.db.listBansosPromptAudits({ userId: user.id });
    expect(afterFirst[0].prompt).toBeNull();

    const secondSweepChanged = await stack.retention.runBansosPromptCleanup(farFuture);
    expect(secondSweepChanged).toBe(0); // idempotent: nothing left to null
  });

  it("erasing an already-erased prompt (real repo call) is idempotent — true then false, never throws", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { user, plaintext } = await seedBansosUser(stack);
    executorState.next.push({ response: jsonSuccessResponse() });

    await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` },
      body: chatBody(),
    });

    const [audit] = await waitFor(async () => {
      const { audits } = await stack.db.listBansosPromptAudits({ userId: user.id });
      return audits.length > 0 ? audits : null;
    });

    await expect(stack.db.eraseBansosPrompt(audit.requestId)).resolves.toBe(true);
    await expect(stack.db.eraseBansosPrompt(audit.requestId)).resolves.toBe(false);
  });
});

// ============================================================================
// Kill switch
// ============================================================================
describe("Kill switch — blocks public traffic while local chat is unaffected", () => {
  it("returns 503 for a Bansos request when the kill switch is off, without ever reaching the executor", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    const { plaintext } = await seedBansosUser(stack);
    await stack.db.updateSettings({ bansosGatewayEnabled: false });

    const { response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      headers: { host: BANSOS_HOST, authorization: `Bearer ${plaintext}` },
      body: chatBody(),
    });

    expect(response.status).toBe(503);
    expect(executorState.calls).toHaveLength(0);
  });

  it("leaves an ordinary local chat request unaffected by the same kill switch setting", async () => {
    const stack = await loadStack();
    await seedGrokCliConnection(stack.db);
    await stack.db.updateSettings({ bansosGatewayEnabled: false, requireApiKey: false });

    executorState.next.push({ response: jsonSuccessResponse() });
    const { response } = await dispatch(stack, {
      pathname: "/v1/chat/completions", method: "POST",
      // Loopback Host + no forwarding headers -> isLocalRequest() is true,
      // so canAccessPublicLlmApi() short-circuits before any key check.
      headers: { host: "localhost" },
      body: chatBody({ model: "gcli/grok-4.5" }),
    });

    expect(response.status).toBe(200);
    expect(executorState.calls).toHaveLength(1);
  });
});
