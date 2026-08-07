// Bansos Gateway key crypto/verification service (Task 2).
// Covers: one-time plaintext reveal, SHA-256 hash/prefix storage (never the
// mutable API_KEY_SECRET), and verifyBansosKey's malformed/unknown/revoked/
// disabled-key/disabled-user/success paths, plus create-before-revoke
// rotation. Builds on Task 1's bansosRepo (see bansos-repo.test.js for the
// repo-layer contract this consumes).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalApiKeySecret = process.env.API_KEY_SECRET;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bansos-key-"));
  process.env.DATA_DIR = tempDir;
  // Deliberately vary API_KEY_SECRET across tests to prove Bansos-key
  // validity never depends on it (see "decoupled from API_KEY_SECRET" test).
  process.env.API_KEY_SECRET = `unrelated-secret-${Math.random()}`;
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
  if (originalApiKeySecret === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = originalApiKeySecret;
});

async function loadDb() {
  return await import("@/lib/db/index.js");
}

async function loadDriver() {
  return await import("@/lib/db/driver.js");
}

async function loadKeyService() {
  return await import("@/lib/bansos/keyService.js");
}

describe("keyService — generateBansosKey / hashBansosKey", () => {
  it("generateBansosKey returns bns_ + 48 lowercase hex chars, and is not deterministic", async () => {
    const { generateBansosKey } = await loadKeyService();
    const a = generateBansosKey();
    const b = generateBansosKey();
    expect(a).toMatch(/^bns_[a-f0-9]{48}$/);
    expect(b).toMatch(/^bns_[a-f0-9]{48}$/);
    expect(a).not.toBe(b);
  });

  it("hashBansosKey is a deterministic SHA-256 hex digest of the full plaintext", async () => {
    const { hashBansosKey } = await loadKeyService();
    const h1 = hashBansosKey("bns_abc123");
    const h2 = hashBansosKey("bns_abc123");
    const h3 = hashBansosKey("bns_different");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashBansosKey rejects empty/non-string input", async () => {
    const { hashBansosKey } = await loadKeyService();
    expect(() => hashBansosKey("")).toThrow();
    expect(() => hashBansosKey(undefined)).toThrow();
    expect(() => hashBansosKey(123)).toThrow();
  });

  it("hashing does not depend on API_KEY_SECRET (separate credential space)", async () => {
    process.env.API_KEY_SECRET = "secret-one";
    const { hashBansosKey: hashWithSecretOne } = await loadKeyService();
    const h1 = hashWithSecretOne("bns_stableplaintext");

    vi.resetModules();
    process.env.API_KEY_SECRET = "totally-different-secret";
    const { hashBansosKey: hashWithSecretTwo } = await loadKeyService();
    const h2 = hashWithSecretTwo("bns_stableplaintext");

    expect(h1).toBe(h2);
  });
});

