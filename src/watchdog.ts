/**
 * Minimal runaway-session watchdog.
 *
 * Tracks consecutive timeouts per session and aborts when a configurable
 * threshold is exceeded.  This prevents a session stuck in a timeout loop from
 * continuously draining the user's Claude Code allowance.
 *
 * Abort is a single-cycle circuit-breaker: the session state is cleared after
 * an abort so the next invocation starts fresh.
 *
 * Opt-in: all limits default to null (disabled).  Enable via settings.json:
 *
 *   "watchdog": {
 *     "maxConsecutiveTimeouts": 3,
 *     "maxRuntimeSeconds": 3600
 *   }
 */

/** Exit code produced by runClaudeOnce when the per-invocation wall-clock expires. */
export const TIMEOUT_EXIT_CODE = 124;

export interface WatchdogConfig {
  /** Stop retrying after this many consecutive TIMEOUT_EXIT_CODE exits. null = disabled. */
  maxConsecutiveTimeouts: number | null;
  /**
   * Hard wall-clock limit (seconds) measured from when the session is first
   * registered via startSession(). null = disabled.
   *
   * Tip: the existing per-invocation timeout (settings.sessionTimeoutMs) already
   * caps each individual Claude call.  maxRuntimeSeconds adds a session-level
   * guard for cases where many sequential invocations keep timing out.
   */
  maxRuntimeSeconds: number | null;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  maxConsecutiveTimeouts: null,
  maxRuntimeSeconds: null,
};

interface SessionState {
  consecutiveTimeouts: number;
  startedAt: number;
}

/** Allows tests to inject a deterministic clock. */
let _now: () => number = () => Date.now();

/** For tests only — restore with resetClock(). */
export function injectClock(fn: () => number): void {
  _now = fn;
}

export function resetClock(): void {
  _now = () => Date.now();
}

const sessions = new Map<string, SessionState>();

/**
 * Register the start of a session.  Must be called with a real session ID
 * (not the "unknown" sentinel) so the runtime clock begins at the right time.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * Note: tracking is in-memory only. If the daemon restarts, the clock resets on
 * the first resume — maxRuntimeSeconds will not catch sessions older than the
 * current daemon process.
 */
export function startSession(sessionId: string): void {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { consecutiveTimeouts: 0, startedAt: _now() });
  }
}

/**
 * Record the outcome of a single Claude invocation.
 * Only call this with a real session ID (not "unknown").
 */
export function recordResult(sessionId: string, exitCode: number): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  if (exitCode === TIMEOUT_EXIT_CODE) {
    state.consecutiveTimeouts += 1;
  } else {
    state.consecutiveTimeouts = 0;
  }
}

/**
 * Returns an abort-reason string if the watchdog has determined this session
 * should stop, or null if the session is healthy.
 *
 * Call this BEFORE triggering any auto-compact / retry logic.
 * Only call with a real session ID.
 */
export function abortReason(
  sessionId: string,
  config: WatchdogConfig,
): string | null {
  const state = sessions.get(sessionId);
  if (!state) return null;

  if (
    config.maxConsecutiveTimeouts !== null &&
    state.consecutiveTimeouts >= config.maxConsecutiveTimeouts
  ) {
    return (
      `Watchdog: aborted after ${state.consecutiveTimeouts} consecutive timeouts` +
      ` (limit: ${config.maxConsecutiveTimeouts})`
    );
  }

  if (config.maxRuntimeSeconds !== null) {
    const elapsed = (_now() - state.startedAt) / 1000;
    if (elapsed >= config.maxRuntimeSeconds) {
      return (
        `Watchdog: session exceeded maximum runtime` +
        ` (${elapsed.toFixed(0)}s / ${config.maxRuntimeSeconds}s)`
      );
    }
  }

  return null;
}

/**
 * Remove tracking state for a session.
 * Called on clean exit, on abort (circuit-breaker reset), and on non-timeout
 * failures where there is nothing left to track.
 */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Parse and validate a raw settings value into a WatchdogConfig.
 * Unknown keys are ignored; invalid values fall back to null (disabled).
 */
export function parseWatchdogConfig(raw: unknown): WatchdogConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_WATCHDOG_CONFIG };

  const r = raw as Record<string, unknown>;

  const maxConsecutiveTimeouts =
    typeof r.maxConsecutiveTimeouts === "number" &&
    Number.isInteger(r.maxConsecutiveTimeouts) &&
    r.maxConsecutiveTimeouts > 0
      ? r.maxConsecutiveTimeouts
      : null;

  const maxRuntimeSeconds =
    typeof r.maxRuntimeSeconds === "number" &&
    Number.isFinite(r.maxRuntimeSeconds) &&
    r.maxRuntimeSeconds > 0
      ? r.maxRuntimeSeconds
      : null;

  return { maxConsecutiveTimeouts, maxRuntimeSeconds };
}
