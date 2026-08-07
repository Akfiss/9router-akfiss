// Pure tab-routing contract behind page.js — kept in a sibling module with
// zero JSX so it can be imported directly by vitest (this project's test
// transform can't parse JSX inside a .js file at all — see
// src/shared/components/Header.pageInfo.js for the same constraint).
// page.js imports and uses these; nothing here is test-only or mirrored.
export const BANSOS_TABS = ["overview", "users", "logs", "settings"];

export function resolveBansosTab(tabFromUrl) {
  return BANSOS_TABS.includes(tabFromUrl) ? tabFromUrl : "overview";
}
