// Bansos Gateway dashboard UI (Task 13) — component contract tests.
//
// This codebase has no component-rendering test infrastructure (no
// @testing-library/react, no jsdom — tests/vitest.config.js runs
// environment: "node"). Beyond that, this test transform cannot even PARSE
// a .js file that contains JSX — importing any named export from such a
// file (even one with zero JSX itself) fails at collection time with
// "Failed to parse source... If you are using JSX, make sure to name the
// file with the .jsx or .tsx extension." (confirmed empirically while
// building this suite). So every pure helper / fetch-wrapper this file
// exercises lives in a JSX-free sibling module (`*.logic.js` next to each
// tab component, `page.logic.js` next to page.js, `Header.pageInfo.js` /
// `Sidebar.navItems.js` next to those shared components) that the real
// component imports and uses — not a copy mirrored into this test file.
// This mirrors (and improves on) the one real precedent in this repo,
// tests/unit/request-details-tab.test.js, which tests the backing
// route/DB layer behind a tab component rather than rendering it.
import { describe, it, expect, vi, afterEach } from "vitest";

import { navItems, debugItems, systemItems } from "../../src/shared/components/Sidebar.navItems.js";
import { getPageInfo } from "../../src/shared/components/Header.pageInfo.js";
import { BANSOS_TABS, resolveBansosTab } from "../../src/app/(dashboard)/dashboard/bansos/page.logic.js";
import {
  isGatewayUnavailable,
  buildBansosBaseUrl,
  fetchBansosSettings,
  fetchBansosOverview,
} from "../../src/app/(dashboard)/dashboard/bansos/components/OverviewTab.logic.js";
import {
  validateUserForm,
  isKeyRevoked,
  buildUserLimitsPayload,
  fetchGatewayUsers,
  createGatewayUser,
  updateGatewayUser,
  fetchUserKeys,
  createUserKey,
  revokeUserKey,
  rotateUserKey,
} from "../../src/app/(dashboard)/dashboard/bansos/components/UsersKeysTab.logic.js";
import {
  isPromptExpired,
  formatRetentionWarning,
  buildRequestsParams,
  fetchPromptAudits,
  eraseAuditPrompt,
} from "../../src/app/(dashboard)/dashboard/bansos/components/UsageLogsTab.logic.js";
import {
  READ_ONLY_SETTINGS_FIELDS,
  DEFAULT_LIMIT_DEBOUNCE_MS,
  debounce,
  fetchGatewaySettings,
  updateGatewayEnabled,
  updateDefaultRequestsPerMinute,
  updateDefaultMaxConcurrentRequests,
} from "../../src/app/(dashboard)/dashboard/bansos/components/SettingsTab.logic.js";

function stubFetch(impl) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Navigation / page metadata ("four sections" + nav entry) ────────────

describe("Sidebar navigation", () => {
  it("includes the Bansos Gateway entry in the System section", () => {
    expect(systemItems).toContainEqual({
      href: "/dashboard/bansos",
      label: "Bansos Gateway",
      icon: "public",
    });
  });

  it("does not duplicate the Bansos entry into the top-level or debug nav", () => {
    expect(navItems.some((item) => item.href === "/dashboard/bansos")).toBe(false);
    expect(debugItems.some((item) => item.href === "/dashboard/bansos")).toBe(false);
  });
});

describe("Header page metadata", () => {
  it("resolves title/description/icon for /dashboard/bansos", () => {
    const info = getPageInfo("/dashboard/bansos");
    expect(info).toEqual({
      title: "Bansos Gateway",
      description: "Manage public gateway users, keys, and settings",
      icon: "public",
      breadcrumbs: [],
    });
  });

  it("also resolves for a sub-path (e.g. with a query-string tab)", () => {
    const info = getPageInfo("/dashboard/bansos");
    // getPageInfo is only ever called with pathname (no search string) by
    // usePathname(), but the route matches via .includes("/bansos") so any
    // /dashboard/bansos* pathname resolves the same way.
    expect(info.title).toBe("Bansos Gateway");
  });
});

