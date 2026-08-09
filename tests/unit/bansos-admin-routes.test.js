// Bansos Gateway local-only admin/observability REST API routes (Task 12).
//
// These routes are pure composition over already-tested repo/service
// functions (bansosRepo.js, keyService.js, rateLimiter.js, settingsRepo.js,
// connectionsRepo.js) — this suite mocks all of those at module scope and
// asserts the route layer's own job: shaping responses, mapping known
// not-found/validation cases to 404/400, enforcing the settings allowlist,
// and never leaking keyHash/plaintext outside their one allowed spot.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createBansosUser: vi.fn(),
  listBansosUsers: vi.fn(),
  getBansosUserById: vi.fn(),
  updateBansosUser: vi.fn(),
  deleteBansosUser: vi.fn(),
  listBansosKeysByUser: vi.fn(),
  revokeBansosKey: vi.fn(),
  listBansosPromptAudits: vi.fn(),
  eraseBansosPrompt: vi.fn(),
  getBansosUsageTotalsAcrossUsers: vi.fn(),
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  createBansosKey: vi.fn(),
  rotateBansosKey: vi.fn(),
  getBansosLimiterSnapshot: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  createBansosUser: mocks.createBansosUser,
  listBansosUsers: mocks.listBansosUsers,
  getBansosUserById: mocks.getBansosUserById,
  updateBansosUser: mocks.updateBansosUser,
  deleteBansosUser: mocks.deleteBansosUser,
  listBansosKeysByUser: mocks.listBansosKeysByUser,
  revokeBansosKey: mocks.revokeBansosKey,
  listBansosPromptAudits: mocks.listBansosPromptAudits,
  eraseBansosPrompt: mocks.eraseBansosPrompt,
  getBansosUsageTotalsAcrossUsers: mocks.getBansosUsageTotalsAcrossUsers,
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("@/lib/bansos/keyService.js", () => ({
  createBansosKey: mocks.createBansosKey,
  rotateBansosKey: mocks.rotateBansosKey,
}));

vi.mock("@/lib/bansos/rateLimiter.js", () => ({
  getBansosLimiterSnapshot: mocks.getBansosLimiterSnapshot,
}));

const { GET: usersGET, POST: usersPOST } = await import("../../src/app/api/bansos/users/route.js");
const { GET: userGET, PATCH: userPATCH, DELETE: userDELETE } = await import("../../src/app/api/bansos/users/[id]/route.js");
const { GET: userKeysGET, POST: userKeysPOST } = await import("../../src/app/api/bansos/users/[id]/keys/route.js");
const { DELETE: keyDELETE, POST: keyPOST } = await import("../../src/app/api/bansos/keys/[id]/route.js");
const { GET: settingsGET, PATCH: settingsPATCH } = await import("../../src/app/api/bansos/settings/route.js");
const { GET: overviewGET } = await import("../../src/app/api/bansos/overview/route.js");
const { GET: requestsGET } = await import("../../src/app/api/bansos/requests/route.js");
const { DELETE: promptDELETE } = await import("../../src/app/api/bansos/requests/[requestId]/prompt/route.js");

