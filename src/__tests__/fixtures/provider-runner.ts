import { spyOn } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Executed in a fresh process and sandbox so runner/config module caches are isolated.
const scenario = JSON.parse(process.argv[2]);
const stateDir = join(process.cwd(), ".claude", "claudeclaw");
await mkdir(stateDir, { recursive: true });
const settings = JSON.stringify({ model: scenario.model, api: "fixture-token" });
await writeFile(join(stateDir, "settings.json"), settings);
await writeFile("CLAUDE.md", "Fixture system context");
if (scenario.baseUrl) process.env.ANTHROPIC_BASE_URL = scenario.baseUrl;
process.env.ANTHROPIC_API_KEY = "fixture-inherited-key";

const { loadSettings } = await import("../../config");
const { createSession } = await import("../../sessions");
const { runUserMessage, streamUserMessage, runCompact } = await import("../../runner");
await loadSettings();
const sessionId = "11111111-1111-4111-8111-111111111111";
await createSession(sessionId);
const prompt = 'Inspect attachment image.png and video.mp4; keep "quotes" and\nnewlines.';
const captured: unknown[] = [];
const spawn = spyOn(Bun, "spawn").mockImplementation(((args: string[], options: any) => {
  // Serialize only the actual invocation fields under test, never the host environment.
  captured.push(JSON.parse(JSON.stringify({
    args,
    env: {
      ANTHROPIC_BASE_URL: options.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: options.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_API_KEY: options.env.ANTHROPIC_API_KEY,
    },
  })));
  const output = JSON.stringify({ type: "result", result: "fixture response", session_id: sessionId }) + "\n";
  return {
    stdout: new Response(output).body,
    stderr: new Response("").body,
    exited: Promise.resolve(0),
    exitCode: 0,
    kill() {},
  };
}) as typeof Bun.spawn);
try {
  await runUserMessage("provider-fixture", prompt);
  await streamUserMessage("provider-fixture-stream", prompt, () => {}, () => {});
  await runCompact(sessionId, scenario.model, "fixture-token", {
    ...(scenario.baseUrl ? { ANTHROPIC_BASE_URL: scenario.baseUrl } : {}),
    ANTHROPIC_API_KEY: "fixture-inherited-key",
  }, [], 1000);
} finally {
  spawn.mockRestore();
}
if (await Bun.file(join(stateDir, "settings.json")).text() !== settings) {
  throw new Error("Runner rewrote saved model settings");
}
console.log("PROVIDER_CAPTURE=" + JSON.stringify({ captured, prompt, sessionId }));