describe("Bansos page tab contract (four sections)", () => {
  it("exposes exactly the four documented sections", () => {
    expect(BANSOS_TABS).toEqual(["overview", "users", "logs", "settings"]);
  });

  it("resolveBansosTab passes through a valid tab", () => {
    expect(resolveBansosTab("users")).toBe("users");
    expect(resolveBansosTab("logs")).toBe("logs");
    expect(resolveBansosTab("settings")).toBe("settings");
  });

  it("resolveBansosTab defaults to overview for missing/unknown/null tab", () => {
    expect(resolveBansosTab(undefined)).toBe("overview");
    expect(resolveBansosTab(null)).toBe("overview");
    expect(resolveBansosTab("bogus")).toBe("overview");
    expect(resolveBansosTab("")).toBe("overview");
  });
});

// ── Overview tab ──────────────────────────────────────────────────────────

describe("OverviewTab: availability warning", () => {
  it("flags unavailable when the kill switch is off", () => {
    expect(isGatewayUnavailable({ gatewayEnabled: false })).toBe(true);
  });

  it("does not flag unavailable when the kill switch is on or absent (enabled-by-default)", () => {
    expect(isGatewayUnavailable({ gatewayEnabled: true })).toBe(false);
    expect(isGatewayUnavailable({})).toBe(false);
  });

  it("is defensive against a null/undefined settings object", () => {
    expect(isGatewayUnavailable(null)).toBe(false);
    expect(isGatewayUnavailable(undefined)).toBe(false);
  });
});

describe("OverviewTab: base URL / model copy fields", () => {
  it("builds an https base URL from the hostname", () => {
    expect(buildBansosBaseUrl("api.priaoslo.web.id")).toBe("https://api.priaoslo.web.id/v1");
  });

  it("returns an empty string for a missing hostname rather than 'https://undefined/v1'", () => {
    expect(buildBansosBaseUrl(undefined)).toBe("");
    expect(buildBansosBaseUrl("")).toBe("");
  });
});

describe("OverviewTab: data fetch shape", () => {
  it("fetchBansosSettings GETs /api/bansos/settings", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ hostname: "api.priaoslo.web.id" }));
    const data = await fetchBansosSettings();
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/settings");
    expect(data.hostname).toBe("api.priaoslo.web.id");
  });

  it("fetchBansosOverview omits the probe param during normal polling", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ userCount: 1 }));
    await fetchBansosOverview();
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/overview");
  });

  it("fetchBansosOverview includes probe=true only when explicitly requested", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ publicHost: { reachable: true } }));
    await fetchBansosOverview(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/overview?probe=true");
  });
});

// ── Users & Keys tab ───────────────────────────────────────────────────────

describe("UsersKeysTab: per-user limits validation", () => {
  it("rejects a missing/blank name", () => {
    expect(validateUserForm({ name: "" })).toBeTruthy();
    expect(validateUserForm({ name: "   " })).toBeTruthy();
    expect(validateUserForm({})).toBeTruthy();
  });

  it("accepts a name with no limits specified (defers to gateway defaults)", () => {
    expect(validateUserForm({ name: "Dinsos Jakarta" })).toBeNull();
    expect(validateUserForm({ name: "Dinsos Jakarta", requestsPerMinute: "", maxConcurrentRequests: "" })).toBeNull();
  });

  it("rejects a non-positive or non-integer requestsPerMinute", () => {
    expect(validateUserForm({ name: "X", requestsPerMinute: 0 })).toBeTruthy();
    expect(validateUserForm({ name: "X", requestsPerMinute: -1 })).toBeTruthy();
    expect(validateUserForm({ name: "X", requestsPerMinute: 2.5 })).toBeTruthy();
    expect(validateUserForm({ name: "X", requestsPerMinute: "2.5" })).toBeTruthy();
  });

  it("rejects a non-positive or non-integer maxConcurrentRequests", () => {
    expect(validateUserForm({ name: "X", maxConcurrentRequests: 0 })).toBeTruthy();
    expect(validateUserForm({ name: "X", maxConcurrentRequests: -1 })).toBeTruthy();
  });

  it("accepts valid explicit limits (string, as form inputs produce)", () => {
    expect(validateUserForm({ name: "X", requestsPerMinute: "5", maxConcurrentRequests: "3" })).toBeNull();
  });
});

