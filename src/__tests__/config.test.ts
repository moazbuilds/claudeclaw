import { describe, expect, test, afterAll, beforeEach } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";

const TEST_ROOT = join(import.meta.dir, "../../test-sandbox-config");
const SETTINGS_DIR = join(TEST_ROOT, ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");

async function resetSandbox() {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(SETTINGS_DIR, { recursive: true });
}

async function loadSettingsInSandbox(settings: Record<string, unknown>) {
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  const script = `
import { loadSettings } from ${JSON.stringify(join(import.meta.dir, "..", "config"))};
const settings = await loadSettings();
process.stdout.write(JSON.stringify({
  baseUrl: settings.baseUrl,
  fallback: settings.fallback,
}));
`;
  const scriptPath = join(TEST_ROOT, "_load-settings.ts");
  await writeFile(scriptPath, script);
  const proc = Bun.spawn(["bun", "run", scriptPath], {
    cwd: TEST_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(err);
  return JSON.parse(out);
}

beforeEach(resetSandbox);

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("settings model baseUrl parsing", () => {
  test("parses primary and fallback base URLs", async () => {
    const settings = await loadSettingsInSandbox({
      model: "sonnet",
      api: "primary-key",
      baseUrl: " https://primary.example/anthropic ",
      fallback: {
        model: "deepseek",
        api: "fallback-key",
        baseUrl: " https://fallback.example/anthropic ",
      },
    });

    expect(settings.baseUrl).toBe("https://primary.example/anthropic");
    expect(settings.fallback).toEqual({
      model: "deepseek",
      api: "fallback-key",
      baseUrl: "https://fallback.example/anthropic",
    });
  });
});
