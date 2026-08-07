// Bansos Gateway — prompt retention cleanup (Task 11).
//
// Nulls the `prompt` column on bansosPromptAudit rows whose expiresAt has
// passed (7-day retention — see BANSOS_LIMITS.promptRetentionDays and
// startBansosPromptAudit in ./promptAudit.js, Task 10). The actual SQL
// sweep lives in clearExpiredBansosPrompts (src/lib/db/repos/bansosRepo.js,
// Task 1) — this module is a thin, fail-open scheduling wrapper around it:
// run a catch-up sweep shortly after boot, then hourly.
//
// Timer shape (unref'd handles, an initial short-delay pass so the first
// sweep doesn't wait a full period, a `started` idempotency guard, a
// fail-open tick that logs and swallows) deliberately mirrors
// src/sse/services/backgroundTokenRefresh.js. The one intentional
// deviation: singleton state lives on `global`, not on module-level `let`
// bindings, so it survives Next.js dev-mode hot module reload (which
// re-evaluates this module and would otherwise reset `let started = false`
// back to its initial value, letting a duplicate interval get scheduled on
// top of the one from before the reload. See
// src/shared/services/initializeApp.js's `global.__appSingleton` for the
// same pattern.
import { clearExpiredBansosPrompts } from "../db/index.js";

const HOURLY_MS = 60 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 1000;

const g = (global.__bansosRetentionSingleton ??= {
  started: false,
  intervalHandle: null,
  initialTimeoutHandle: null,
});

/**
 * Run one prompt-retention cleanup pass. Fail-open: never throws — errors
 * are logged and swallowed, returning 0 (nothing changed) instead of
 * rejecting, so a DB hiccup can never kill the scheduler or the caller.
 * @param {string} [nowIso] ISO timestamp compared against expiresAt; defaults to now.
 * @returns {Promise<number>} number of rows whose prompt was nulled.
 */
export async function runBansosPromptCleanup(nowIso) {
  const when = nowIso || new Date().toISOString();
  try {
    return await clearExpiredBansosPrompts(when);
  } catch (err) {
    console.warn("[BansosRetention] cleanup pass failed (swallowed):", err?.message || err);
    return 0;
  }
}

/**
 * Start the hourly prompt-retention scheduler. Runs a catch-up pass shortly
 * after boot (so already-expired prompts don't wait a full hour) and then
 * every `intervalMs`. Safe to call multiple times — a no-op if already
 * started, including across a hot reload (state lives on `global`).
 * @param {{ intervalMs?: number }} [opts]
 * @returns {boolean} true if started this call
 */
export function startBansosRetention({ intervalMs } = {}) {
  if (g.started) return false;
  g.started = true;

  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : HOURLY_MS;

  const safeTick = () => {
    runBansosPromptCleanup().catch((err) => {
      console.warn("[BansosRetention] unhandled tick rejection (swallowed):", err?.message || err);
    });
  };

  g.initialTimeoutHandle = setTimeout(safeTick, INITIAL_DELAY_MS);
  if (g.initialTimeoutHandle.unref) g.initialTimeoutHandle.unref();

  g.intervalHandle = setInterval(safeTick, period);
  if (g.intervalHandle.unref) g.intervalHandle.unref();

  console.log("[BansosRetention] scheduler started", { intervalMs: period, initialDelayMs: INITIAL_DELAY_MS });
  return true;
}

/** Stop the scheduler and clear both timer handles. Safe to call anytime. */
export function stopBansosRetention() {
  if (g.initialTimeoutHandle) {
    clearTimeout(g.initialTimeoutHandle);
    g.initialTimeoutHandle = null;
  }
  if (g.intervalHandle) {
    clearInterval(g.intervalHandle);
    g.intervalHandle = null;
  }
  if (g.started) {
    g.started = false;
    console.log("[BansosRetention] scheduler stopped");
  }
}