describe("keyService — createBansosKey", () => {
  it("reveals plaintext exactly once and never persists it or the hash in repo reads", async () => {
    const db = await loadDb();
    const { createBansosKey } = await loadKeyService();
    const user = await db.createBansosUser({ name: "Alice" });

    const created = await createBansosKey({ userId: user.id, name: "Laptop" });
    expect(created.plaintext).toMatch(/^bns_[a-f0-9]{48}$/);
    expect(created.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.name).toBe("Laptop");
    expect(created.userId).toBe(user.id);
    expect(created.keyPrefix).toMatch(/^bns_[a-f0-9]{4}\.\.\.[a-f0-9]{4}$/);

    const fetchedByHash = await db.getBansosKeyByHash(created.keyHash);
    expect(fetchedByHash).not.toHaveProperty("plaintext");
    expect(fetchedByHash).not.toHaveProperty("keyHash");

    const { keys } = await db.listBansosKeysByUser(user.id);
    for (const k of keys) {
      expect(k).not.toHaveProperty("plaintext");
      expect(k).not.toHaveProperty("keyHash");
    }
  });

  it("requires userId and name", async () => {
    const { createBansosKey } = await loadKeyService();
    await expect(createBansosKey({})).rejects.toThrow();
    await expect(createBansosKey({ userId: "u1" })).rejects.toThrow();
    await expect(createBansosKey({ name: "no-user" })).rejects.toThrow();
  });

  it("never logs the plaintext key", async () => {
    const db = await loadDb();
    const { createBansosKey } = await loadKeyService();
    const user = await db.createBansosUser({ name: "Quiet" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const created = await createBansosKey({ userId: user.id, name: "Logged?" });
      const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
      for (const args of allCalls) {
        for (const arg of args) {
          expect(String(arg)).not.toContain(created.plaintext);
        }
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("keyService — verifyBansosKey", () => {
  it("succeeds for a freshly created key and returns { ok: true, user, key }", async () => {
    const db = await loadDb();
    const { createBansosKey, verifyBansosKey } = await loadKeyService();
    const user = await db.createBansosUser({ name: "Verifier" });
    const created = await createBansosKey({ userId: user.id, name: "Phone" });

    const result = await verifyBansosKey(created.plaintext);
    expect(result.ok).toBe(true);
    expect(result.user.id).toBe(user.id);
    expect(result.key.id).toBeTruthy();
    expect(result.key).not.toHaveProperty("keyHash");
    expect(result.key).not.toHaveProperty("plaintext");
  });

  it("touches lastUsedAt only after a successful verification", async () => {
    const db = await loadDb();
    const { createBansosKey, verifyBansosKey } = await loadKeyService();
    const user = await db.createBansosUser({ name: "Toucher" });
    const created = await createBansosKey({ userId: user.id, name: "Tablet" });

    const before = await db.listBansosKeysByUser(user.id);
    expect(before.keys[0].lastUsedAt).toBeNull();

    await verifyBansosKey(created.plaintext);

    const after = await db.listBansosKeysByUser(user.id);
    expect(after.keys[0].lastUsedAt).toBeTruthy();
  });

  it("rejects a malformed key with 401 before touching the database", async () => {
    const { verifyBansosKey } = await loadKeyService();
    const result = await verifyBansosKey("not-a-real-key");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.code).toBeTruthy();
  });

  it("rejects an empty/non-string plaintext with 401", async () => {
    const { verifyBansosKey } = await loadKeyService();
    expect((await verifyBansosKey("")).ok).toBe(false);
    expect((await verifyBansosKey(undefined)).ok).toBe(false);
    expect((await verifyBansosKey(null)).ok).toBe(false);
  });

  it("rejects a well-formed but unknown key with 401", async () => {
    const { generateBansosKey, verifyBansosKey } = await loadKeyService();
    const unknown = generateBansosKey(); // well-formed, never persisted
    const result = await verifyBansosKey(unknown);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("rejects a revoked key with 401 and does not touch lastUsedAt", async () => {
    const db = await loadDb();
    const { createBansosKey, verifyBansosKey } = await loadKeyService();
    const user = await db.createBansosUser({ name: "Revokee" });
    const created = await createBansosKey({ userId: user.id, name: "Old laptop" });
    await db.revokeBansosKey(created.id, user.id);

    const result = await verifyBansosKey(created.plaintext);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);

    const { keys } = await db.listBansosKeysByUser(user.id);
    expect(keys[0].lastUsedAt).toBeNull();
  });

  it("rejects a disabled key (isActive=false, not necessarily revoked) with 401", async () => {
    const db = await loadDb();
    const { getAdapter } = await loadDriver();
    const { createBansosKey, verifyBansosKey } = await loadKeyService();
    const user = await db.createBansosUser({ name: "DisabledKeyOwner" });
    const created = await createBansosKey({ userId: user.id, name: "Disabled" });

    // Simulate an isActive=false row that was never routed through revokeBansosKey
    // (revokedAt left NULL) — exercises the isActive check independently of revokedAt.
    const rawDb = await getAdapter();
    rawDb.run(`UPDATE bansosApiKeys SET isActive = 0 WHERE id = ?`, [created.id]);

    const result = await verifyBansosKey(created.plaintext);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("rejects a key owned by a disabled user with 403", async () => {
    const db = await loadDb();
    const { createBansosKey, verifyBansosKey } = await loadKeyService();
    const user = await db.createBansosUser({ name: "DisabledUser", isActive: false });
    const created = await createBansosKey({ userId: user.id, name: "Orphaned" });

    const result = await verifyBansosKey(created.plaintext);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.code).toBeTruthy();
  });

  it("verification does not depend on API_KEY_SECRET", async () => {
    const db = await loadDb();
    const { createBansosKey, verifyBansosKey } = await loadKeyService();
    const user = await db.createBansosUser({ name: "SecretIndependent" });
    const created = await createBansosKey({ userId: user.id, name: "K" });

    process.env.API_KEY_SECRET = "changed-after-creation";
    const result = await verifyBansosKey(created.plaintext);
    expect(result.ok).toBe(true);
  });
});

describe("keyService — rotateBansosKey", () => {
  it("creates the replacement before revoking the original, invalidating the old plaintext", async () => {
    const db = await loadDb();
    const { createBansosKey, rotateBansosKey, verifyBansosKey } = await loadKeyService();
    const user = await db.createBansosUser({ name: "Rotator" });
    const original = await createBansosKey({ userId: user.id, name: "Main key" });

    const rotated = await rotateBansosKey({ keyId: original.id, userId: user.id, name: "Main key (rotated)" });
    expect(rotated.plaintext).toMatch(/^bns_[a-f0-9]{48}$/);
    expect(rotated.plaintext).not.toBe(original.plaintext);
    expect(rotated.userId).toBe(user.id);
    expect(rotated.name).toBe("Main key (rotated)");

    const oldResult = await verifyBansosKey(original.plaintext);
    expect(oldResult.ok).toBe(false);
    expect(oldResult.status).toBe(401);

    const newResult = await verifyBansosKey(rotated.plaintext);
    expect(newResult.ok).toBe(true);

    // Both old and new records exist for the user; old is revoked, new is active.
    const { keys } = await db.listBansosKeysByUser(user.id);
    expect(keys).toHaveLength(2);
    const oldRow = keys.find((k) => k.id === original.id);
    const newRow = keys.find((k) => k.id === rotated.id);
    expect(oldRow.revokedAt).toBeTruthy();
    expect(oldRow.isActive).toBe(false);
    expect(newRow.isActive).toBe(true);
  });

  it("reuses the original key's name when no new name is given", async () => {
    const db = await loadDb();
    const { createBansosKey, rotateBansosKey } = await loadKeyService();
    const user = await db.createBansosUser({ name: "NameReuser" });
    const original = await createBansosKey({ userId: user.id, name: "Keep my name" });

    const rotated = await rotateBansosKey({ keyId: original.id, userId: user.id });
    expect(rotated.name).toBe("Keep my name");
  });

  it("rejects rotating a key that does not belong to the given user", async () => {
    const db = await loadDb();
    const { createBansosKey, rotateBansosKey, verifyBansosKey } = await loadKeyService();
    const owner = await db.createBansosUser({ name: "RealOwner" });
    const stranger = await db.createBansosUser({ name: "Stranger" });
    const original = await createBansosKey({ userId: owner.id, name: "Not yours" });

    await expect(rotateBansosKey({ keyId: original.id, userId: stranger.id, name: "stolen" })).rejects.toThrow();

    // Original key must remain untouched/active — rotation must not have run.
    const result = await verifyBansosKey(original.plaintext);
    expect(result.ok).toBe(true);
  });

  it("rejects rotating an unknown keyId", async () => {
    const db = await loadDb();
    const { rotateBansosKey } = await loadKeyService();
    const user = await db.createBansosUser({ name: "NoKeys" });
    await expect(rotateBansosKey({ keyId: "does-not-exist", userId: user.id, name: "x" })).rejects.toThrow();
  });
});
