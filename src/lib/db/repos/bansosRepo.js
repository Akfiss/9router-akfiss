// Bansos Gateway persistence — public API gateway users, their API keys,
// and a redactable prompt audit trail. See docs/ARCHITECTURE.md /
// .superpowers/sdd/2026-08-06-bansos-gateway/ for the feature's full plan.
//
// IMPORTANT — keyHash secrecy: bansosApiKeys.keyHash is a one-way hash of the
// raw public key (Task 2 owns hashing/verification). No function in this
// file ever returns the keyHash column — every SELECT that touches
// bansosApiKeys explicitly enumerates columns (KEY_COLUMNS) rather than
// `SELECT *`, and every row mapper omits it. Callers that computed the hash
// themselves (createBansosKeyRecord, and Task 2's verifier comparing against
// getBansosKeyByHash's WHERE clause) already hold the value; there is never
// a need to hand it back.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

function clampPageSize(pageSize) {
  const n = Number.isFinite(pageSize) ? Math.trunc(pageSize) : DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, n));
}

function clampPage(page) {
  const n = Number.isFinite(page) ? Math.trunc(page) : 1;
  return Math.max(1, n);
}

function paginate(filter = {}) {
  const pageSize = clampPageSize(filter.pageSize);
  const page = clampPage(filter.page);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function buildPagination(page, pageSize, totalItems) {
  const totalPages = Math.ceil(totalItems / pageSize) || 0;
  return { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
}

// ── Users ──────────────────────────────────────────────────────────────

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    requestsPerMinute: row.requestsPerMinute,
    maxConcurrentRequests: row.maxConcurrentRequests,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createBansosUser(data = {}) {
  if (!data.name || typeof data.name !== "string") throw new Error("name is required");
  const db = await getAdapter();
  const now = new Date().toISOString();
  const user = {
    id: uuidv4(),
    name: data.name,
    requestsPerMinute: data.requestsPerMinute ?? 10,
    maxConcurrentRequests: data.maxConcurrentRequests ?? 2,
    isActive: data.isActive !== undefined ? !!data.isActive : true,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO bansosUsers(id, name, requestsPerMinute, maxConcurrentRequests, isActive, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [user.id, user.name, user.requestsPerMinute, user.maxConcurrentRequests, user.isActive ? 1 : 0, user.createdAt, user.updatedAt]
  );
  return user;
}

export async function listBansosUsers(filter = {}) {
  const db = await getAdapter();
  const { page, pageSize, offset } = paginate(filter);
  const totalItems = db.get(`SELECT COUNT(*) as c FROM bansosUsers`)?.c ?? 0;
  const rows = db.all(`SELECT * FROM bansosUsers ORDER BY createdAt ASC LIMIT ? OFFSET ?`, [pageSize, offset]);
  return { users: rows.map(rowToUser), pagination: buildPagination(page, pageSize, totalItems) };
}

export async function getBansosUserById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM bansosUsers WHERE id = ?`, [id]);
  return rowToUser(row);
}

const USER_UPDATABLE_FIELDS = ["name", "requestsPerMinute", "maxConcurrentRequests", "isActive"];

export async function updateBansosUser(id, data = {}) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM bansosUsers WHERE id = ?`, [id]);
    if (!row) return;
    const merged = rowToUser(row);
    for (const f of USER_UPDATABLE_FIELDS) {
      if (data[f] !== undefined) merged[f] = f === "isActive" ? !!data[f] : data[f];
    }
    merged.updatedAt = new Date().toISOString();
    db.run(
      `UPDATE bansosUsers SET name = ?, requestsPerMinute = ?, maxConcurrentRequests = ?, isActive = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.requestsPerMinute, merged.maxConcurrentRequests, merged.isActive ? 1 : 0, merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

// ── API keys ───────────────────────────────────────────────────────────

// Deliberately excludes keyHash — see file-level note.
const KEY_COLUMNS = "id, userId, name, keyPrefix, isActive, lastUsedAt, createdAt, revokedAt";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    isActive: row.isActive === 1 || row.isActive === true,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt ?? null,
  };
}

export async function createBansosKeyRecord(data = {}) {
  const { userId, name, keyHash, keyPrefix } = data;
  if (!userId) throw new Error("userId is required");
  if (!name) throw new Error("name is required");
  if (!keyHash) throw new Error("keyHash is required");
  if (!keyPrefix) throw new Error("keyPrefix is required");

  const db = await getAdapter();
  const id = uuidv4();
  const createdAt = new Date().toISOString();
  db.run(
    `INSERT INTO bansosApiKeys(id, userId, name, keyHash, keyPrefix, isActive, lastUsedAt, createdAt, revokedAt) VALUES(?, ?, ?, ?, ?, 1, NULL, ?, NULL)`,
    [id, userId, name, keyHash, keyPrefix, createdAt]
  );
  const row = db.get(`SELECT ${KEY_COLUMNS} FROM bansosApiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getBansosKeyByHash(keyHash) {
  if (!keyHash) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT ${KEY_COLUMNS} FROM bansosApiKeys WHERE keyHash = ?`, [keyHash]);
  return rowToKey(row);
}

export async function listBansosKeysByUser(userId, filter = {}) {
  const db = await getAdapter();
  const { page, pageSize, offset } = paginate(filter);
  const totalItems = db.get(`SELECT COUNT(*) as c FROM bansosApiKeys WHERE userId = ?`, [userId])?.c ?? 0;
  const rows = db.all(
    `SELECT ${KEY_COLUMNS} FROM bansosApiKeys WHERE userId = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    [userId, pageSize, offset]
  );
  return { keys: rows.map(rowToKey), pagination: buildPagination(page, pageSize, totalItems) };
}

// Ownership invariant: a key can only be revoked by the user that owns it —
// callers must pass the userId they authenticated as, not just the key id.
// Idempotent: revoking an already-revoked key is a no-op that returns the
// current (already-revoked) row rather than erroring or bumping revokedAt.
export async function revokeBansosKey(id, userId) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT ${KEY_COLUMNS} FROM bansosApiKeys WHERE id = ? AND userId = ?`, [id, userId]);
    if (!row) return;
    if (row.revokedAt) { result = rowToKey(row); return; }
    const revokedAt = new Date().toISOString();
    db.run(`UPDATE bansosApiKeys SET isActive = 0, revokedAt = ? WHERE id = ?`, [revokedAt, id]);
    result = rowToKey({ ...row, isActive: 0, revokedAt });
  });
  return result;
}

export async function touchBansosKeyLastUsed(id, whenIso) {
  const db = await getAdapter();
  const when = whenIso || new Date().toISOString();
  const res = db.run(`UPDATE bansosApiKeys SET lastUsedAt = ? WHERE id = ?`, [when, id]);
  return (res?.changes ?? 0) > 0;
}

// ── Prompt audit ───────────────────────────────────────────────────────

function rowToAudit(row) {
  if (!row) return null;
  return {
    requestId: row.requestId,
    userId: row.userId,
    apiKeyId: row.apiKeyId,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
    expiresAt: row.expiresAt,
    publicModel: row.publicModel,
    internalModel: row.internalModel,
    stream: row.stream === 1 || row.stream === true,
    status: row.status,
    httpStatus: row.httpStatus ?? null,
    errorCategory: row.errorCategory ?? null,
    prompt: row.prompt ?? null,
    promptTruncated: row.promptTruncated === 1 || row.promptTruncated === true,
    tokens: parseJson(row.tokens, null),
    durationMs: row.durationMs ?? null,
    ttftMs: row.ttftMs ?? null,
  };
}

export async function insertBansosPromptAudit(data = {}) {
  const { requestId, userId, apiKeyId, publicModel, internalModel, expiresAt } = data;
  if (!requestId) throw new Error("requestId is required");
  if (!userId) throw new Error("userId is required");
  if (!apiKeyId) throw new Error("apiKeyId is required");
  if (!publicModel) throw new Error("publicModel is required");
  if (!internalModel) throw new Error("internalModel is required");
  if (!expiresAt) throw new Error("expiresAt is required");

  const db = await getAdapter();
  const createdAt = data.createdAt || new Date().toISOString();
  const record = {
    requestId, userId, apiKeyId, createdAt,
    completedAt: null,
    expiresAt,
    publicModel, internalModel,
    stream: data.stream ? 1 : 0,
    status: data.status || "pending",
    httpStatus: null,
    errorCategory: null,
    prompt: data.prompt ?? null,
    promptTruncated: data.promptTruncated ? 1 : 0,
    tokens: null,
    durationMs: null,
    ttftMs: null,
  };
  db.run(
    `INSERT INTO bansosPromptAudit(
       requestId, userId, apiKeyId, createdAt, completedAt, expiresAt,
       publicModel, internalModel, stream, status, httpStatus, errorCategory,
       prompt, promptTruncated, tokens, durationMs, ttftMs
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.requestId, record.userId, record.apiKeyId, record.createdAt, record.completedAt, record.expiresAt,
      record.publicModel, record.internalModel, record.stream, record.status, record.httpStatus, record.errorCategory,
      record.prompt, record.promptTruncated, record.tokens, record.durationMs, record.ttftMs,
    ]
  );
  const row = db.get(`SELECT * FROM bansosPromptAudit WHERE requestId = ?`, [requestId]);
  return rowToAudit(row);
}