function jsonRequest(url, method, body) {
  return new Request(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function params(obj) {
  return { params: Promise.resolve(obj) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Users ──────────────────────────────────────────────────────────────

describe("GET /api/bansos/users", () => {
  it("lists users with pagination passthrough", async () => {
    mocks.listBansosUsers.mockResolvedValue({
      users: [{ id: "usr_1", name: "Dinsos Jakarta" }],
      pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1, hasNext: false, hasPrev: false },
    });

    const response = await usersGET(new Request("https://local/api/bansos/users?page=2&pageSize=5"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.users).toEqual([{ id: "usr_1", name: "Dinsos Jakarta" }]);
    expect(body.pagination.totalItems).toBe(1);
    expect(mocks.listBansosUsers).toHaveBeenCalledWith({ page: 2, pageSize: 5 });
  });
});

describe("POST /api/bansos/users", () => {
  it("rejects a missing name with 400", async () => {
    const response = await usersPOST(jsonRequest("https://local/api/bansos/users", "POST", {}));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBeTruthy();
    expect(mocks.createBansosUser).not.toHaveBeenCalled();
  });

  it("rejects requestsPerMinute below 1", async () => {
    mocks.getSettings.mockResolvedValue({});
    const response = await usersPOST(jsonRequest("https://local/api/bansos/users", "POST", {
      name: "Dinsos Bandung",
      requestsPerMinute: 0,
    }));
    expect(response.status).toBe(400);
    expect(mocks.createBansosUser).not.toHaveBeenCalled();
  });

  it("rejects a non-integer requestsPerMinute", async () => {
    mocks.getSettings.mockResolvedValue({});
    const response = await usersPOST(jsonRequest("https://local/api/bansos/users", "POST", {
      name: "Dinsos Bandung",
      requestsPerMinute: 2.5,
    }));
    expect(response.status).toBe(400);
  });

  it("rejects maxConcurrentRequests below 1", async () => {
    mocks.getSettings.mockResolvedValue({});
    const response = await usersPOST(jsonRequest("https://local/api/bansos/users", "POST", {
      name: "Dinsos Bandung",
      maxConcurrentRequests: 0,
    }));
    expect(response.status).toBe(400);
    expect(mocks.createBansosUser).not.toHaveBeenCalled();
  });

  it("creates a user with explicit limits, bypassing settings defaults", async () => {
    mocks.getSettings.mockResolvedValue({ bansosDefaultRequestsPerMinute: 99, bansosDefaultMaxConcurrentRequests: 99 });
    mocks.createBansosUser.mockResolvedValue({ id: "usr_new", name: "Dinsos Surabaya", requestsPerMinute: 5, maxConcurrentRequests: 3, isActive: true });

    const response = await usersPOST(jsonRequest("https://local/api/bansos/users", "POST", {
      name: "Dinsos Surabaya",
      requestsPerMinute: 5,
      maxConcurrentRequests: 3,
    }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.user.id).toBe("usr_new");
    expect(mocks.createBansosUser).toHaveBeenCalledWith(expect.objectContaining({
      name: "Dinsos Surabaya",
      requestsPerMinute: 5,
      maxConcurrentRequests: 3,
    }));
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });

  it("falls back to configured settings defaults when limits are omitted", async () => {
    mocks.getSettings.mockResolvedValue({ bansosDefaultRequestsPerMinute: 15, bansosDefaultMaxConcurrentRequests: 4 });
    mocks.createBansosUser.mockResolvedValue({ id: "usr_new2", name: "Dinsos Medan" });

    const response = await usersPOST(jsonRequest("https://local/api/bansos/users", "POST", { name: "Dinsos Medan" }));

    expect(response.status).toBe(201);
    expect(mocks.createBansosUser).toHaveBeenCalledWith(expect.objectContaining({
      name: "Dinsos Medan",
      requestsPerMinute: 15,
      maxConcurrentRequests: 4,
    }));
  });

  it("passes undefined limits through to the repo default-of-last-resort when neither body nor settings specify them", async () => {
    mocks.getSettings.mockResolvedValue({});
    mocks.createBansosUser.mockResolvedValue({ id: "usr_new3", name: "Dinsos Padang" });

    const response = await usersPOST(jsonRequest("https://local/api/bansos/users", "POST", { name: "Dinsos Padang" }));

    expect(response.status).toBe(201);
    const call = mocks.createBansosUser.mock.calls[0][0];
    expect(call.requestsPerMinute).toBeUndefined();
    expect(call.maxConcurrentRequests).toBeUndefined();
  });

  it("maps an unexpected repo throw to 500", async () => {
    mocks.getSettings.mockResolvedValue({});
    mocks.createBansosUser.mockRejectedValue(new Error("boom"));

    const response = await usersPOST(jsonRequest("https://local/api/bansos/users", "POST", { name: "Dinsos Aceh" }));
    expect(response.status).toBe(500);
  });
});

// ── Single user ────────────────────────────────────────────────────────

describe("GET /api/bansos/users/[id]", () => {
  it("returns 404 for an unknown opaque id", async () => {
    mocks.getBansosUserById.mockResolvedValue(null);
    const response = await userGET(new Request("https://local/api/bansos/users/usr_unknown"), params({ id: "usr_unknown" }));
    expect(response.status).toBe(404);
  });

  it("returns the user for a known opaque id", async () => {
    mocks.getBansosUserById.mockResolvedValue({ id: "usr_1", name: "Dinsos Jakarta" });
    const response = await userGET(new Request("https://local/api/bansos/users/usr_1"), params({ id: "usr_1" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.id).toBe("usr_1");
    expect(mocks.getBansosUserById).toHaveBeenCalledWith("usr_1");
  });
});

describe("PATCH /api/bansos/users/[id]", () => {
  it("returns 404 when updating an unknown user", async () => {
    mocks.updateBansosUser.mockResolvedValue(null);
    const response = await userPATCH(jsonRequest("https://local/api/bansos/users/usr_x", "PATCH", { name: "New" }), params({ id: "usr_x" }));
    expect(response.status).toBe(404);
  });

  it("rejects requestsPerMinute below 1", async () => {
    const response = await userPATCH(jsonRequest("https://local/api/bansos/users/usr_1", "PATCH", { requestsPerMinute: 0 }), params({ id: "usr_1" }));
    expect(response.status).toBe(400);
    expect(mocks.updateBansosUser).not.toHaveBeenCalled();
  });

  it("rejects maxConcurrentRequests below 1", async () => {
    const response = await userPATCH(jsonRequest("https://local/api/bansos/users/usr_1", "PATCH", { maxConcurrentRequests: -1 }), params({ id: "usr_1" }));
    expect(response.status).toBe(400);
    expect(mocks.updateBansosUser).not.toHaveBeenCalled();
  });

  it("rejects an empty name", async () => {
    const response = await userPATCH(jsonRequest("https://local/api/bansos/users/usr_1", "PATCH", { name: "   " }), params({ id: "usr_1" }));
    expect(response.status).toBe(400);
  });

  it("updates activation, name, RPM, and concurrency together", async () => {
    mocks.updateBansosUser.mockResolvedValue({ id: "usr_1", name: "Renamed", requestsPerMinute: 20, maxConcurrentRequests: 5, isActive: false });

    const response = await userPATCH(jsonRequest("https://local/api/bansos/users/usr_1", "PATCH", {
      name: "Renamed",
      requestsPerMinute: 20,
      maxConcurrentRequests: 5,
      isActive: false,
    }), params({ id: "usr_1" }));

    expect(response.status).toBe(200);
    expect(mocks.updateBansosUser).toHaveBeenCalledWith("usr_1", {
      name: "Renamed",
      requestsPerMinute: 20,
      maxConcurrentRequests: 5,
      isActive: false,
    });
    const body = await response.json();
    expect(body.user.isActive).toBe(false);
  });
});

describe("DELETE /api/bansos/users/[id]", () => {
  function deleteRequest(id) {
    return new Request(`https://local/api/bansos/users/${id}`, { method: "DELETE" });
  }

  it("returns 404 when deleting an unknown user", async () => {
    mocks.deleteBansosUser.mockResolvedValue(null);
    const response = await userDELETE(deleteRequest("usr_x"), params({ id: "usr_x" }));
    expect(response.status).toBe(404);
  });

  it("deletes the user and reports how many keys went with it", async () => {
    mocks.deleteBansosUser.mockResolvedValue({
      user: { id: "usr_1", name: "Dinsos Test", isActive: true },
      deletedKeyCount: 2,
    });

    const response = await userDELETE(deleteRequest("usr_1"), params({ id: "usr_1" }));

    expect(response.status).toBe(200);
    expect(mocks.deleteBansosUser).toHaveBeenCalledWith("usr_1");
    const body = await response.json();
    expect(body.user.id).toBe("usr_1");
    expect(body.deletedKeyCount).toBe(2);
  });

  it("does not fall back to deactivation — DELETE never calls updateBansosUser", async () => {
    mocks.deleteBansosUser.mockResolvedValue({ user: { id: "usr_1" }, deletedKeyCount: 0 });
    await userDELETE(deleteRequest("usr_1"), params({ id: "usr_1" }));
    expect(mocks.updateBansosUser).not.toHaveBeenCalled();
  });
});

// ── Keys under a user ──────────────────────────────────────────────────

describe("GET /api/bansos/users/[id]/keys", () => {
  it("returns 404 when the owning user doesn't exist", async () => {
    mocks.getBansosUserById.mockResolvedValue(null);
    const response = await userKeysGET(new Request("https://local/api/bansos/users/usr_x/keys"), params({ id: "usr_x" }));
    expect(response.status).toBe(404);
    expect(mocks.listBansosKeysByUser).not.toHaveBeenCalled();
  });

  it("lists keys for an existing user, with pagination passthrough, and no hash leakage", async () => {
    mocks.getBansosUserById.mockResolvedValue({ id: "usr_1" });
    mocks.listBansosKeysByUser.mockResolvedValue({
      keys: [{ id: "key_1", userId: "usr_1", name: "prod", keyPrefix: "bns_ab12...ef34" }],
      pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1, hasNext: false, hasPrev: false },
    });

    const response = await userKeysGET(new Request("https://local/api/bansos/users/usr_1/keys?page=1&pageSize=10"), params({ id: "usr_1" }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.keys[0]).not.toHaveProperty("keyHash");
    expect(mocks.listBansosKeysByUser).toHaveBeenCalledWith("usr_1", { page: 1, pageSize: 10 });
  });
});

describe("POST /api/bansos/users/[id]/keys", () => {
  it("returns 404 when the owning user doesn't exist", async () => {
    mocks.getBansosUserById.mockResolvedValue(null);
    const response = await userKeysPOST(jsonRequest("https://local/api/bansos/users/usr_x/keys", "POST", { name: "prod" }), params({ id: "usr_x" }));
    expect(response.status).toBe(404);
    expect(mocks.createBansosKey).not.toHaveBeenCalled();
  });

  it("rejects a missing key name with 400", async () => {
    mocks.getBansosUserById.mockResolvedValue({ id: "usr_1" });
    const response = await userKeysPOST(jsonRequest("https://local/api/bansos/users/usr_1/keys", "POST", {}), params({ id: "usr_1" }));
    expect(response.status).toBe(400);
    expect(mocks.createBansosKey).not.toHaveBeenCalled();
  });

  it("creates a key and returns plaintext exactly once, with no keyHash leakage", async () => {
    mocks.getBansosUserById.mockResolvedValue({ id: "usr_1" });
    mocks.createBansosKey.mockResolvedValue({
      id: "key_new", userId: "usr_1", name: "prod", keyPrefix: "bns_ab12...ef34",
      isActive: true, plaintext: "bns_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      keyHash: "deadbeef",
    });

    const response = await userKeysPOST(jsonRequest("https://local/api/bansos/users/usr_1/keys", "POST", { name: "prod" }), params({ id: "usr_1" }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.key.plaintext).toBe("bns_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(body.key).not.toHaveProperty("keyHash");
    expect(mocks.createBansosKey).toHaveBeenCalledWith({ userId: "usr_1", name: "prod" });
  });
});

// ── Key by id: revoke / rotate ───────────────────────────────────────────

describe("DELETE /api/bansos/keys/[id] (revoke)", () => {
  it("requires userId with 400 when missing", async () => {
    const response = await keyDELETE(new Request("https://local/api/bansos/keys/key_1", { method: "DELETE" }), params({ id: "key_1" }));
    expect(response.status).toBe(400);
    expect(mocks.revokeBansosKey).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown or unowned key id", async () => {
    mocks.revokeBansosKey.mockResolvedValue(null);
    const response = await keyDELETE(new Request("https://local/api/bansos/keys/key_x?userId=usr_1", { method: "DELETE" }), params({ id: "key_x" }));
    expect(response.status).toBe(404);
  });

  it("revokes an active key and returns it without a keyHash", async () => {
    mocks.revokeBansosKey.mockResolvedValue({ id: "key_1", userId: "usr_1", isActive: false, revokedAt: "2026-08-07T00:00:00.000Z" });
    const response = await keyDELETE(new Request("https://local/api/bansos/keys/key_1?userId=usr_1", { method: "DELETE" }), params({ id: "key_1" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.key.revokedAt).toBeTruthy();
    expect(body.key).not.toHaveProperty("keyHash");
    expect(mocks.revokeBansosKey).toHaveBeenCalledWith("key_1", "usr_1");
  });

  it("is idempotent: revoking an already-revoked key still returns 200 with the unchanged row", async () => {
    mocks.revokeBansosKey.mockResolvedValue({ id: "key_1", userId: "usr_1", isActive: false, revokedAt: "2026-08-01T00:00:00.000Z" });
    const response = await keyDELETE(new Request("https://local/api/bansos/keys/key_1?userId=usr_1", { method: "DELETE" }), params({ id: "key_1" }));
    expect(response.status).toBe(200);
  });
});

describe("POST /api/bansos/keys/[id] (rotate)", () => {
  it("requires userId with 400 when missing", async () => {
    const response = await keyPOST(jsonRequest("https://local/api/bansos/keys/key_1", "POST", {}), params({ id: "key_1" }));
    expect(response.status).toBe(400);
    expect(mocks.rotateBansosKey).not.toHaveBeenCalled();
  });

  it("maps the service's not-found throw to 404 (not 500)", async () => {
    mocks.rotateBansosKey.mockRejectedValue(new Error("Bansos key not found for this user"));
    const response = await keyPOST(jsonRequest("https://local/api/bansos/keys/key_x", "POST", { userId: "usr_1" }), params({ id: "key_x" }));
    expect(response.status).toBe(404);
  });

  it("propagates a genuinely unexpected throw as 500, distinct from the not-found case", async () => {
    mocks.rotateBansosKey.mockRejectedValue(new Error("database is on fire"));
    const response = await keyPOST(jsonRequest("https://local/api/bansos/keys/key_1", "POST", { userId: "usr_1" }), params({ id: "key_1" }));
    expect(response.status).toBe(500);
  });

  it("rotates a key and returns the new plaintext without a keyHash", async () => {
    mocks.rotateBansosKey.mockResolvedValue({
      id: "key_new", userId: "usr_1", name: "prod", keyPrefix: "bns_cd34...gh56",
      plaintext: "bns_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      keyHash: "cafebabe",
    });

    const response = await keyPOST(jsonRequest("https://local/api/bansos/keys/key_1", "POST", { userId: "usr_1", name: "prod-2" }), params({ id: "key_1" }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.key.plaintext).toBe("bns_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(body.key).not.toHaveProperty("keyHash");
    expect(mocks.rotateBansosKey).toHaveBeenCalledWith({ keyId: "key_1", userId: "usr_1", name: "prod-2" });
  });
});

// ── Settings ───────────────────────────────────────────────────────────

describe("GET /api/bansos/settings", () => {
  it("returns read-only hostname/model/retention constants alongside mutable settings", async () => {
    mocks.getSettings.mockResolvedValue({ bansosGatewayEnabled: true, bansosDefaultRequestsPerMinute: 12 });

    const response = await settingsGET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hostname).toBe("api.priaoslo.web.id");
    expect(body.publicModel).toBe("bansos/grok-4.5");
    expect(typeof body.promptRetentionDays).toBe("number");
    expect(body.gatewayEnabled).toBe(true);
    expect(body.defaultRequestsPerMinute).toBe(12);
  });

  it("reports the kill switch as enabled by default (absence means enabled)", async () => {
    mocks.getSettings.mockResolvedValue({});
    const response = await settingsGET();
    const body = await response.json();
    expect(body.gatewayEnabled).toBe(true);
  });
});

describe("PATCH /api/bansos/settings", () => {
  it("persists the kill switch toggle", async () => {
    mocks.updateSettings.mockResolvedValue({ bansosGatewayEnabled: false });

    const response = await settingsPATCH(jsonRequest("https://local/api/bansos/settings", "PATCH", { bansosGatewayEnabled: false }));

    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ bansosGatewayEnabled: false });
    const body = await response.json();
    expect(body.gatewayEnabled).toBe(false);
  });

  it("ignores fields outside the enable/default-limit allowlist", async () => {
    mocks.updateSettings.mockResolvedValue({ bansosGatewayEnabled: true, bansosDefaultRequestsPerMinute: 30 });

    const response = await settingsPATCH(jsonRequest("https://local/api/bansos/settings", "PATCH", {
      bansosDefaultRequestsPerMinute: 30,
      password: "should-not-pass-through",
      requireLogin: false,
    }));

    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ bansosDefaultRequestsPerMinute: 30 });
  });

  it("rejects a default requestsPerMinute below 1", async () => {
    const response = await settingsPATCH(jsonRequest("https://local/api/bansos/settings", "PATCH", { bansosDefaultRequestsPerMinute: 0 }));
    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects a default maxConcurrentRequests below 1", async () => {
    const response = await settingsPATCH(jsonRequest("https://local/api/bansos/settings", "PATCH", { bansosDefaultMaxConcurrentRequests: 0 }));
    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean gateway-enabled value", async () => {
    const response = await settingsPATCH(jsonRequest("https://local/api/bansos/settings", "PATCH", { bansosGatewayEnabled: "yes" }));
    expect(response.status).toBe(400);
  });

  it("rejects a body with no allowlisted fields at all", async () => {
    const response = await settingsPATCH(jsonRequest("https://local/api/bansos/settings", "PATCH", { foo: "bar" }));
    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});

// ── Overview ───────────────────────────────────────────────────────────

describe("GET /api/bansos/overview", () => {
  function setupOverviewMocks() {
    mocks.listBansosUsers.mockImplementation(async ({ page = 1, pageSize } = {}) => {
      if (pageSize === 1) {
        return { users: [], pagination: { page: 1, pageSize: 1, totalItems: 2, totalPages: 2, hasNext: true, hasPrev: false } };
      }
      return {
        users: [{ id: "usr_1" }, { id: "usr_2" }],
        pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1, hasNext: false, hasPrev: false },
      };
    });
    mocks.listBansosKeysByUser.mockResolvedValue({
      keys: [],
      pagination: { page: 1, pageSize: 1, totalItems: 3, totalPages: 3, hasNext: true, hasPrev: false },
    });
    mocks.listBansosPromptAudits.mockResolvedValue({
      audits: [],
      pagination: { page: 1, pageSize: 1, totalItems: 7, totalPages: 7, hasNext: true, hasPrev: false },
    });
    mocks.getBansosUsageTotalsAcrossUsers.mockResolvedValue({
      totalRequests: 1, totalPromptTokens: 10, totalCompletionTokens: 20, totalCost: 0.01,
    });
    mocks.getProviderConnections.mockResolvedValue([{ id: "conn_1", provider: "grok-cli", isActive: true }]);
    mocks.getBansosLimiterSnapshot.mockReturnValue({ users: { usr_1: { activeLeases: 1, windowRequestCount: 3 } } });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports user/key/request counts, limiter snapshot, today's usage, and Grok CLI presence", async () => {
    setupOverviewMocks();

    const response = await overviewGET(new Request("https://local/api/bansos/overview"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.userCount).toBe(2);
    // setupOverviewMocks's aggregation-page fixture returns 2 users, each
    // with listBansosKeysByUser reporting totalItems: 3 -> 2 * 3 = 6.
    expect(body.keyCount).toBe(6);
    expect(body.requestCount).toBe(7);
    expect(body.todayUsage).toEqual({
      totalRequests: 1, totalPromptTokens: 10, totalCompletionTokens: 20, totalCost: 0.01,
    });
    expect(body.limiterSnapshot.users.usr_1.activeLeases).toBe(1);
    expect(body.grokCliConnected).toBe(true);
    expect(mocks.getProviderConnections).toHaveBeenCalledWith({ provider: "grok-cli", isActive: true });
    // Today's usage must come from exactly one single-pass call across all
    // users, never once per user (the N-rescan bug this fix round closes).
    expect(mocks.getBansosUsageTotalsAcrossUsers).toHaveBeenCalledTimes(1);
  });

  it("pages through multiple aggregation pages of users for keyCount, while still summing usage totals in a single pass", async () => {
    // Simulate 150 Bansos users split across 2 pages of the aggregation
    // loop (AGGREGATE_PAGE_SIZE = 100) — exercises the
    // `pagination.hasNext` -> `page += 1` continuation branch that
    // setupOverviewMocks's single-page (2-user) fixture never reaches.
    mocks.listBansosUsers.mockImplementation(async ({ page = 1, pageSize } = {}) => {
      if (pageSize === 1) {
        return { users: [], pagination: { page: 1, pageSize: 1, totalItems: 150, totalPages: 150, hasNext: true, hasPrev: false } };
      }
      if (page === 1) {
        return {
          users: Array.from({ length: 100 }, (_, i) => ({ id: `usr_${i}` })),
          pagination: { page: 1, pageSize: 100, totalItems: 150, totalPages: 2, hasNext: true, hasPrev: false },
        };
      }
      return {
        users: Array.from({ length: 50 }, (_, i) => ({ id: `usr_${100 + i}` })),
        pagination: { page: 2, pageSize: 100, totalItems: 150, totalPages: 2, hasNext: false, hasPrev: true },
      };
    });
    mocks.listBansosKeysByUser.mockResolvedValue({
      keys: [],
      pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1, hasNext: false, hasPrev: false },
    });
    mocks.listBansosPromptAudits.mockResolvedValue({
      audits: [],
      pagination: { page: 1, pageSize: 1, totalItems: 0, totalPages: 0, hasNext: false, hasPrev: false },
    });
    mocks.getBansosUsageTotalsAcrossUsers.mockResolvedValue({
      totalRequests: 500, totalPromptTokens: 5000, totalCompletionTokens: 2500, totalCost: 1.23,
    });
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getBansosLimiterSnapshot.mockReturnValue({ users: {} });

    const response = await overviewGET(new Request("https://local/api/bansos/overview"));

    expect(response.status).toBe(200);
    const body = await response.json();
    // 150 users, 1 key each (from the mocked pagination.totalItems), summed
    // across both aggregation pages.
    expect(body.keyCount).toBe(150);
    expect(body.todayUsage).toEqual({
      totalRequests: 500, totalPromptTokens: 5000, totalCompletionTokens: 2500, totalCost: 1.23,
    });
    // The N-rescan regression this fix closes: usage totals must come from
    // exactly one call, never one per user (which would be 150 calls here).
    expect(mocks.getBansosUsageTotalsAcrossUsers).toHaveBeenCalledTimes(1);
    expect(mocks.listBansosKeysByUser).toHaveBeenCalledTimes(150);
    // Both aggregation pages of listBansosUsers were actually walked: the
    // pageSize:1 top-level call, plus pageSize:100 pages 1 and 2.
    expect(mocks.listBansosUsers).toHaveBeenCalledWith({ page: 1, pageSize: 100 });
    expect(mocks.listBansosUsers).toHaveBeenCalledWith({ page: 2, pageSize: 100 });
  });

  it("does not probe the public host unless explicitly requested", async () => {
    setupOverviewMocks();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await overviewGET(new Request("https://local/api/bansos/overview"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.publicHost).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes the public host and reports reachable:true on a successful fetch when requested", async () => {
    setupOverviewMocks();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const response = await overviewGET(new Request("https://local/api/bansos/overview?probe=true"));

    const body = await response.json();
    expect(body.publicHost.reachable).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.priaoslo.web.id/v1/models");
  });

  it("treats a 401 from the public host as reachable — the probe is unauthenticated, so 401 is the healthy answer", async () => {
    setupOverviewMocks();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);

    const response = await overviewGET(new Request("https://local/api/bansos/overview?probe=true"));

    const body = await response.json();
    expect(body.publicHost.reachable).toBe(true);
    expect(body.publicHost.status).toBe(401);
  });

  it("reports reachable:false when Cloudflare answers for a down tunnel (530) instead of the gate", async () => {
    setupOverviewMocks();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 530 });
    vi.stubGlobal("fetch", fetchMock);

    const response = await overviewGET(new Request("https://local/api/bansos/overview?probe=true"));

    const body = await response.json();
    expect(body.publicHost.reachable).toBe(false);
    expect(body.publicHost.status).toBe(530);
  });

  it("reports a structured reachable:false on probe failure (timeout/network error) instead of throwing", async () => {
    setupOverviewMocks();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await overviewGET(new Request("https://local/api/bansos/overview?probe=true"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.publicHost.reachable).toBe(false);
  });
});

// ── Requests (prompt audit list) ─────────────────────────────────────────

describe("GET /api/bansos/requests", () => {
  it("passes filters and pagination through to the repo layer", async () => {
    mocks.listBansosPromptAudits.mockResolvedValue({
      audits: [{ requestId: "req_1", userId: "usr_1", status: "success" }],
      pagination: { page: 2, pageSize: 10, totalItems: 1, totalPages: 1, hasNext: false, hasPrev: true },
    });

    const response = await requestsGET(new Request(
      "https://local/api/bansos/requests?userId=usr_1&apiKeyId=key_1&status=success&page=2&pageSize=10"
    ));

    expect(response.status).toBe(200);
    expect(mocks.listBansosPromptAudits).toHaveBeenCalledWith({
      userId: "usr_1", apiKeyId: "key_1", status: "success", page: 2, pageSize: 10,
    });
    const body = await response.json();
    expect(body.audits).toHaveLength(1);
    expect(body.pagination.page).toBe(2);
  });

  it("omits unset filters rather than passing empty strings through", async () => {
    mocks.listBansosPromptAudits.mockResolvedValue({ audits: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0, hasNext: false, hasPrev: false } });

    await requestsGET(new Request("https://local/api/bansos/requests"));

    expect(mocks.listBansosPromptAudits).toHaveBeenCalledWith({});
  });
});

// ── Prompt erasure ───────────────────────────────────────────────────────

describe("DELETE /api/bansos/requests/[requestId]/prompt", () => {
  it("erases the prompt and returns 200 when the row existed with a non-null prompt", async () => {
    mocks.eraseBansosPrompt.mockResolvedValue(true);

    const response = await promptDELETE(new Request("https://local/api/bansos/requests/req_1/prompt", { method: "DELETE" }), params({ requestId: "req_1" }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.erased).toBe(true);
    expect(mocks.eraseBansosPrompt).toHaveBeenCalledWith("req_1");
  });

  it("returns 404 when the repo reports no row was changed (unknown id or already erased)", async () => {
    mocks.eraseBansosPrompt.mockResolvedValue(false);

    const response = await promptDELETE(new Request("https://local/api/bansos/requests/req_x/prompt", { method: "DELETE" }), params({ requestId: "req_x" }));

    expect(response.status).toBe(404);
  });
});
