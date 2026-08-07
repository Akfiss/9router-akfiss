// Bansos Gateway persistence — schema + repository behavior.
// Covers user/key CRUD, ownership-scoped revocation, prompt audit lifecycle
// (insert → finalize → erase / expiry sweep), bounded pagination, and the
// usage-breakdown JOIN-by-meta contract (see bansosRepo.js file header).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bansos-"));
  process.env.DATA_DIR = tempDir;
  // Reset global singleton so each test gets a fresh adapter pointed at tempDir
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

async function loadDb() {
  return await import("@/lib/db/index.js");
}

describe("bansosRepo — schema", () => {
  it("fresh DB contains the bansos tables", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      "bansosUsers", "bansosApiKeys", "bansosPromptAudit",
    ]));
  });
});

describe("bansosRepo — users", () => {
  it("createBansosUser applies defaults", async () => {
    const db = await loadDb();
    const user = await db.createBansosUser({ name: "Alice" });
    expect(user).toMatchObject({
      name: "Alice",
      requestsPerMinute: 10,
      maxConcurrentRequests: 2,
      isActive: true,
    });
    expect(user.id).toBeTruthy();
    expect(user.createdAt).toBeTruthy();
    expect(user.updatedAt).toBeTruthy();
  });

  it("createBansosUser honors explicit overrides", async () => {
    const db = await loadDb();
    const user = await db.createBansosUser({
      name: "Bob", requestsPerMinute: 30, maxConcurrentRequests: 5, isActive: false,
    });
    expect(user.requestsPerMinute).toBe(30);
    expect(user.maxConcurrentRequests).toBe(5);
    expect(user.isActive).toBe(false);
  });

  it("createBansosUser requires a name", async () => {
    const db = await loadDb();
    await expect(db.createBansosUser({})).rejects.toThrow();
  });

  it("getBansosUserById round-trips a created user", async () => {
    const db = await loadDb();
    const created = await db.createBansosUser({ name: "Carol" });
    const fetched = await db.getBansosUserById(created.id);
    expect(fetched).toEqual(created);
  });

  it("getBansosUserById returns null for an unknown id", async () => {
    const db = await loadDb();
    expect(await db.getBansosUserById("does-not-exist")).toBeNull();
  });

  it("updateBansosUser merges fields, preserves the rest, and bumps updatedAt", async () => {
    const db = await loadDb();
    const created = await db.createBansosUser({ name: "Dave" });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await db.updateBansosUser(created.id, { requestsPerMinute: 99, isActive: false });
    expect(updated.name).toBe("Dave"); // untouched field preserved
    expect(updated.requestsPerMinute).toBe(99);
    expect(updated.isActive).toBe(false);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("updateBansosUser returns null for an unknown id", async () => {
    const db = await loadDb();
    expect(await db.updateBansosUser("nope", { name: "x" })).toBeNull();
  });

  it("listBansosUsers paginates deterministically", async () => {
    const db = await loadDb();
    for (let i = 0; i < 5; i++) await db.createBansosUser({ name: `U${i}` });

    const page1 = await db.listBansosUsers({ page: 1, pageSize: 2 });
    expect(page1.users).toHaveLength(2);
    expect(page1.pagination).toMatchObject({
      page: 1, pageSize: 2, totalItems: 5, totalPages: 3, hasNext: true, hasPrev: false,
    });

    const page3 = await db.listBansosUsers({ page: 3, pageSize: 2 });
    expect(page3.users).toHaveLength(1);
    expect(page3.pagination.hasNext).toBe(false);
    expect(page3.pagination.hasPrev).toBe(true);
  });

  it("listBansosUsers clamps pageSize to [1, 100]", async () => {
    const db = await loadDb();
    for (let i = 0; i < 3; i++) await db.createBansosUser({ name: `V${i}` });

    const tooBig = await db.listBansosUsers({ pageSize: 10000 });
    expect(tooBig.pagination.pageSize).toBe(100);

    const tooSmall = await db.listBansosUsers({ pageSize: 0 });
    expect(tooSmall.pagination.pageSize).toBe(1);
  });
});

describe("bansosRepo — API keys", () => {
  it("createBansosKeyRecord persists metadata and never returns keyHash", async () => {
    const db = await loadDb();
    const user = await db.createBansosUser({ name: "KeyOwner" });
    const key = await db.createBansosKeyRecord({
      userId: user.id, name: "primary", keyHash: "hash-abc", keyPrefix: "bansos_ab12",
    });
    expect(key).toMatchObject({
      userId: user.id, name: "primary", keyPrefix: "bansos_ab12", isActive: true,
    });
    expect(key).not.toHaveProperty("keyHash");
    expect(key.revokedAt).toBeNull();
    expect(key.lastUsedAt).toBeNull();
  });

  it("createBansosKeyRecord rejects a duplicate keyHash", async () => {
    const db = await loadDb();
    const user = await db.createBansosUser({ name: "Dup" });
    await db.createBansosKeyRecord({ userId: user.id, name: "k1", keyHash: "same-hash", keyPrefix: "bansos_aa" });
    await expect(
      db.createBansosKeyRecord({ userId: user.id, name: "k2", keyHash: "same-hash", keyPrefix: "bansos_bb" })
    ).rejects.toThrow();
  });

  it("createBansosKeyRecord requires userId, name, keyHash, and keyPrefix", async () => {
    const db = await loadDb();
    await expect(db.createBansosKeyRecord({})).rejects.toThrow();
  });

  it("getBansosKeyByHash finds the owning record without leaking keyHash", async () => {
    const db = await loadDb();
    const user = await db.createBansosUser({ name: "Finder" });
    const created = await db.createBansosKeyRecord({
      userId: user.id, name: "k", keyHash: "find-me", keyPrefix: "bansos_cc",
    });
    const found = await db.getBansosKeyByHash("find-me");
    expect(found).toEqual(created);
    expect(found).not.toHaveProperty("keyHash");
  });

  it("getBansosKeyByHash returns null for an unknown hash", async () => {
    const db = await loadDb();
    expect(await db.getBansosKeyByHash("nope")).toBeNull();
  });

  it("listBansosKeysByUser scopes to the user, paginates, and never leaks keyHash", async () => {
    const db = await loadDb();
    const user = await db.createBansosUser({ name: "Lister" });
    const other = await db.createBansosUser({ name: "Other" });
    for (let i = 0; i < 3; i++) {
      await db.createBansosKeyRecord({ userId: user.id, name: `k${i}`, keyHash: `hash-${i}`, keyPrefix: `bansos_${i}` });
    }
    await db.createBansosKeyRecord({ userId: other.id, name: "other-key", keyHash: "other-hash", keyPrefix: "bansos_zz" });

    const { keys, pagination } = await db.listBansosKeysByUser(user.id, { page: 1, pageSize: 2 });
    expect(pagination.totalItems).toBe(3);
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(k).not.toHaveProperty("keyHash");
      expect(k.userId).toBe(user.id);
    }
  });

  it("revokeBansosKey enforces ownership — a different user cannot revoke", async () => {
    const db = await loadDb();
    const owner = await db.createBansosUser({ name: "Owner" });
    const stranger = await db.createBansosUser({ name: "Stranger" });
    const key = await db.createBansosKeyRecord({ userId: owner.id, name: "k", keyHash: "own-hash", keyPrefix: "bansos_dd" });

    const result = await db.revokeBansosKey(key.id, stranger.id);
    expect(result).toBeNull();

    const stillActive = await db.getBansosKeyByHash("own-hash");
    expect(stillActive.isActive).toBe(true);
    expect(stillActive.revokedAt).toBeNull();
  });

  it("revokeBansosKey revokes when the owner matches, and is idempotent", async () => {
    const db = await loadDb();
    const owner = await db.createBansosUser({ name: "Owner2" });
    const key = await db.createBansosKeyRecord({ userId: owner.id, name: "k", keyHash: "own-hash-2", keyPrefix: "bansos_ee" });

    const revoked = await db.revokeBansosKey(key.id, owner.id);
    expect(revoked.isActive).toBe(false);
    expect(revoked.revokedAt).toBeTruthy();

    const revokedAgain = await db.revokeBansosKey(key.id, owner.id);
    expect(revokedAgain.revokedAt).toBe(revoked.revokedAt); // unchanged on second call
  });

  it("revokeBansosKey returns null for an unknown key id", async () => {
    const db = await loadDb();
    const owner = await db.createBansosUser({ name: "Owner3" });
    expect(await db.revokeBansosKey("nope", owner.id)).toBeNull();
  });

  it("touchBansosKeyLastUsed updates lastUsedAt and reports false for an unknown id", async () => {
    const db = await loadDb();
    const owner = await db.createBansosUser({ name: "Toucher" });
    const key = await db.createBansosKeyRecord({ userId: owner.id, name: "k", keyHash: "touch-hash", keyPrefix: "bansos_ff" });

    const ok = await db.touchBansosKeyLastUsed(key.id, "2026-01-01T00:00:00.000Z");
    expect(ok).toBe(true);
    const { keys } = await db.listBansosKeysByUser(owner.id);
    expect(keys[0].lastUsedAt).toBe("2026-01-01T00:00:00.000Z");

    const missing = await db.touchBansosKeyLastUsed("nope");
    expect(missing).toBe(false);
  });
});

describe("bansosRepo — prompt audit", () => {
  function baseAudit(overrides = {}) {
    return {
      requestId: `req-${Math.random().toString(36).slice(2)}`,
      userId: "u1",
      apiKeyId: "k1",
      publicModel: "public-model",
      internalModel: "internal-model",
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      ...overrides,
    };
  }

  it("insertBansosPromptAudit persists a pending record", async () => {
    const db = await loadDb();
    const audit = await db.insertBansosPromptAudit(baseAudit({ prompt: "hello world", stream: true }));
    expect(audit).toMatchObject({
      userId: "u1", apiKeyId: "k1", publicModel: "public-model", internalModel: "internal-model",
      status: "pending", stream: true, prompt: "hello world", promptTruncated: false,
      completedAt: null, tokens: null,
    });
  });

  it("insertBansosPromptAudit requires core fields", async () => {
    const db = await loadDb();
    await expect(db.insertBansosPromptAudit({})).rejects.toThrow();
  });

  it("finalizeBansosPromptAudit fills completion metadata exactly once", async () => {
    const db = await loadDb();
    const inserted = await db.insertBansosPromptAudit(baseAudit());
    const finalized = await db.finalizeBansosPromptAudit(inserted.requestId, {
      status: "ok", httpStatus: 200, tokens: { prompt_tokens: 10, completion_tokens: 5 }, durationMs: 120, ttftMs: 40,
    });
    expect(finalized.status).toBe("ok");
    expect(finalized.httpStatus).toBe(200);
    expect(finalized.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(finalized.durationMs).toBe(120);
    expect(finalized.ttftMs).toBe(40);
    expect(finalized.completedAt).toBeTruthy();

    // Second call is a no-op — exactly-once completion (Task 9 relies on this).
    const again = await db.finalizeBansosPromptAudit(inserted.requestId, { status: "error", httpStatus: 500 });
    expect(again.status).toBe("ok");
    expect(again.httpStatus).toBe(200);
    expect(again.completedAt).toBe(finalized.completedAt);
  });

  it("finalizeBansosPromptAudit returns null for an unknown requestId", async () => {
    const db = await loadDb();
    expect(await db.finalizeBansosPromptAudit("nope", { status: "ok" })).toBeNull();
  });

  it("listBansosPromptAudits filters by userId and status, with pagination", async () => {
    const db = await loadDb();
    for (let i = 0; i < 3; i++) {
      const a = await db.insertBansosPromptAudit(baseAudit({ userId: "list-user", apiKeyId: "list-key" }));
      if (i < 2) await db.finalizeBansosPromptAudit(a.requestId, { status: "ok" });
    }
    await db.insertBansosPromptAudit(baseAudit({ userId: "other-user" }));

    const { audits, pagination } = await db.listBansosPromptAudits({ userId: "list-user", pageSize: 2 });
    expect(pagination.totalItems).toBe(3);
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.userId === "list-user")).toBe(true);

    const { audits: okOnly } = await db.listBansosPromptAudits({ userId: "list-user", status: "ok" });
    expect(okOnly).toHaveLength(2);
  });

  it("eraseBansosPrompt nulls the prompt but preserves other fields, and is idempotent", async () => {
    const db = await loadDb();
    const inserted = await db.insertBansosPromptAudit(baseAudit({ prompt: "secret prompt" }));
    const erased = await db.eraseBansosPrompt(inserted.requestId);
    expect(erased).toBe(true);

    const { audits } = await db.listBansosPromptAudits({ userId: inserted.userId });
    const row = audits.find((a) => a.requestId === inserted.requestId);
    expect(row.prompt).toBeNull();
    expect(row.publicModel).toBe("public-model");
    expect(row.internalModel).toBe("internal-model");

    // Second erase is a no-op — prompt already null.
    expect(await db.eraseBansosPrompt(inserted.requestId)).toBe(false);
  });

  it("clearExpiredBansosPrompts nulls only prompts past expiresAt", async () => {
    const db = await loadDb();
    const past = await db.insertBansosPromptAudit(baseAudit({
      prompt: "old prompt", expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    const future = await db.insertBansosPromptAudit(baseAudit({
      prompt: "fresh prompt", expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }));

    const changed = await db.clearExpiredBansosPrompts(new Date().toISOString());
    expect(changed).toBe(1);

    const { audits } = await db.listBansosPromptAudits({ pageSize: 100 });
    const pastRow = audits.find((a) => a.requestId === past.requestId);
    const futureRow = audits.find((a) => a.requestId === future.requestId);
    expect(pastRow.prompt).toBeNull();
    expect(futureRow.prompt).toBe("fresh prompt");
  });

  it("clearExpiredBansosPrompts is idempotent — nothing left to clear on a second sweep", async () => {
    const db = await loadDb();
    await db.insertBansosPromptAudit(baseAudit({
      prompt: "old prompt", expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    const now = new Date().toISOString();
    expect(await db.clearExpiredBansosPrompts(now)).toBe(1);
    expect(await db.clearExpiredBansosPrompts(now)).toBe(0);
  });
});

describe("bansosRepo — usage breakdown", () => {
  // saveRequestUsage() (usageRepo.js) does not yet plumb a caller-supplied
  // `meta` through to the usageHistory.meta column — wiring that up is
  // Task 9's job (usage attribution). To test the read side in isolation,
  // insert directly into usageHistory the way Task 9's writer eventually
  // will: meta.bansosUserId / meta.bansosApiKeyId as the join key.
  function insertUsageRow(db, { provider, model, promptTokens, completionTokens, cost = 0, status = "ok", meta }) {
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(), provider, model, null, null, null,
        promptTokens, completionTokens, cost, status,
        JSON.stringify({}), JSON.stringify(meta ?? null),
      ]
    );
  }

  it("aggregates only rows tagged with this user's meta, parsing JSON in JS", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const bansosDb = await loadDb();
    const db = await getAdapter();

    insertUsageRow(db, { provider: "openai", model: "gpt-4", promptTokens: 10, completionTokens: 5, cost: 0.01, meta: { bansosUserId: "bu-1", bansosApiKeyId: "bk-1" } });
    insertUsageRow(db, { provider: "openai", model: "gpt-4", promptTokens: 20, completionTokens: 8, cost: 0.02, meta: { bansosUserId: "bu-1", bansosApiKeyId: "bk-1" } });
    insertUsageRow(db, { provider: "anthropic", model: "claude", promptTokens: 100, completionTokens: 50, meta: { bansosUserId: "bu-2", bansosApiKeyId: "bk-2" } });
    // Non-Bansos traffic (no meta.bansosUserId at all) must be excluded.
    insertUsageRow(db, { provider: "openai", model: "gpt-4", promptTokens: 999, completionTokens: 999, meta: null });

    const breakdown = await bansosDb.getBansosUsageBreakdown("bu-1");
    expect(breakdown.totalRequests).toBe(2);
    expect(breakdown.totalPromptTokens).toBe(30);
    expect(breakdown.totalCompletionTokens).toBe(13);
    expect(breakdown.totalCost).toBeCloseTo(0.03, 5);
    expect(breakdown.byApiKey["bk-1"].requests).toBe(2);
    expect(breakdown.byModel["gpt-4 (openai)"].requests).toBe(2);
    expect(breakdown.byModel["gpt-4 (openai)"].promptTokens).toBe(30);
  });

  it("returns a zeroed breakdown for a user with no usage", async () => {
    const db = await loadDb();
    const breakdown = await db.getBansosUsageBreakdown("no-usage-user");
    expect(breakdown.totalRequests).toBe(0);
    expect(breakdown.byModel).toEqual({});
    expect(breakdown.byApiKey).toEqual({});
  });

  it("requires a userId", async () => {
    const db = await loadDb();
    await expect(db.getBansosUsageBreakdown()).rejects.toThrow();
  });
});
