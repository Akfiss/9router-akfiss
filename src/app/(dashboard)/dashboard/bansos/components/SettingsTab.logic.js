// Pure/data-fetch contract behind SettingsTab.js — kept in a sibling module
// with zero JSX so it can be imported directly by vitest. See
// OverviewTab.logic.js's header comment for why this can't live inside
// SettingsTab.js itself. SettingsTab.js imports and uses these; nothing
// here is test-only or mirrored.

// Read-only compile-time constants (src/lib/bansos/constants.js), surfaced
// by GET /api/bansos/settings alongside the mutable fields below — there is
// deliberately no edit control for any of these in SettingsTab.js.
export const READ_ONLY_SETTINGS_FIELDS = [
  { key: "hostname", label: "Public Hostname" },
  { key: "publicModel", label: "Public Model" },
  { key: "internalModel", label: "Internal Model" },
  { key: "promptRetentionDays", label: "Prompt Retention (days)" },
  { key: "maxPromptSize", label: "Max Prompt Size (bytes)" },
  { key: "maxRequestBody", label: "Max Request Body (bytes)" },
  { key: "firstResponseTimeoutMs", label: "First Response Timeout (ms)" },
  { key: "maxStreamDurationMs", label: "Max Stream Duration (ms)" },
];

export async function fetchGatewaySettings() {
  const res = await fetch("/api/bansos/settings");
  return res.json();
}

async function patchGatewaySettings(body) {
  return fetch("/api/bansos/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Emergency kill switch — src/sse/handlers/chat.js rejects public traffic
// when settings.bansosGatewayEnabled === false.
export async function updateGatewayEnabled(enabled) {
  return patchGatewaySettings({ bansosGatewayEnabled: enabled });
}

export async function updateDefaultRequestsPerMinute(value) {
  return patchGatewaySettings({ bansosDefaultRequestsPerMinute: value });
}

export async function updateDefaultMaxConcurrentRequests(value) {
  return patchGatewaySettings({ bansosDefaultMaxConcurrentRequests: value });
}