describe("UsersKeysTab: key revoked-state helper", () => {
  it("treats a null revokedAt as not revoked", () => {
    expect(isKeyRevoked({ revokedAt: null })).toBe(false);
  });

  it("treats a set revokedAt as revoked", () => {
    expect(isKeyRevoked({ revokedAt: "2026-08-01T00:00:00.000Z" })).toBe(true);
  });

  it("is defensive against a missing key", () => {
    expect(isKeyRevoked(undefined)).toBe(false);
  });
});

describe("UsersKeysTab: limits payload shaping (blank field = gateway default)", () => {
  // Review finding 1: handleSaveEdit used to send Number(editForm.x)
  // unconditionally, so clearing a limit field before saving an edit sent
  // 0 (Number("") === 0), which the server's validatePositiveInt rejects
  // with a 400 — an admin could never clear a limit while editing. Fix:
  // both handleCreateUser and handleSaveEdit now build their payload/patch
  // via this one shared helper.
  it("omits both fields when both are blank (edit form clearing both limits)", () => {
    expect(buildUserLimitsPayload({ requestsPerMinute: "", maxConcurrentRequests: "" })).toEqual({});
  });

  it("omits only the blanked field, keeping the other explicit and coerced to Number", () => {
    expect(buildUserLimitsPayload({ requestsPerMinute: "", maxConcurrentRequests: "3" })).toEqual({
      maxConcurrentRequests: 3,
    });
    expect(buildUserLimitsPayload({ requestsPerMinute: "5", maxConcurrentRequests: "" })).toEqual({
      requestsPerMinute: 5,
    });
  });

  it("includes both fields, coerced to Number, when both are set", () => {
    expect(buildUserLimitsPayload({ requestsPerMinute: "5", maxConcurrentRequests: "3" })).toEqual({
      requestsPerMinute: 5,
      maxConcurrentRequests: 3,
    });
  });

  it("never coerces a blank field to 0 (the exact bug: Number('') === 0)", () => {
    const payload = buildUserLimitsPayload({ requestsPerMinute: "", maxConcurrentRequests: "" });
    expect(payload).not.toHaveProperty("requestsPerMinute");
    expect(payload).not.toHaveProperty("maxConcurrentRequests");
  });
});

describe("UsersKeysTab: users fetch/mutate call shapes", () => {
  it("fetchGatewayUsers GETs with page/pageSize query params", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ users: [], pagination: {} }));
    await fetchGatewayUsers({ page: 2, pageSize: 5 });
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/users?page=2&pageSize=5");
  });

  it("createGatewayUser POSTs the exact payload", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ user: { id: "usr_new" } }, true, 201));
    await createGatewayUser({ name: "Dinsos Surabaya", requestsPerMinute: 5 });
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Dinsos Surabaya", requestsPerMinute: 5 }),
    });
  });

  it("updateGatewayUser PATCHes /api/bansos/users/[id] with the patch body", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ user: { id: "usr_1", isActive: false } }));
    await updateGatewayUser("usr_1", { isActive: false });
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/users/usr_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
  });
});

