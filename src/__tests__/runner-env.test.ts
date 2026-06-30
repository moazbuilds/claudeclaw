import { describe, expect, test } from "bun:test";
import { buildChildEnv } from "../runner";

describe("buildChildEnv", () => {
  test("uses explicit baseUrl for Anthropic-compatible providers", () => {
    const env = buildChildEnv(
      { EXISTING: "1" },
      { model: "deepseek", api: " fallback-key ", baseUrl: " https://proxy.example/anthropic " },
    );

    expect(env.EXISTING).toBe("1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("fallback-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example/anthropic");
  });

  test("does not forward ambient Anthropic tokens to custom baseUrl without explicit api", () => {
    const env = buildChildEnv(
      {
        ANTHROPIC_API_KEY: "real-anthropic-key",
        ANTHROPIC_AUTH_TOKEN: "real-auth-token",
      },
      { model: "deepseek", api: "", baseUrl: "https://proxy.example/anthropic" },
    );

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example/anthropic");
  });

  test("sets extended timeout for custom baseUrl providers", () => {
    const env = buildChildEnv(
      {},
      { model: "deepseek", api: "", baseUrl: "https://proxy.example/anthropic" },
    );

    expect(env.API_TIMEOUT_MS).toBe("3000000");
  });

  test("keeps the legacy GLM base URL when no baseUrl is configured", () => {
    const env = buildChildEnv({}, { model: "glm", api: "" });

    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.API_TIMEOUT_MS).toBe("3000000");
  });

  test("does not set a base URL for non-GLM models without explicit baseUrl", () => {
    const env = buildChildEnv({}, { model: "sonnet", api: "" });

    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
