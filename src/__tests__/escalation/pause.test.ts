/**
 * Tests for escalation/pause.ts
 * 
 * Run with: bun test src/__tests__/escalation/pause.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  initPauseController,
  pause,
  resume,
  getPauseState,
  isPaused,
  shouldBlockAdmission,
  shouldBlockScheduling,
  getPauseHistory,
  resetPauseController,
  clearPauseCache,
  type PauseMode,
  type PauseState,
} from "../../escalation/pause";

const ESCALATION_DIR = join(process.cwd(), ".claude", "claudeclaw");
const PAUSE_STATE_FILE = join(ESCALATION_DIR, "paused.json");
const PAUSE_ACTIONS_FILE = join(ESCALATION_DIR, "pause-actions.jsonl");

describe("Pause Controller - Initialization", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetPauseController();
  });

  afterEach(async () => {
    try {
      await rm(PAUSE_STATE_FILE, { force: true });
      await rm(PAUSE_ACTIONS_FILE, { force: true });
    } catch {
      // Ignore
    }
  });

  it("should initialize with default unpaused state", async () => {
    await initPauseController();
    
    const state = await getPauseState();
    expect(state.paused).toBe(false);
    expect(state.mode).toBe("admission_only");
  });

  it("should persist state to file", async () => {
    await initPauseController();
    
    expect(existsSync(PAUSE_STATE_FILE)).toBe(true);
    
    const content = await readFile(PAUSE_STATE_FILE, "utf8");
    const parsed = JSON.parse(content);
    
    expect(parsed.paused).toBe(false);
  });
});

describe("Pause Controller - Pause/Resume Operations", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetPauseController();
  });

  afterEach(async () => {
    try {
      await rm(PAUSE_STATE_FILE, { force: true });
      await rm(PAUSE_ACTIONS_FILE, { force: true });
    } catch {
      // Ignore
    }
  });

  it("should pause with admission_only mode", async () => {
    const action = await pause("admission_only", {
      reason: "Maintenance window",
      pausedBy: "operator-1",
    });
    
    expect(action.action).toBe("pause");
    expect(action.mode).toBe("admission_only");
    expect(action.reason).toBe("Maintenance window");
    expect(action.actor).toBe("operator-1");
    
    const state = await getPauseState();
    expect(state.paused).toBe(true);
    expect(state.mode).toBe("admission_only");
    expect(state.pausedBy).toBe("operator-1");
    expect(state.reason).toBe("Maintenance window");
  });

  it("should pause with admission_and_scheduling mode", async () => {
    const action = await pause("admission_and_scheduling", {
      reason: "Critical issue",
      pausedBy: "operator-2",
    });
    
    expect(action.mode).toBe("admission_and_scheduling");
    
    const state = await getPauseState();
    expect(state.paused).toBe(true);
    expect(state.mode).toBe("admission_and_scheduling");
  });

  it("should resume from paused state", async () => {
    await pause("admission_only", {
      reason: "Testing",
      pausedBy: "operator-1",
    });
    
    const action = await resume({
      reason: "Issue resolved",
      resumedBy: "operator-2",
    });
    
    expect(action.action).toBe("resume");
    expect(action.reason).toBe("Issue resolved");
    expect(action.actor).toBe("operator-2");
    
    const state = await getPauseState();
    expect(state.paused).toBe(false);
    expect(state.resumedAt).toBeDefined();
    expect(state.resumedBy).toBe("operator-2");
  });

  it("should handle resume when not paused", async () => {
    const action = await resume({
      reason: "Attempting resume",
      resumedBy: "operator-1",
    });
    
    expect(action.action).toBe("resume");
    
    const state = await getPauseState();
    expect(state.paused).toBe(false);
  });

  it("should track isPaused correctly", async () => {
    expect(await isPaused()).toBe(false);
    
    await pause("admission_only", { reason: "Test" });
    expect(await isPaused()).toBe(true);
    
    await resume({});
    expect(await isPaused()).toBe(false);
  });
});

describe("Pause Controller - Pause Mode Semantics", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetPauseController();
  });

  afterEach(async () => {
    try {
      await rm(PAUSE_STATE_FILE, { force: true });
      await rm(PAUSE_ACTIONS_FILE, { force: true });
    } catch {
      // Ignore
    }
  });

  it("shouldBlockAdmission returns true when paused (any mode)", async () => {
    expect(await shouldBlockAdmission()).toBe(false);
    
    await pause("admission_only", { reason: "Test" });
    expect(await shouldBlockAdmission()).toBe(true);
    
    await resume({});
    await pause("admission_and_scheduling", { reason: "Test 2" });
    expect(await shouldBlockAdmission()).toBe(true);
  });

  it("shouldBlockScheduling returns true only in admission_and_scheduling mode", async () => {
    expect(await shouldBlockScheduling()).toBe(false);
    
    await pause("admission_only", { reason: "Test" });
    expect(await shouldBlockScheduling()).toBe(false);
    
    await resume({});
    await pause("admission_and_scheduling", { reason: "Test 2" });
    expect(await shouldBlockScheduling()).toBe(true);
  });
});

describe("Pause Controller - Persistence Across Restart", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetPauseController();
  });

  afterEach(async () => {
    try {
      await rm(PAUSE_STATE_FILE, { force: true });
      await rm(PAUSE_ACTIONS_FILE, { force: true });
    } catch {
      // Ignore
    }
  });

  it("should persist pause state across cache clear (simulated restart)", async () => {
    await pause("admission_and_scheduling", {
      reason: "Critical maintenance",
      pausedBy: "admin",
    });
    
    // Simulate restart by clearing cache
    clearPauseCache();
    
    // State should still be paused after re-initialization
    const state = await getPauseState();
    expect(state.paused).toBe(true);
    expect(state.mode).toBe("admission_and_scheduling");
    expect(state.reason).toBe("Critical maintenance");
    expect(state.pausedBy).toBe("admin");
  });

  it("should maintain pause history across restarts", async () => {
    await pause("admission_only", { reason: "First pause" });
    await resume({ reason: "First resume" });
    await pause("admission_only", { reason: "Second pause" });
    
    clearPauseCache();
    
    const history = await getPauseHistory();
    expect(history.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Pause Controller - Action History", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetPauseController();
  });

  afterEach(async () => {
    try {
      await rm(PAUSE_STATE_FILE, { force: true });
      await rm(PAUSE_ACTIONS_FILE, { force: true });
    } catch {
      // Ignore
    }
  });

  it("should record pause actions", async () => {
    await pause("admission_only", {
      reason: "Test pause",
      pausedBy: "test-operator",
    });
    
    const history = await getPauseHistory();
    const pauseActions = history.filter(h => h.action === "pause");
    
    expect(pauseActions.length).toBeGreaterThanOrEqual(1);
    expect(pauseActions[0].reason).toBe("Test pause");
    expect(pauseActions[0].actor).toBe("test-operator");
    expect(pauseActions[0].actionId).toBeDefined();
  });

  it("should record resume actions", async () => {
    await pause("admission_only", { reason: "Test" });
    await resume({ reason: "Test resume", resumedBy: "operator-2" });
    
    const history = await getPauseHistory();
    const resumeActions = history.filter(h => h.action === "resume");
    
    expect(resumeActions.length).toBeGreaterThanOrEqual(1);
    expect(resumeActions[0].reason).toBe("Test resume");
    expect(resumeActions[0].actor).toBe("operator-2");
  });

  it("should track previous and new state in actions", async () => {
    await pause("admission_only", { reason: "First" });
    const action = await resume({ reason: "Second" });
    
    expect(action.previousState).toBeDefined();
    expect(action.previousState!.paused).toBe(true);
    expect(action.newState).toBeDefined();
    expect(action.newState.paused).toBe(false);
  });

  it("should respect limit parameter", async () => {
    // Create multiple actions
    for (let i = 0; i < 5; i++) {
      await pause("admission_only", { reason: `Pause ${i}` });
      await resume({ reason: `Resume ${i}` });
    }
    
    const history = await getPauseHistory(3);
    expect(history.length).toBeLessThanOrEqual(3);
  });
});

describe("Pause Controller - Metadata Support", () => {
  beforeEach(async () => {
    await mkdir(ESCALATION_DIR, { recursive: true });
    await resetPauseController();
  });

  afterEach(async () => {
    try {
      await rm(PAUSE_STATE_FILE, { force: true });
      await rm(PAUSE_ACTIONS_FILE, { force: true });
    } catch {
      // Ignore
    }
  });

  it("should store metadata in pause state", async () => {
    await pause("admission_only", {
      reason: "Test",
      metadata: { ticketId: "TICKET-123", priority: "high" },
    });
    
    const state = await getPauseState();
    expect(state.metadata).toEqual({
      ticketId: "TICKET-123",
      priority: "high",
    });
  });

  it("should merge metadata on resume", async () => {
    await pause("admission_only", {
      reason: "Test",
      metadata: { original: "value" },
    });
    
    await resume({
      reason: "Resume test",
      metadata: { additional: "info" },
    });
    
    const state = await getPauseState();
    expect(state.metadata).toEqual({
      original: "value",
      additional: "info",
    });
  });
});