describe("UsersKeysTab: one-time key creation call shape", () => {
  it("fetchUserKeys GETs the user's keys with pagination", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ keys: [], pagination: {} }));
    await fetchUserKeys("usr_1", { page: 1, pageSize: 10 });
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/users/usr_1/keys?page=1&pageSize=10");
  });

  it("createUserKey POSTs { name } to /api/bansos/users/[id]/keys — the call that yields a one-time plaintext reveal", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ key: { id: "key_new", plaintext: "bns_aaaa" } }, true, 201)
    );
    const res = await createUserKey("usr_1", "prod");
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/users/usr_1/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "prod" }),
    });
    const body = await res.json();
    // OneTimeKeyModal.js only ever receives this plaintext through the
    // caller's transient `createdKey` state — it is never stored or
    // re-fetched (see OneTimeKeyModal.js's header comment).
    expect(body.key.plaintext).toBe("bns_aaaa");
  });
});

describe("UsersKeysTab: revoke/rotate action call shapes", () => {
  it("revokeUserKey issues a bodyless DELETE with userId as a query param", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ key: { id: "key_1", revokedAt: "2026-08-07T00:00:00.000Z" } }));
    await revokeUserKey("key_1", "usr_1");
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/keys/key_1?userId=usr_1", { method: "DELETE" });
  });

  it("rotateUserKey POSTs { userId, name } when a name is supplied — the call that yields a new one-time plaintext reveal", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ key: { id: "key_new", plaintext: "bns_bbbb" } })
    );
    await rotateUserKey("key_1", "usr_1", "prod-2");
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/keys/key_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "usr_1", name: "prod-2" }),
    });
  });

  it("rotateUserKey omits name from the body when not supplied (keeps existing name server-side)", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ key: { id: "key_new" } }));
    await rotateUserKey("key_1", "usr_1");
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/keys/key_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "usr_1" }),
    });
  });
});

// ── Usage & Logs tab ───────────────────────────────────────────────────────

describe("UsageLogsTab: prompt-expired state", () => {
  it("treats a null prompt as expired/erased", () => {
    expect(isPromptExpired({ prompt: null })).toBe(true);
  });

  it("treats a present prompt string as not expired, even if empty", () => {
    expect(isPromptExpired({ prompt: "hello" })).toBe(false);
    expect(isPromptExpired({ prompt: "" })).toBe(false);
  });

  it("is defensive against a missing audit row", () => {
    expect(isPromptExpired(undefined)).toBe(true);
  });
});

describe("UsageLogsTab: retention warning", () => {
  it("mentions the exact number of retention days", () => {
    expect(formatRetentionWarning(7)).toBe(
      "Prompt text is automatically and permanently erased 7 days after each request."
    );
  });

  it("uses singular 'day' for a 1-day retention window", () => {
    expect(formatRetentionWarning(1)).toBe(
      "Prompt text is automatically and permanently erased 1 day after each request."
    );
  });

  it("falls back to a no-retention message for zero/invalid input", () => {
    expect(formatRetentionWarning(0)).toBe("Prompt text is not retained for any of these requests.");
    expect(formatRetentionWarning(undefined)).toBe("Prompt text is not retained for any of these requests.");
    expect(formatRetentionWarning("not-a-number")).toBe("Prompt text is not retained for any of these requests.");
  });
});

describe("UsageLogsTab: requests query contract", () => {
  it("omits unset filters rather than passing empty strings through", () => {
    const params = buildRequestsParams({}, { page: 1, pageSize: 20 });
    expect(params.toString()).toBe("page=1&pageSize=20");
  });

  it("includes only the filters that were actually supplied", () => {
    const params = buildRequestsParams({ userId: "usr_1", status: "success" }, { page: 2, pageSize: 10 });
    expect(params.get("userId")).toBe("usr_1");
    expect(params.get("apiKeyId")).toBeNull();
    expect(params.get("status")).toBe("success");
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("10");
  });

  it("fetchPromptAudits GETs /api/bansos/requests with the built params", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ audits: [], pagination: {} }));
    await fetchPromptAudits({ userId: "usr_1" }, { page: 1, pageSize: 20 });
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/requests?userId=usr_1&page=1&pageSize=20");
  });
});

