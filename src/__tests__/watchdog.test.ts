import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  recordResult,
  abortReason,
  clearSession,
  startSession,
  parseWatchdogConfig,
  injectClock,
  resetClock,
  DEFAULT_WATCHDOG_CONFIG,
  TIMEOUT_EXIT_CODE,
  type WatchdogConfig,
} from "../watchdog";

const SESSION = "test-session-abc";
const DISABLED: WatchdogConfig = { maxConsecutiveTimeouts: null, maxRuntimeSeconds: null };

beforeEach(() => {
  clearSession(SESSION);
  resetClock();
});

afterEach(() => {
  resetClock();
});

// --- parseWatchdogConfig ---

describe("parseWatchdogConfig", () => {
  it("returns defaults for missing input", () => {
    expect(parseWatchdogConfig(undefined)).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(parseWatchdogConfig(null)).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(parseWatchdogConfig({})).toEqual(DEFAULT_WATCHDOG_CONFIG);
  });

  it("parses valid maxConsecutiveTimeouts", () => {
    expect(parseWatchdogConfig({ maxConsecutiveTimeouts: 3 }).maxConsecutiveTimeouts).toBe(3);
  });

  it("rejects non-integer or non-positive maxConsecutiveTimeouts", () => {
    expect(parseWatchdogConfig({ maxConsecutiveTimeouts: -1 }).maxConsecutiveTimeouts).toBeNull();
    expect(parseWatchdogConfig({ maxConsecutiveTimeouts: 0 }).maxConsecutiveTimeouts).toBeNull();
    expect(parseWatchdogConfig({ maxConsecutiveTimeouts: 1.5 }).maxConsecutiveTimeouts).toBeNull();
    expect(parseWatchdogConfig({ maxConsecutiveTimeouts: "3" }).maxConsecutiveTimeouts).toBeNull();
  });

  it("parses valid maxRuntimeSeconds", () => {
    expect(parseWatchdogConfig({ maxRuntimeSeconds: 3600 }).maxRuntimeSeconds).toBe(3600);
  });

  it("rejects non-positive or non-finite maxRuntimeSeconds", () => {
    expect(parseWatchdogConfig({ maxRuntimeSeconds: 0 }).maxRuntimeSeconds).toBeNull();
    expect(parseWatchdogConfig({ maxRuntimeSeconds: -60 }).maxRuntimeSeconds).toBeNull();
    expect(parseWatchdogConfig({ maxRuntimeSeconds: Infinity }).maxRuntimeSeconds).toBeNull();
    expect(parseWatchdogConfig({ maxRuntimeSeconds: null }).maxRuntimeSeconds).toBeNull();
  });
});

// --- disabled config ---

describe("abortReason (disabled)", () => {
  it("never triggers when both limits are null", () => {
    startSession(SESSION);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    expect(abortReason(SESSION, DISABLED)).toBeNull();
  });

  it("returns null for an untracked session ID", () => {
    expect(abortReason("no-such-session", DISABLED)).toBeNull();
  });
});

// --- consecutive timeout tracking ---

describe("maxConsecutiveTimeouts", () => {
  const cfg: WatchdogConfig = { maxConsecutiveTimeouts: 3, maxRuntimeSeconds: null };

  it("does not abort before limit is reached", () => {
    startSession(SESSION);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    expect(abortReason(SESSION, cfg)).toBeNull();
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    expect(abortReason(SESSION, cfg)).toBeNull();
  });

  it("aborts exactly at the limit", () => {
    startSession(SESSION);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    expect(abortReason(SESSION, cfg)).toMatch(/3 consecutive timeouts/);
  });

  it("resets the counter on a successful exit", () => {
    startSession(SESSION);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    recordResult(SESSION, 0);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    expect(abortReason(SESSION, cfg)).toBeNull();
  });

  it("resets on any non-timeout exit code", () => {
    startSession(SESSION);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    recordResult(SESSION, 1);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    expect(abortReason(SESSION, cfg)).toBeNull();
  });
});

// --- clearSession ---

describe("clearSession", () => {
  it("removes accumulated state so abortReason returns null", () => {
    const cfg: WatchdogConfig = { maxConsecutiveTimeouts: 2, maxRuntimeSeconds: null };
    startSession(SESSION);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    recordResult(SESSION, TIMEOUT_EXIT_CODE);
    expect(abortReason(SESSION, cfg)).toMatch(/consecutive timeouts/);
    clearSession(SESSION);
    expect(abortReason(SESSION, cfg)).toBeNull();
  });
});

// --- maxRuntimeSeconds with injected clock ---

describe("maxRuntimeSeconds", () => {
  it("does not abort if session has not started", () => {
    const cfg: WatchdogConfig = { maxConsecutiveTimeouts: null, maxRuntimeSeconds: 1 };
    expect(abortReason(SESSION, cfg)).toBeNull();
  });

  it("does not abort before limit is reached", () => {
    let fakeNow = 0;
    injectClock(() => fakeNow);
    const cfg: WatchdogConfig = { maxConsecutiveTimeouts: null, maxRuntimeSeconds: 3600 };
    startSession(SESSION);
    fakeNow = 1000 * 1000; // 1000 seconds
    expect(abortReason(SESSION, cfg)).toBeNull();
  });

  it("aborts when elapsed time reaches the limit", () => {
    let fakeNow = 0;
    injectClock(() => fakeNow);
    const cfg: WatchdogConfig = { maxConsecutiveTimeouts: null, maxRuntimeSeconds: 60 };
    startSession(SESSION);
    fakeNow = 60_001; // 60.001 seconds
    expect(abortReason(SESSION, cfg)).toMatch(/exceeded maximum runtime/);
  });

  it("includes elapsed and limit in the abort message", () => {
    let fakeNow = 0;
    injectClock(() => fakeNow);
    const cfg: WatchdogConfig = { maxConsecutiveTimeouts: null, maxRuntimeSeconds: 60 };
    startSession(SESSION);
    fakeNow = 90_000;
    const reason = abortReason(SESSION, cfg);
    expect(reason).toMatch(/90s \/ 60s/);
  });
});

// --- startSession is idempotent ---

describe("startSession", () => {
  it("second call does not reset the clock", () => {
    let fakeNow = 0;
    injectClock(() => fakeNow);
    const cfg: WatchdogConfig = { maxConsecutiveTimeouts: null, maxRuntimeSeconds: 60 };
    startSession(SESSION);
    fakeNow = 30_000;
    startSession(SESSION); // should be a no-op
    fakeNow = 90_000;
    expect(abortReason(SESSION, cfg)).toMatch(/exceeded maximum runtime/);
  });
});
