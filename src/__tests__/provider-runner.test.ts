import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const globalUrl = "https://api.minimax.io/anthropic";
const chinaUrl = "https://api.minimax.cn/anthropic";
const customUrl = "https://gateway.example/anthropic";

// The transport owned by this repository is the CLI invocation, not HTTP.
// Each case loads real saved settings and captures Bun.spawn in an isolated process.
describe("MiniMax runner subprocess boundary", () => {
  for (const [model, modelId, expectedUrl, baseUrl] of [
    ["minimax", "MiniMax-M3.1-Flash", globalUrl],
    ["minimax-cn", "MiniMax-M3.1-Flash", chinaUrl],
    ["minimax-m3.1-flash", "MiniMax-M3.1-Flash", globalUrl],
    ["minimax-m3.1-flash-cn", "MiniMax-M3.1-Flash", chinaUrl],
    ["minimax-m3", "MiniMax-M3", globalUrl],
    ["minimax-m3-cn", "MiniMax-M3", chinaUrl],
    ["minimax-m2.7", "MiniMax-M2.7", globalUrl],
    ["minimax-m2.7-cn", "MiniMax-M2.7", chinaUrl],
    ["MiniMax-M3.1-Flash", "MiniMax-M3.1-Flash", customUrl, customUrl],
    ["MiniMax-M3", "MiniMax-M3", customUrl, customUrl],
    ["MiniMax-M2.7", "MiniMax-M2.7", customUrl, customUrl],
    ["custom-model", "custom-model", customUrl, customUrl],
    ["opus", "opus", undefined],
  ]) {
    it(`preserves ${model} through saved settings, streaming, and compact`, async () => {
      const sandbox = await mkdtemp(join(import.meta.dir, "provider-sandbox-"));
      try {
        const proc = Bun.spawn([
          process.execPath,
          join(import.meta.dir, "fixtures/provider-runner.ts"),
          JSON.stringify({ model, baseUrl }),
        ], {
          cwd: sandbox,
          env: { PATH: process.env.PATH ?? "", HOME: sandbox, LANG: "C.UTF-8" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
        ]);
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
        const line = stdout.split("\n").find((line) => line.startsWith("PROVIDER_CAPTURE="));
        expect(line).toBeDefined();
        const { captured, prompt, sessionId } = JSON.parse(line!.slice("PROVIDER_CAPTURE=".length));
        expect(captured).toHaveLength(3);
        for (const [index, request] of captured.entries()) {
          expect(request.args[request.args.indexOf("--model") + 1]).toBe(modelId);
          expect(request.env.ANTHROPIC_BASE_URL).toBe(expectedUrl);
          expect(request.args[request.args.indexOf("--resume") + 1]).toBe(sessionId);
          const sentPrompt = request.args[request.args.indexOf("-p") + 1];
          if (index < 2) {
            expect(sentPrompt.endsWith(prompt)).toBe(true);
            expect(request.args).toContain("stream-json");
          } else {
            expect(sentPrompt).toBe("/compact");
          }
          if (model!.toLowerCase().startsWith("minimax")) {
            expect(request.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-token");
            expect(request.env.ANTHROPIC_API_KEY).toBeUndefined();
          } else {
            expect(request.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
            expect(request.env.ANTHROPIC_API_KEY).toBe("fixture-inherited-key");
          }
        }
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    });
  }
});