describe("UsageLogsTab: erasure action call shape", () => {
  it("eraseAuditPrompt issues a bodyless DELETE to /api/bansos/requests/[requestId]/prompt", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ requestId: "req_1", erased: true }));
    const res = await eraseAuditPrompt("req_1");
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/requests/req_1/prompt", { method: "DELETE" });
    const body = await res.json();
    expect(body.erased).toBe(true);
  });
});

// ── Settings tab ───────────────────────────────────────────────────────────

describe("SettingsTab: read-only hostname/model values", () => {
  it("declares exactly the documented read-only constants, with no edit control implied", () => {
    const keys = READ_ONLY_SETTINGS_FIELDS.map((f) => f.key);
    expect(keys).toEqual([
      "hostname",
      "publicModel",
      "internalModel",
      "promptRetentionDays",
      "maxPromptSize",
      "maxRequestBody",
      "firstResponseTimeoutMs",
      "maxStreamDurationMs",
    ]);
  });

  it("does not declare the mutable fields as read-only", () => {
    const keys = READ_ONLY_SETTINGS_FIELDS.map((f) => f.key);
    expect(keys).not.toContain("gatewayEnabled");
    expect(keys).not.toContain("defaultRequestsPerMinute");
    expect(keys).not.toContain("defaultMaxConcurrentRequests");
  });

  it("fetchGatewaySettings GETs /api/bansos/settings", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ hostname: "api.priaoslo.web.id" }));
    await fetchGatewaySettings();
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/settings");
  });
});

describe("SettingsTab: emergency switch behavior", () => {
  it("updateGatewayEnabled(false) PATCHes the kill switch off", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ gatewayEnabled: false }));
    await updateGatewayEnabled(false);
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bansosGatewayEnabled: false }),
    });
  });

  it("updateGatewayEnabled(true) PATCHes the kill switch on", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ gatewayEnabled: true }));
    await updateGatewayEnabled(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bansosGatewayEnabled: true }),
    });
  });
});

describe("SettingsTab: new-user default limits", () => {
  it("updateDefaultRequestsPerMinute PATCHes the exact allowlisted field", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ defaultRequestsPerMinute: 15 }));
    await updateDefaultRequestsPerMinute(15);
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bansosDefaultRequestsPerMinute: 15 }),
    });
  });

  it("updateDefaultMaxConcurrentRequests PATCHes the exact allowlisted field", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ defaultMaxConcurrentRequests: 4 }));
    await updateDefaultMaxConcurrentRequests(4);
    expect(fetchMock).toHaveBeenCalledWith("/api/bansos/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bansosDefaultMaxConcurrentRequests: 4 }),
    });
  });
});

describe("SettingsTab: debounced live-input gating (no PATCH per keystroke)", () => {
  // Review finding 2: handleRpmChange/handleConcurrencyChange used to call
  // updateDefaultRequestsPerMinute/updateDefaultMaxConcurrentRequests
  // directly on every onChange, so typing a two-digit value like "15"
  // fired a real PATCH persisting "1" for one round-trip before a second
  // PATCH corrected it to "15". Fix: SettingsTab.js now routes both
  // handlers through this debounce() wrapper (DEFAULT_LIMIT_DEBOUNCE_MS),
  // so only the final value after a pause in typing is ever sent.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not invoke the wrapped function synchronously", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, DEFAULT_LIMIT_DEBOUNCE_MS);
    debounced(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not fire until the full wait period has elapsed since the last call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, DEFAULT_LIMIT_DEBOUNCE_MS);
    debounced(1);
    vi.advanceTimersByTime(DEFAULT_LIMIT_DEBOUNCE_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("collapses rapid successive keystrokes into a single call with only the final value (the exact bug scenario: typing '1' then '15')", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, DEFAULT_LIMIT_DEBOUNCE_MS);
    debounced(1); // "1" typed
    vi.advanceTimersByTime(50);
    debounced(15); // "15" typed shortly after, before the debounce window closes
    vi.advanceTimersByTime(DEFAULT_LIMIT_DEBOUNCE_MS);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(15);
  });
});
