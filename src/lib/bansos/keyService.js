// Bansos Gateway API-key crypto + verification (Task 2).
//
// Bansos keys are a fully separate credential space from 9Router's ordinary
// `sk-...` API keys (src/shared/utils/apiKey.js): plain SHA-256 of the raw
// plaintext, no HMAC, no dependency on the mutable API_KEY_SECRET config
// value. A Bansos key's validity is derived only from what's stored in
// bansosApiKeys (see src/lib/db/repos/bansosRepo.js).
//
// Plaintext is shown to the caller exactly once — at creation/rotation time
// — and is never logged, never re-derivable from the stored hash, and never
// present in any list/get response (the repo layer enforces the latter with
// a fixed column allowlist; see bansosRepo.js's file header).
import crypto from "node:crypto";
import {
  createBansosKeyRecord,
  getBansosKeyByHash,
  getBansosUserById,
  listBansosKeysByUser,
  rotateBansosKeyRecord,
  touchBansosKeyLastUsed,
} from "@/lib/db/index.js";

export const BANSOS_KEY_PREFIX = "bns_";
const KEY_RANDOM_BYTES = 24; // -> 48 lowercase hex chars
const KEY_FORMAT = /^bns_[a-f0-9]{48}$/;

/**
 * Generate a new plaintext Bansos key: `bns_` + 24 random bytes as lowercase
 * hex (48 chars). Pure/sync — crypto.randomBytes is synchronous in Node.
 */
export function generateBansosKey() {
  const random = crypto.randomBytes(KEY_RANDOM_BYTES).toString("hex");
  return `${BANSOS_KEY_PREFIX}${random}`;
}

/**
 * One-way SHA-256 hash (hex digest) of the *complete* plaintext key. Used
 * identically for both creation (what gets stored) and verification (what
 * gets looked up) — never coupled to API_KEY_SECRET or any other secret.
 */
export function hashBansosKey(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("plaintext is required");
  }
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

// Non-secret display prefix, e.g. "bns_ab12...ef34" — enough for a user to
// recognize which key is which in a list, never enough to reconstruct it.
function displayPrefix(plaintext) {
  const body = plaintext.slice(BANSOS_KEY_PREFIX.length);
  return `${BANSOS_KEY_PREFIX}${body.slice(0, 4)}...${body.slice(-4)}`;
}

/**
 * Generate + persist a new Bansos key for a user. Returns the repo record
 * plus the one-time `plaintext` and its `keyHash` — the only response in
 * this module that ever carries the plaintext.
 */
export async function createBansosKey({ userId, name } = {}) {
  if (!userId) throw new Error("userId is required");
  if (!name) throw new Error("name is required");

  const plaintext = generateBansosKey();
  const keyHash = hashBansosKey(plaintext);
  const keyPrefix = displayPrefix(plaintext);

  const record = await createBansosKeyRecord({ userId, name, keyHash, keyPrefix });
  return { ...record, plaintext, keyHash };
}

// Loops listBansosKeysByUser's pages (only exposed accessor for a key by id
// scoped to an owner — Task 1 doesn't expose a getBansosKeyById) to find the
// record and confirm ownership before rotating.
async function findOwnedKey(userId, keyId) {
  let page = 1;
  for (;;) {
    const { keys, pagination } = await listBansosKeysByUser(userId, { page, pageSize: 100 });
    const found = keys.find((k) => k.id === keyId);
    if (found) return found;
    if (!pagination.hasNext) return null;
    page += 1;
  }
}

/**
 * Verify a plaintext Bansos key. Never throws on bad input — returns a
 * discriminated result instead:
 *   { ok: true, user, key }
 *   { ok: false, status: 401, code }  — malformed / unknown / revoked / disabled key
 *   { ok: false, status: 403, code }  — key is valid but the owning user is disabled
 * `lastUsedAt` is touched only once verification fully succeeds.
 */
export async function verifyBansosKey(plaintext) {
  if (typeof plaintext !== "string" || !KEY_FORMAT.test(plaintext)) {
    return { ok: false, status: 401, code: "invalid_format" };
  }

  const keyHash = hashBansosKey(plaintext);
  const key = await getBansosKeyByHash(keyHash);
  if (!key) {
    return { ok: false, status: 401, code: "key_not_found" };
  }
  if (!key.isActive || key.revokedAt) {
    return { ok: false, status: 401, code: "key_revoked" };
  }

  const user = await getBansosUserById(key.userId);
  if (!user || !user.isActive) {
    return { ok: false, status: 403, code: "user_disabled" };
  }

  const lastUsedAt = new Date().toISOString();
  await touchBansosKeyLastUsed(key.id, lastUsedAt);

  return { ok: true, user, key: { ...key, lastUsedAt } };
}

/**
 * Rotate a key. Takes a single options object — deliberately not
 * `(keyId, userId, name)` positionally: `keyId` and `userId` are both bare
 * strings/ids, so a caller that transposes them (e.g. passing a new display
 * name where `userId` belongs) would otherwise fail ownership lookup
 * silently and surface a misleading "not found" error instead of an
 * obvious argument-order bug. The object form makes the 3-required-params
 * contract self-documenting, mirroring `createBansosKey({ userId, name })`
 * in this same file.
 *
 * Crypto/business logic (generate + hash + display prefix, and defaulting
 * `name` to the original's when omitted) stays here in the service layer.
 * Persistence is delegated whole to `rotateBansosKeyRecord`, which performs
 * the INSERT (new key) and the ownership-scoped revoke UPDATE (old key)
 * inside one `db.transaction()` — see bansosRepo.js — so a crash between
 * "new key exists" and "old key revoked" can never happen; the two either
 * both land or neither does.
 *
 * Requires the caller to assert `userId` ownership (mirrors
 * `revokeBansosKey`'s ownership-scoped contract, and is necessary because
 * Task 1 exposes no `getBansosKeyById`); throws if the key doesn't exist or
 * isn't owned by that user.
 */
export async function rotateBansosKey({ keyId, userId, name } = {}) {
  if (!keyId) throw new Error("keyId is required");
  if (!userId) throw new Error("userId is required");

  const original = await findOwnedKey(userId, keyId);
  if (!original) throw new Error("Bansos key not found for this user");

  const newName = name || original.name;
  const plaintext = generateBansosKey();
  const keyHash = hashBansosKey(plaintext);
  const keyPrefix = displayPrefix(plaintext);

  const created = await rotateBansosKeyRecord({
    userId,
    oldKeyId: keyId,
    newName,
    newKeyHash: keyHash,
    newKeyPrefix: keyPrefix,
  });
  // Defensive: findOwnedKey already confirmed ownership, but re-check in
  // case the row was concurrently revoked/deleted between the two reads —
  // rotateBansosKeyRecord's own atomic ownership check is the source of truth.
  if (!created) throw new Error("Bansos key not found for this user");

  return { ...created, plaintext, keyHash };
}
