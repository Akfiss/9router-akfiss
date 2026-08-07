// Bansos Gateway — per-user rate + concurrency limiter (Task 6).
//
// Pure, in-memory, single-process limiter. No database, no network, no I/O,
// no dependency on any other task's runtime code. It has no notion of a
// Bansos API "key" at all — only `userId`. A user can own multiple Bansos
// keys, and the limits below are shared across every key that user owns;
// the caller is responsible for resolving a key to its owning userId before
// calling in here (Task 8's job, not this module's).
//
// Two independent limits, both scoped per userId:
//   - RPM: a rolling 60-second window of *accepted* request timestamps.
//     Rejected acquisitions never add a timestamp — only successful
//     acquisitions consume budget.
//   - Concurrency: a set of active "leases", one per in-flight request.
//     `acquireBansosChat` returns a `release()` closure that must be called
//     when the request finishes; a 10-minute unref'd safety timer
//     force-releases any lease whose caller never calls `release()` (e.g. a
//     crashed handler), so a single bad request can't permanently eat a
//     concurrency slot.
//
// `createBansosLimiter({ now, setTimer, clearTimer })` is the testable
// factory: tests inject a fake clock and fake timer registry for fully
// deterministic control (see tests/unit/bansos-rate-limiter.test.js). The
// named exports below (`acquireBansosChat`, `getBansosLimiterSnapshot`,
// `resetBansosLimiterForTests`) are a singleton built from real
// Date.now/setTimeout/clearTimeout — production code just imports and calls
// those directly.
import { BANSOS_LIMITS } from "./constants.js";

const ROLLING_WINDOW_MS = 60 * 1000;

// Reuses Task 3's "how long can a Bansos request legitimately run" constant
// as "how long before we assume an unreleased lease was abandoned" so the
// two numbers can't silently drift apart if either changes later.
const ORPHAN_RELEASE_MS = BANSOS_LIMITS.maxStreamDurationMs;

// Concurrency denials have no fixed timer the way RPM denials do (a slot
// frees whenever *any* in-flight request finishes, which is unpredictable).
// This is a reasonable fixed fallback for Retry-After, not a spec-mandated
// value — see task-6-report.md for the reasoning.
const CONCURRENCY_RETRY_AFTER_SECONDS = 1;

/**
 * Create an isolated limiter instance. Every call gets its own in-memory
 * state — nothing is shared across instances (tests rely on this for
 * isolation; production relies on it existing exactly once as the module
 * singleton below).
 *
 * @param {object} deps
 * @param {() => number} [deps.now] - current time in ms. Default: Date.now.
 * @param {(fn: Function, delayMs: number) => *} [deps.setTimer] - mirrors
 *   setTimeout; returns an opaque handle. Default: real setTimeout.
 * @param {(handle: *) => void} [deps.clearTimer] - mirrors clearTimeout.
 *   Default: real clearTimeout.
 */
export function createBansosLimiter({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  /** @type {Map<string, { timestamps: number[], leases: Map<number, *> }>} */
  let usersState = new Map();
  let nextLeaseId = 1;

  function getOrCreateUser(userId) {
    let user = usersState.get(userId);
    if (!user) {
      user = { timestamps: [], leases: new Map() };
      usersState.set(userId, user);
    }
    return user;
  }

  // Drops any tracked timestamp that has aged out of the rolling 60s
  // window. Mutates `user.timestamps` in place.
  function pruneWindow(user, currentTime) {
    const cutoff = currentTime - ROLLING_WINDOW_MS;
    let dropCount = 0;
    while (dropCount < user.timestamps.length && user.timestamps[dropCount] <= cutoff) {
      dropCount++;
    }
    if (dropCount > 0) {
      user.timestamps.splice(0, dropCount);
    }
  }

  /**
   * Attempt to acquire both an RPM slot and a concurrency lease for
   * `userId`. Only an accepted call records a timestamp / holds a lease —
   * a rejected call is side-effect-free w.r.t. the limits it didn't need.
   *
   * @param {string} userId
   * @param {{ requestsPerMinute: number, maxConcurrentRequests: number }} limits
   * @returns {{ ok: true, release: () => void } | { ok: false, reason: string, retryAfterSeconds: number | null }}
   */
  function acquireBansosChat(userId, { requestsPerMinute, maxConcurrentRequests } = {}) {
    const currentTime = now();
    const user = getOrCreateUser(userId);

    pruneWindow(user, currentTime);

    if (user.timestamps.length >= requestsPerMinute) {
      const oldest = user.timestamps.length > 0 ? user.timestamps[0] : currentTime;
      const retryAfterSeconds = Math.max(
        0,
        Math.ceil((oldest + ROLLING_WINDOW_MS - currentTime) / 1000)
      );
      return { ok: false, reason: "rpm_limit_exceeded", retryAfterSeconds };
    }

    if (user.leases.size >= maxConcurrentRequests) {
      return {
        ok: false,
        reason: "concurrency_limit_exceeded",
        retryAfterSeconds: CONCURRENCY_RETRY_AFTER_SECONDS,
      };
    }

    // Accepted: consume one RPM slot and hold one concurrency lease.
    user.timestamps.push(currentTime);

    const leaseId = nextLeaseId++;
    let released = false;

    const timerHandle = setTimer(() => {
      // Orphan safety net: the caller never released this lease (e.g. a
      // crashed/hung handler). Force-release so the slot isn't leaked
      // forever.
      release();
    }, ORPHAN_RELEASE_MS);
    // Real setTimeout handles support .unref(); injected fake handles in
    // tests may not — never assume every timer handle looks like Node's.
    timerHandle?.unref?.();

    user.leases.set(leaseId, timerHandle);

    function release() {
      if (released) return;
      released = true;
      user.leases.delete(leaseId);
      clearTimer(timerHandle);
    }

    return { ok: true, release };
  }

  /**
   * Snapshot of current in-memory state, keyed by userId:
   *   { users: { [userId]: { activeLeases: number, windowRequestCount: number } } }
   * `activeLeases` is the current concurrency-lease count; `windowRequestCount`
   * is the number of accepted-request timestamps still inside the rolling
   * 60s window as of `now()` — pruning is applied before it's reported, so
   * this reflects the count that the *next* acquisition would actually see.
   */
  function getBansosLimiterSnapshot() {
    const currentTime = now();
    const users = {};
    for (const [userId, user] of usersState.entries()) {
      pruneWindow(user, currentTime);
      users[userId] = {
        activeLeases: user.leases.size,
        windowRequestCount: user.timestamps.length,
      };
    }
    return { users };
  }

  /**
   * Test-only: wipe all in-memory state for this instance, clearing any
   * pending orphan-release timers first so none of them can fire against
   * state that no longer exists.
   */
  function resetBansosLimiterForTests() {
    for (const user of usersState.values()) {
      for (const timerHandle of user.leases.values()) {
        clearTimer(timerHandle);
      }
    }
    usersState = new Map();
    nextLeaseId = 1;
  }

  return { acquireBansosChat, getBansosLimiterSnapshot, resetBansosLimiterForTests };
}

// Production singleton: real clock, real timers. All application code
// should import the named functions below rather than calling
// createBansosLimiter() itself (that's reserved for tests that need
// isolated, fake-clock-driven instances).
const singleton = createBansosLimiter({
  now: Date.now,
  setTimer: setTimeout,
  clearTimer: clearTimeout,
});

export const acquireBansosChat = singleton.acquireBansosChat;
export const getBansosLimiterSnapshot = singleton.getBansosLimiterSnapshot;
export const resetBansosLimiterForTests = singleton.resetBansosLimiterForTests;
