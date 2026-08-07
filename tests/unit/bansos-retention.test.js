// Bansos Gateway — prompt retention cleanup scheduler (Task 11).
//
// Proves `src/lib/bansos/retention.js`'s three exports:
//   - runBansosPromptCleanup(nowIso?): a thin, fail-open wrapper around
//     the repo's clearExpiredBansosPrompts (Task 1's territory — exercised
//     for real here via a temp DB, matching bansos-repo.test.js's
//     convention) that defaults nowIso to "now" when omitted.
//   - startBansosRetention()/stopBansosRetention(): a background scheduler
//     that runs a catch-up pass shortly after boot, then hourly, matching
//     backgroundTokenRefresh.js's shape (unref'd timers, idempotent start,
//     fail-open tick) — but with singleton state anchored on `global` (not
//     module-level `let`) so it survives Next.js hot module reload.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const HOURLY_MS = 60 * 60 * 1000;

// ── runBansosPromptCleanup — real temp DB (mirrors bansos-repo.test.js) ────
describe("runBansosPromptCleanup", () => {
  let tempDir;
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bansos-retention-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch { /* ignore */ }
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  function baseAudit(overrides = {}) {
    return {
      requestId: `req-${Math.random().toString(36).slice(2)}`,
      userId: "u1",
      apiKeyId: "k1",
      publicModel: "public-model",
      internalModel: "internal-model",
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      ...overrides,
    };
  }

  it("nulls only prompts past expiresAt, leaves current prompts intact, and is idempotent on a second sweep", async () => {
    const db = await import("@/lib/db/index.js");
    const { runBansosPromptCleanup } = await import("@/lib/bansos/retention.js");

    const past = await db.insertBansosPromptAudit(baseAudit({
      prompt: "old prompt", expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    const future = await db.insertBansosPromptAudit(baseAudit({
      prompt: "fresh prompt", expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }));

    const now = new Date().toISOString();
    const firstPass = await runBansosPromptCleanup(now);
    expect(firstPass).toBe(1);

    const { audits } = await db.listBansosPromptAudits({ pageSize: 100 });
    const pastRow = audits.find((a) => a.requestId === past.requestId);
    const futureRow = audits.find((a) => a.requestId === future.requestId);
    expect(pastRow.prompt).toBeNull();
    expect(futureRow.prompt).toBe("fresh prompt");

    // Second sweep against the same cutoff: nothing left to clear.
    const secondPass = await runBansosPromptCleanup(now);
    expect(secondPass).toBe(0);
  });

  it("defaults nowIso to the current time when omitted", async () => {
    const db = await import("@/lib/db/index.js");
    const { runBansosPromptCleanup } = await import("@/lib/bansos/retention.js");

    const expired = await db.insertBansosPromptAudit(baseAudit({
      prompt: "old prompt", expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));

    const changed = await runBansosPromptCleanup();
    expect(changed).toBe(1);

    const { audits } = await db.listBansosPromptAudits({ pageSize: 100 });
    const row = audits.find((a) => a.requestId === expired.requestId);
    expect(row.prompt).toBeNull();
  });
});

// ── runBansosPromptCleanup — fail-open ──────────────────────────────────
describe("runBansosPromptCleanup — fail-open behavior", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/db/index.js");
    vi.resetModules();
  });

  it("does not throw and resolves to 0 when the repo layer rejects", async () => {
    vi.doMock("@/lib/db/index.js", () => ({
      clearExpiredBansosPrompts: vi.fn().mockRejectedValue(new Error("db exploded")),
    }));

    const { runBansosPromptCleanup } = await import("@/lib/bansos/retention.js");

    await expect(runBansosPromptCleanup()).resolves.toBe(0);
  });

  it("does not throw when the repo layer throws synchronously", async () => {
    vi.doMock("@/lib/db/index.js", () => ({
      clearExpiredBansosPrompts: vi.fn(() => { throw new Error("db exploded sync"); }),
    }));

    const { runBansosPromptCleanup } = await import("@/lib/bansos/retention.js");

    await expect(runBansosPromptCleanup()).resolves.toBe(0);
  });
});

// ── startBansosRetention / stopBansosRetention — timer wiring ──────────
describe("startBansosRetention / stopBansosRetention — timer wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    delete global.__bansosRetentionSingleton;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete global.__bansosRetentionSingleton;
  });

  it("schedules an initial catch-up timeout and an hourly interval, unref'ing both", async () => {
    const timeoutUnref = vi.fn();
    const intervalUnref = vi.fn();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockReturnValue({ unref: timeoutUnref });
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue({ unref: intervalUnref });

    const { startBansosRetention } = await import("@/lib/bansos/retention.js");
    const started = startBansosRetention();

    expect(started).toBe(true);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(HOURLY_MS);
    expect(timeoutUnref).toHaveBeenCalledTimes(1);
    expect(intervalUnref).toHaveBeenCalledTimes(1);
  });

  it("honors a custom intervalMs override", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue({ unref: vi.fn() });
    vi.spyOn(global, "setTimeout").mockReturnValue({ unref: vi.fn() });

    const { startBansosRetention } = await import("@/lib/bansos/retention.js");
    startBansosRetention({ intervalMs: 5000 });

    expect(setIntervalSpy.mock.calls[0][1]).toBe(5000);
  });

  it("is idempotent: a second start() call is a no-op and schedules no new timers", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue({ unref: vi.fn() });
    const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockReturnValue({ unref: vi.fn() });

    const { startBansosRetention } = await import("@/lib/bansos/retention.js");
    expect(startBansosRetention()).toBe(true);
    expect(startBansosRetention()).toBe(false);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("stop() clears both handles, and a fresh start() afterward schedules new timers", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue({ unref: vi.fn() });
    vi.spyOn(global, "setTimeout").mockReturnValue({ unref: vi.fn() });

    const { startBansosRetention, stopBansosRetention } = await import("@/lib/bansos/retention.js");
    startBansosRetention();
    stopBansosRetention();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    expect(startBansosRetention()).toBe(true);
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it("stop() is safe to call when never started (no-op, does not throw)", async () => {
    const { stopBansosRetention } = await import("@/lib/bansos/retention.js");
    expect(() => stopBansosRetention()).not.toThrow();
  });

  it("singleton state survives module re-evaluation (simulated hot reload)", async () => {
    vi.spyOn(global, "setTimeout").mockReturnValue({ unref: vi.fn() });
    vi.spyOn(global, "setInterval").mockReturnValue({ unref: vi.fn() });

    const mod1 = await import("@/lib/bansos/retention.js");
    expect(mod1.startBansosRetention()).toBe(true);

    // Simulate Next.js dev-mode HMR: the module is re-evaluated, which would
    // reset any plain module-level `let` bindings back to their initial
    // values. Global-anchored state must survive this.
    vi.resetModules();

    const mod2 = await import("@/lib/bansos/retention.js");
    expect(mod2.startBansosRetention()).toBe(false);

    mod2.stopBansosRetention();
  });
});

