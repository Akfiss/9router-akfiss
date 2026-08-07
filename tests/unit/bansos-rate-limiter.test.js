// Bansos Gateway per-user rate + concurrency limiter (Task 6).
//
// Pure, in-memory, single-process limiter. No database, no network, no
// dependency on any other task's runtime code. Tracks, per Bansos userId
// (never per-key — a user's limits are shared across every key they own):
//   - a rolling 60-second window of accepted request timestamps (RPM)
//   - a set of active concurrency leases
//
// These tests use a fully fake clock (`now`) and fake timer registry
// (`setTimer`/`clearTimer`) injected via `createBansosLimiter(...)` so every
// scenario — including the 10-minute orphan-release safety timer — is
// deterministic with zero real waiting.
import { describe, it, expect, beforeEach } from "vitest";
import { createBansosLimiter } from "../../src/lib/bansos/rateLimiter.js";

/**
 * A minimal fake timer registry mirroring setTimeout/clearTimeout, but
 * fully controlled by the test: callbacks only run when the test explicitly
 * fires them (`fireAll`), never on a real wall-clock delay. The returned
 * handle is a plain object *without* an `.unref` method, deliberately — this
 * proves the limiter guards the unref call (`handle?.unref?.()`) rather than
 * assuming every injected timer handle looks like a real Node Timeout.
 */
function createFakeTimers() {
  let nextId = 1;
  const scheduled = new Map(); // id -> { fn, delay }

  return {
    setTimer(fn, delay) {
      const id = nextId++;
      scheduled.set(id, { fn, delay });
      return { id };
    },
    clearTimer(handle) {
      if (handle && typeof handle.id !== "undefined") {
        scheduled.delete(handle.id);
      }
    },
    // Fires every currently-scheduled callback (simulates "enough time
    // passed for the orphan timer to fire") and clears them.
    fireAll() {
      const entries = [...scheduled.entries()];
      for (const [id] of entries) scheduled.delete(id);
      for (const [, entry] of entries) entry.fn();
    },
    pendingCount() {
      return scheduled.size;
    },
  };
}