// Exactly-once completion: once completedAt is set, subsequent calls are a
// no-op that return the already-finalized row unchanged. This lets an
// at-least-once caller (e.g. a retried usage-attribution hook) call finalize
// repeatedly without double-applying status/duration/token updates.
export async function finalizeBansosPromptAudit(requestId, data = {}) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM bansosPromptAudit WHERE requestId = ?`, [requestId]);
    if (!row) return;
    if (row.completedAt) { result = rowToAudit(row); return; }

    const completedAt = data.completedAt || new Date().toISOString();
    const status = data.status || row.status;
    const httpStatus = data.httpStatus ?? row.httpStatus ?? null;
    const errorCategory = data.errorCategory ?? row.errorCategory ?? null;
    const tokens = data.tokens !== undefined ? stringifyJson(data.tokens) : row.tokens;
    const durationMs = data.durationMs ?? row.durationMs ?? null;
    const ttftMs = data.ttftMs ?? row.ttftMs ?? null;

    db.run(
      `UPDATE bansosPromptAudit
       SET completedAt = ?, status = ?, httpStatus = ?, errorCategory = ?, tokens = ?, durationMs = ?, ttftMs = ?
       WHERE requestId = ?`,
      [completedAt, status, httpStatus, errorCategory, tokens, durationMs, ttftMs, requestId]
    );
    result = rowToAudit({ ...row, completedAt, status, httpStatus, errorCategory, tokens, durationMs, ttftMs });
  });
  return result;
}

export async function listBansosPromptAudits(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];
  if (filter.userId) { conds.push("userId = ?"); params.push(filter.userId); }
  if (filter.apiKeyId) { conds.push("apiKeyId = ?"); params.push(filter.apiKeyId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const { page, pageSize, offset } = paginate(filter);
  const totalItems = db.get(`SELECT COUNT(*) as c FROM bansosPromptAudit ${where}`, params)?.c ?? 0;
  const rows = db.all(
    `SELECT * FROM bansosPromptAudit ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { audits: rows.map(rowToAudit), pagination: buildPagination(page, pageSize, totalItems) };
}

