// Pure/data-fetch contract behind UsersKeysTab.js — kept in a sibling module
// with zero JSX so it can be imported directly by vitest. See
// OverviewTab.logic.js's header comment for why this can't live inside
// UsersKeysTab.js itself. UsersKeysTab.js imports and uses these; nothing
// here is test-only or mirrored.

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

// Client-side pre-check mirroring the server's own validation
// (src/app/api/bansos/users/route.js and .../users/[id]/route.js) so the
// create/edit form can show an inline error before round-tripping to the
// API. requestsPerMinute/maxConcurrentRequests are optional — "" (unset)
// is valid and means "use the gateway default".
export function validateUserForm({ name, requestsPerMinute, maxConcurrentRequests } = {}) {
  if (!name || typeof name !== "string" || !name.trim()) {
    return "Name is required";
  }
  if (
    requestsPerMinute !== undefined &&
    requestsPerMinute !== "" &&
    !isPositiveInteger(Number(requestsPerMinute))
  ) {
    return "Requests per minute must be a positive integer";
  }
  if (
    maxConcurrentRequests !== undefined &&
    maxConcurrentRequests !== "" &&
    !isPositiveInteger(Number(maxConcurrentRequests))
  ) {
    return "Max concurrent requests must be a positive integer";
  }
  return null;
}

export function isKeyRevoked(key) {
  return !!key?.revokedAt;
}

export async function fetchGatewayUsers({ page = 1, pageSize = 20 } = {}) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  const res = await fetch(`/api/bansos/users?${params}`);
  return res.json();
}

// Returns the raw Response (not parsed) so callers can branch on res.ok
// before reading the body — matches the create/update conventions used
// throughout src/app/(dashboard)/dashboard/profile/page.js.
export async function createGatewayUser(payload) {
  return fetch("/api/bansos/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateGatewayUser(userId, patch) {
  return fetch(`/api/bansos/users/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function fetchUserKeys(userId, { page = 1, pageSize = 20 } = {}) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  const res = await fetch(`/api/bansos/users/${userId}/keys?${params}`);
  return res.json();
}

export async function createUserKey(userId, name) {
  return fetch(`/api/bansos/users/${userId}/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

// userId travels as a query param on DELETE (bodyless-by-convention) — see
// src/app/api/bansos/keys/[id]/route.js's own header comment.
export async function revokeUserKey(keyId, userId) {
  return fetch(`/api/bansos/keys/${keyId}?userId=${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export async function rotateUserKey(keyId, userId, name) {
  const body = name ? { userId, name } : { userId };
  return fetch(`/api/bansos/keys/${keyId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
