/**
 * Tests for runner.ts modelOverride wiring (Phase 18 Plan 01).
 *
 * Strategy: spy on runClaudeOnce to intercept model arg, throw sentinel
 * to short-circuit downstream side effects. Use isolated tmp cwd to
 * contain any session/log writes.
 *
 * Run with: bun test src/__tests__/runner.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, spyOn } from "bun:test";
import * as runnerMod from "../runner";
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
});
