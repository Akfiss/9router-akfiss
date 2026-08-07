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

// Wait period (ms) between the last keystroke and firing the live PATCH for
// the new-user default inputs below. Without this, every keystroke fired a
// real PATCH — typing a two-digit value like "15" would briefly (but
// genuinely, via a real network round-trip) persist the gateway-wide
// default as "1" before the next keystroke corrected it to "15".
export const DEFAULT_LIMIT_DEBOUNCE_MS = 500;

// Minimal generic debounce: returns a wrapper that only invokes `fn` (with
// the most recent args) after `wait` ms have elapsed since the last call.
// Used to gate the New User Defaults inputs so they mutate the gateway-wide
// default at most once per pause in typing, rather than on every keystroke.
export function debounce(fn, wait) {
  let timeoutId;
  function debounced(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), wait);
  }
  debounced.cancel = () => clearTimeout(timeoutId);
  return debounced;
}

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
