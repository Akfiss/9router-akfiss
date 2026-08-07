// Pure/data-fetch contract behind UsageLogsTab.js — kept in a sibling module
// with zero JSX so it can be imported directly by vitest. See
// OverviewTab.logic.js's header comment for why this can't live inside
// UsageLogsTab.js itself. UsageLogsTab.js imports and uses these; nothing
// here is test-only or mirrored.

// PromptAudit.prompt is null once expired or explicitly erased (7-day
// retention — see src/lib/db/repos/bansosRepo.js's rowToAudit /
// clearExpiredBansosPrompts). This distinguishes "genuinely erased" from a
// real (if unlikely) empty-string prompt so the UI never renders a blank
// cell that looks like a bug.
export function isPromptExpired(audit) {
  return !audit || audit.prompt === null || audit.prompt === undefined;
}

export function formatRetentionWarning(promptRetentionDays) {
  const days = Number(promptRetentionDays);
  if (!Number.isFinite(days) || days <= 0) {
    return "Prompt text is not retained for any of these requests.";
  }
  return `Prompt text is automatically and permanently erased ${days} day${days === 1 ? "" : "s"} after each request.`;
}

// Mirrors src/app/api/bansos/requests/route.js's own convention of omitting
// unset filters rather than passing empty strings through.
export function buildRequestsParams(filters = {}, pagination = {}) {
  const params = new URLSearchParams();
  if (filters.userId) params.set("userId", filters.userId);
  if (filters.apiKeyId) params.set("apiKeyId", filters.apiKeyId);
  if (filters.status) params.set("status", filters.status);
  params.set("page", String(pagination.page || 1));
  params.set("pageSize", String(pagination.pageSize || 20));
  return params;
}

export async function fetchPromptAudits(filters, pagination) {
  const params = buildRequestsParams(filters, pagination);
  const res = await fetch(`/api/bansos/requests?${params}`);
  return res.json();
}

// Returns the raw Response (not parsed) so the caller can branch on res.ok —
// DELETE is idempotent-but-not-always-200 (404 when already erased/unknown,
// see src/app/api/bansos/requests/[requestId]/prompt/route.js).
export async function eraseAuditPrompt(requestId) {
  return fetch(`/api/bansos/requests/${requestId}/prompt`, { method: "DELETE" });
}
