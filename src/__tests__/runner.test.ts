/**
 * Tests for runner.ts modelOverride wiring (Phase 18 Plan 01).
 *
 * Strategy: spy on runClaudeOnce to intercept model arg, throw sentinel
 * to short-circuit downstream side effects. Use isolated tmp cwd to
 * contain any session/log writes.
 *
 * Run with: bun test src/__tests__/runner.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, spyOn, test } from "bun:test";
import * as runnerMod from "../runner";
import * as configMod from "../config";
import { loadSettings, getSettings } from "../config";

const SENTINEL = "RUNNER_TEST_SENTINEL";

let runOnceSpy: ReturnType<typeof spyOn> | null = null;
const capturedModels: string[] = [];

beforeAll(async () => {
  await loadSettings();
});

beforeEach(() => {
  capturedModels.length = 0;
  runOnceSpy = spyOn(runnerMod, "runClaudeOnce").mockImplementation(
    (async (_args: string[], model: string) => {
      capturedModels.push(model);
      throw new Error(SENTINEL);
    }) as any,
  );
});

afterEach(() => {
  runOnceSpy?.mockRestore();
  runOnceSpy = null;
});

async function tryRun(opts?: { modelOverride?: string }): Promise<void> {
  try {
    await runnerMod.run("test-job", "hello world", undefined, opts);
  } catch (e) {
    if ((e as Error).message !== SENTINEL && !(e as Error).message?.includes(SENTINEL)) {
      throw e;
    }
  }
}

describe("Phase 18: runner modelOverride wiring", () => {
  it("forwards modelOverride to runClaudeOnce as primaryConfig.model", async () => {
    await tryRun({ modelOverride: "opus" });
    expect(capturedModels.length).toBeGreaterThanOrEqual(1);
    expect(capturedModels[0]).toBe("opus");
  });

  it("without options uses settings.model (back-compat)", async () => {
    const { model, agentic } = getSettings();
    await tryRun();
    expect(capturedModels.length).toBeGreaterThanOrEqual(1);
    if (!agentic.enabled) {
      // Only assert exact match in non-agentic mode (otherwise router picks)
      expect(capturedModels[0]).toBe(model);
    }
  });

  it("modelOverride='glm' is forwarded as model='glm'", async () => {
    await tryRun({ modelOverride: "glm" });
    expect(capturedModels[0]).toBe("glm");
  });

  // Phase 18 Plan 03 Task 1: all supported model strings + agentic interaction
  test.each(["opus", "sonnet", "haiku", "glm"])(
    "forwards %s as primaryConfig.model via modelOverride",
    async (m) => {
      await tryRun({ modelOverride: m });
      expect(capturedModels.length).toBeGreaterThanOrEqual(1);
      expect(capturedModels[0]).toBe(m);
    },
  );

  it("modelOverride wins when agentic.enabled=true (override branch precedes agentic)", async () => {
    const real = getSettings();
    const forcedAgentic = {
      ...real,
      agentic: {
        ...real.agentic,
        enabled: true,
        defaultMode: real.agentic?.defaultMode ?? "implementation",
        modes: real.agentic?.modes ?? [],
      },
    };
    const settingsSpy = spyOn(configMod, "getSettings").mockReturnValue(forcedAgentic as any);
    try {
      await tryRun({ modelOverride: "opus" });
      expect(capturedModels[0]).toBe("opus");
    } finally {
      settingsSpy.mockRestore();
    }
  });

  it("no modelOverride + agentic.enabled=false uses settings.model (regression sanity)", async () => {
    const real = getSettings();
    const forcedNonAgentic = {
      ...real,
      model: "sonnet",
      agentic: { ...real.agentic, enabled: false },
    };
    const settingsSpy = spyOn(configMod, "getSettings").mockReturnValue(forcedNonAgentic as any);
    try {
      await tryRun();
      expect(capturedModels[0]).toBe("sonnet");
    } finally {
      settingsSpy.mockRestore();
    }
  });

  // fallbackConfig is derived from settings.fallback regardless of modelOverride.
  // This is verified by inspection of src/runner.ts execClaude: fallbackConfig
  // is built from `fallback?.model` after the override branch, never from
  // options.modelOverride. Documented here rather than asserted because the
  // runClaudeOnce spy only captures the primary model arg, not fallback.
});