export async function eraseBansosPrompt(requestId) {
  const db = await getAdapter();
  const res = db.run(`UPDATE bansosPromptAudit SET prompt = NULL WHERE requestId = ? AND prompt IS NOT NULL`, [requestId]);
  return (res?.changes ?? 0) > 0;
}

// Bulk retention sweep — exact statement required by the task brief so
// every adapter (including sql.js) executes an identical, index-friendly
// query (idx_bpa_expires).
export async function clearExpiredBansosPrompts(nowIso) {
  const db = await getAdapter();
  const when = nowIso || new Date().toISOString();
  const res = db.run(`UPDATE bansosPromptAudit SET prompt = NULL WHERE expiresAt <= ? AND prompt IS NOT NULL`, [when]);
  return res?.changes ?? 0;
}

// ── Usage breakdown ────────────────────────────────────────────────────

// usageHistory.meta is an opaque JSON TEXT column shared with non-Bansos
// writers. Bansos-attributing writers (Task 9) MUST stamp
// meta.bansosUserId / meta.bansosApiKeyId on every row they insert — this is
// the join key back to bansosUsers/bansosApiKeys since we deliberately don't
// use SQL foreign keys. Filtering/aggregation happens in JS (not
// json_extract/JSON1) so this works identically on the sql.js fallback
// adapter, which has no JSON1 support.
export async function getBansosUsageBreakdown(userId, filter = {}) {
  if (!userId) throw new Error("userId is required");
  const db = await getAdapter();
  const conds = [];
  const params = [];
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const rows = db.all(
    `SELECT provider, model, promptTokens, completionTokens, cost, status, meta, timestamp FROM usageHistory ${where}`,
    params
  );

  const breakdown = {
    userId,
    totalRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCost: 0,
    byModel: {},
    byApiKey: {},
  };

  for (const row of rows) {
    const meta = parseJson(row.meta, null);
    if (!meta || meta.bansosUserId !== userId) continue;

    const promptTokens = row.promptTokens || 0;
    const completionTokens = row.completionTokens || 0;
    const cost = row.cost || 0;

    breakdown.totalRequests += 1;
    breakdown.totalPromptTokens += promptTokens;
    breakdown.totalCompletionTokens += completionTokens;
    breakdown.totalCost += cost;

    const modelKey = row.provider ? `${row.model} (${row.provider})` : (row.model || "unknown");
    const modelBucket = breakdown.byModel[modelKey] ||= { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    modelBucket.requests += 1;
    modelBucket.promptTokens += promptTokens;
    modelBucket.completionTokens += completionTokens;
    modelBucket.cost += cost;

    const apiKeyId = meta.bansosApiKeyId || "unknown";
    const keyBucket = breakdown.byApiKey[apiKeyId] ||= { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    keyBucket.requests += 1;
    keyBucket.promptTokens += promptTokens;
    keyBucket.completionTokens += completionTokens;
    keyBucket.cost += cost;
  }

  return breakdown;
}