function makeLimiter() {
  let currentTime = 0;
  const timers = createFakeTimers();
  const limiter = createBansosLimiter({
    now: () => currentTime,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return {
    ...limiter,
    timers,
    advance(ms) {
      currentTime += ms;
    },
    setTime(ms) {
      currentTime = ms;
    },
  };
}

describe("bansos rate limiter", () => {
  describe("rolling 60s window across two keys sharing one userId", () => {
    it("shares the RPM window across calls with the same userId regardless of which key made them", () => {
      const limiter = makeLimiter();
      const userId = "user-1";
      const limits = { requestsPerMinute: 10, maxConcurrentRequests: 100 };

      // Simulate two different Bansos API keys owned by the same user: the
      // limiter has no notion of "key" at all, so this is just N calls with
      // the same userId, releasing immediately each time (isolating RPM
      // behavior from concurrency behavior in this scenario).
      for (let i = 0; i < 10; i++) {
        const result = limiter.acquireBansosChat(userId, limits);
        expect(result.ok).toBe(true);
        result.release();
      }

      expect(limiter.getBansosLimiterSnapshot().users[userId].windowRequestCount).toBe(10);

      // 11th within the same instant is over budget.
      const denied = limiter.acquireBansosChat(userId, limits);
      expect(denied.ok).toBe(false);
      expect(denied.reason).toBe("rpm_limit_exceeded");

      // Advance past the 60s window: every prior timestamp ages out and the
      // user gets a fresh budget.
      limiter.advance(60_001);
      const afterWindow = limiter.acquireBansosChat(userId, limits);
      expect(afterWindow.ok).toBe(true);
      expect(limiter.getBansosLimiterSnapshot().users[userId].windowRequestCount).toBe(1);
    });
  });

  describe("11th accepted request within a rolling 60s window", () => {
    it("denies the 11th request when requestsPerMinute is 10, without recording a new timestamp", () => {
      const limiter = makeLimiter();
      const userId = "user-2";
      const limits = { requestsPerMinute: 10, maxConcurrentRequests: 100 };

      for (let i = 0; i < 10; i++) {
        expect(limiter.acquireBansosChat(userId, limits).ok).toBe(true);
      }

      const before = limiter.getBansosLimiterSnapshot().users[userId].windowRequestCount;
      expect(before).toBe(10);

      const denied = limiter.acquireBansosChat(userId, limits);
      expect(denied.ok).toBe(false);
      expect(denied.reason).toBe("rpm_limit_exceeded");
      expect(typeof denied.retryAfterSeconds).toBe("number");

      // A rejected acquisition must NOT consume an RPM slot.
      const after = limiter.getBansosLimiterSnapshot().users[userId].windowRequestCount;
      expect(after).toBe(10);
    });

    it("computes retryAfterSeconds from how long until the oldest timestamp ages out", () => {
      const limiter = makeLimiter();
      const userId = "user-3";
      const limits = { requestsPerMinute: 10, maxConcurrentRequests: 100 };

      for (let i = 0; i < 10; i++) {
        expect(limiter.acquireBansosChat(userId, limits).ok).toBe(true);
      }

      // No time has passed: the oldest timestamp (t=0) ages out in exactly 60s.
      const deniedAtT0 = limiter.acquireBansosChat(userId, limits);
      expect(deniedAtT0.ok).toBe(false);
      expect(deniedAtT0.retryAfterSeconds).toBe(60);

      // 10s later, the oldest timestamp is 50s from aging out.
      limiter.advance(10_000);
      const deniedAtT10 = limiter.acquireBansosChat(userId, limits);
      expect(deniedAtT10.ok).toBe(false);
      expect(deniedAtT10.retryAfterSeconds).toBe(50);
    });
  });

  describe("3rd concurrent request while first two are held", () => {
    it("denies a 3rd concurrent acquisition when maxConcurrentRequests is 2", () => {
      const limiter = makeLimiter();
      const userId = "user-4";
      const limits = { requestsPerMinute: 100, maxConcurrentRequests: 2 };

      const first = limiter.acquireBansosChat(userId, limits);
      const second = limiter.acquireBansosChat(userId, limits);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(limiter.getBansosLimiterSnapshot().users[userId].activeLeases).toBe(2);

      const third = limiter.acquireBansosChat(userId, limits);
      expect(third.ok).toBe(false);
      expect(third.reason).toBe("concurrency_limit_exceeded");

      // A concurrency-rejected acquisition must not consume an RPM slot either.
      expect(limiter.getBansosLimiterSnapshot().users[userId].windowRequestCount).toBe(2);

      // Freeing a slot lets a new acquisition through.
      first.release();
      expect(limiter.getBansosLimiterSnapshot().users[userId].activeLeases).toBe(1);
      const fourth = limiter.acquireBansosChat(userId, limits);
      expect(fourth.ok).toBe(true);
    });
  });

  describe("idempotent release", () => {
    it("is a no-op the second time release() is called", () => {
      const limiter = makeLimiter();
      const userId = "user-5";
      const limits = { requestsPerMinute: 100, maxConcurrentRequests: 1 };

      const { ok, release } = limiter.acquireBansosChat(userId, limits);
      expect(ok).toBe(true);
      expect(limiter.getBansosLimiterSnapshot().users[userId].activeLeases).toBe(1);

      release();
      expect(limiter.getBansosLimiterSnapshot().users[userId].activeLeases).toBe(0);

      // Calling it again must not decrement past zero (which would corrupt
      // future concurrency accounting) and must not throw.
      expect(() => release()).not.toThrow();
      expect(limiter.getBansosLimiterSnapshot().users[userId].activeLeases).toBe(0);

      // A fresh acquisition after the double-release still respects the limit.
      const next = limiter.acquireBansosChat(userId, limits);
      expect(next.ok).toBe(true);
    });

    it("clears the orphan-release timer on release so it never fires against an already-released lease", () => {
      const limiter = makeLimiter();
      const userId = "user-6";
      const limits = { requestsPerMinute: 100, maxConcurrentRequests: 1 };

      const { release } = limiter.acquireBansosChat(userId, limits);
      expect(limiter.timers.pendingCount()).toBe(1);

      release();
      expect(limiter.timers.pendingCount()).toBe(0);
    });
  });

  describe("safety expiration (orphan-release timer)", () => {
    it("force-releases an abandoned lease once the orphan timer fires, freeing the concurrency slot", () => {
      const limiter = makeLimiter();
      const userId = "user-7";
      const limits = { requestsPerMinute: 100, maxConcurrentRequests: 1 };

      const acquired = limiter.acquireBansosChat(userId, limits);
      expect(acquired.ok).toBe(true);
      expect(limiter.getBansosLimiterSnapshot().users[userId].activeLeases).toBe(1);

      // Caller never calls release() — simulate an abandoned/crashed request.
      // Advance the fake clock for realism, then fire the fake orphan timer.
      limiter.advance(10 * 60 * 1000);
      limiter.timers.fireAll();

      expect(limiter.getBansosLimiterSnapshot().users[userId].activeLeases).toBe(0);

      // The slot is free again.
      const next = limiter.acquireBansosChat(userId, limits);
      expect(next.ok).toBe(true);
    });

    it("does not double-release if the caller releases manually after the orphan timer already fired", () => {
      const limiter = makeLimiter();
      const userId = "user-8";
      const limits = { requestsPerMinute: 100, maxConcurrentRequests: 1 };

      const { release } = limiter.acquireBansosChat(userId, limits);
      limiter.timers.fireAll();
      expect(limiter.getBansosLimiterSnapshot().users[userId].activeLeases).toBe(0);

      expect(() => release()).not.toThrow();
      expect(limiter.getBansosLimiterSnapshot().users[userId].activeLeases).toBe(0);
    });
  });

  describe("fresh limiter instances and reset", () => {
    it("gives each createBansosLimiter() call fully isolated state", () => {
      const limiterA = makeLimiter();
      const limiterB = makeLimiter();
      const userId = "user-9";
      const limits = { requestsPerMinute: 10, maxConcurrentRequests: 2 };

      limiterA.acquireBansosChat(userId, limits);
      limiterA.acquireBansosChat(userId, limits);

      expect(limiterA.getBansosLimiterSnapshot().users[userId].activeLeases).toBe(2);
      // limiterB has never seen this userId — no cross-instance leakage.
      expect(limiterB.getBansosLimiterSnapshot().users[userId]).toBeUndefined();
    });

    it("resetBansosLimiterForTests() clears all in-memory state for that instance", () => {
      const limiter = makeLimiter();
      const userId = "user-10";
      const limits = { requestsPerMinute: 10, maxConcurrentRequests: 2 };

      limiter.acquireBansosChat(userId, limits);
      limiter.acquireBansosChat(userId, limits);
      expect(limiter.getBansosLimiterSnapshot().users[userId].activeLeases).toBe(2);
      expect(limiter.timers.pendingCount()).toBe(2);

      limiter.resetBansosLimiterForTests();

      expect(limiter.getBansosLimiterSnapshot().users[userId]).toBeUndefined();
      // Pending orphan timers for the wiped-out leases must be cleared too,
      // so they can never fire against state that no longer exists.
      expect(limiter.timers.pendingCount()).toBe(0);

      // The user can acquire fresh leases up to the full limit again.
      const first = limiter.acquireBansosChat(userId, limits);
      const second = limiter.acquireBansosChat(userId, limits);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
    });
  });

  describe("singleton exports", () => {
    it("exposes acquireBansosChat, getBansosLimiterSnapshot, and resetBansosLimiterForTests as a module-level singleton", async () => {
      const mod = await import("../../src/lib/bansos/rateLimiter.js");
      expect(typeof mod.acquireBansosChat).toBe("function");
      expect(typeof mod.getBansosLimiterSnapshot).toBe("function");
      expect(typeof mod.resetBansosLimiterForTests).toBe("function");

      mod.resetBansosLimiterForTests();
      const result = mod.acquireBansosChat("singleton-user", {
        requestsPerMinute: 5,
        maxConcurrentRequests: 1,
      });
      expect(result.ok).toBe(true);
      result.release();
      mod.resetBansosLimiterForTests();
    });
  });
});
