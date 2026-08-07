// Pure/data-fetch contract behind OverviewTab.js — kept in a sibling module
// with zero JSX so it can be imported directly by vitest. This project's
// test transform (tests/vitest.config.js, plain esbuild "js" loader) cannot
// parse JSX inside a .js file at all — even to reach an unrelated named
// export — so this logic can't live inside OverviewTab.js itself and still
// be unit-testable. OverviewTab.js imports and uses these; nothing here is
// test-only or mirrored.

// Kill-switch check (absence of the field means enabled — see
// src/app/api/bansos/settings/route.js's toResponseShape).
export function isGatewayUnavailable(settings) {
  return !!settings && settings.gatewayEnabled === false;
}

export function buildBansosBaseUrl(hostname) {
  return hostname ? `https://${hostname}/v1` : "";
}

export async function fetchBansosSettings() {
  const res = await fetch("/api/bansos/settings");
  return res.json();
}

// probe=true triggers a live network call to the public host on the server
// (see src/app/api/bansos/overview/route.js) — only pass true from an
// explicit "Test connectivity" action, never from a polling effect.
export async function fetchBansosOverview(probe = false) {
  const url = probe ? "/api/bansos/overview?probe=true" : "/api/bansos/overview";
  const res = await fetch(url);
  return res.json();
}