// ── startBansosRetention — tick actually fires the cleanup ──────────────
describe("startBansosRetention — tick behavior (real fake-timer scheduling)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    delete global.__bansosRetentionSingleton;
  });

  afterEach(async () => {
    const mod = await import("@/lib/bansos/retention.js");
    mod.stopBansosRetention();
    vi.doUnmock("@/lib/db/index.js");
    vi.useRealTimers();
    vi.resetModules();
    delete global.__bansosRetentionSingleton;
  });

  it("runs a catch-up cleanup shortly after start, then again after an hour", async () => {
    const clearExpiredBansosPrompts = vi.fn().mockResolvedValue(0);
    vi.doMock("@/lib/db/index.js", () => ({ clearExpiredBansosPrompts }));

    const { startBansosRetention } = await import("@/lib/bansos/retention.js");
    startBansosRetention();

    // Catch-up pass fires well before a full hour elapses.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clearExpiredBansosPrompts).toHaveBeenCalledTimes(1);

    // Hourly interval fires once more after a full period.
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    expect(clearExpiredBansosPrompts).toHaveBeenCalledTimes(2);
  });

  it("does not throw and keeps ticking even when a pass rejects", async () => {
    const clearExpiredBansosPrompts = vi.fn().mockRejectedValue(new Error("db down"));
    vi.doMock("@/lib/db/index.js", () => ({ clearExpiredBansosPrompts }));

    const { startBansosRetention } = await import("@/lib/bansos/retention.js");
    startBansosRetention();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(clearExpiredBansosPrompts).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    expect(clearExpiredBansosPrompts).toHaveBeenCalledTimes(2);
  });
});
