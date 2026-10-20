import { describe, it, expect } from "bun:test";
import {
  resolveModelArg,
  resolveMinimaxModel,
  resolvePrimaryModelConfig,
  buildChildEnv,
} from "../runner";

describe("resolveMinimaxModel", () => {
  it("maps the bare minimax alias to the latest model on the global endpoint", () => {
    expect(resolveMinimaxModel("minimax")).toEqual({
      baseUrl: "https://api.minimax.io/anthropic",
      modelId: "MiniMax-M3.1-Flash",
    });
  });

  it("maps explicit MiniMax model aliases", () => {
    expect(resolveMinimaxModel("minimax-m3.1-flash")?.modelId).toBe("MiniMax-M3.1-Flash");
    expect(resolveMinimaxModel("  MiniMax-M3.1-Flash-cn  ")).toEqual({
      baseUrl: "https://api.minimax.cn/anthropic",
      modelId: "MiniMax-M3.1-Flash",
    });
    expect(resolveMinimaxModel("minimax-m3")?.modelId).toBe("MiniMax-M3");
    expect(resolveMinimaxModel("minimax-m2.7")?.modelId).toBe("MiniMax-M2.7");
  });

  it("routes to the China endpoint with the -cn suffix", () => {
    expect(resolveMinimaxModel("minimax-m3-cn")).toEqual({
      baseUrl: "https://api.minimax.cn/anthropic",
      modelId: "MiniMax-M3",
    });
    expect(resolveMinimaxModel("minimax-cn")?.baseUrl).toBe(
      "https://api.minimax.cn/anthropic",
    );
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(resolveMinimaxModel("  MiniMax-M3  ")?.modelId).toBe("MiniMax-M3");
  });

  it("returns null for non-preset and unknown MiniMax models", () => {
    expect(resolveMinimaxModel("opus")).toBeNull();
    expect(resolveMinimaxModel("minimax-m9")).toBeNull();
  });
});

describe("resolveModelArg", () => {
  it("passes MiniMax presets through as canonical model IDs", () => {
    expect(resolveModelArg("minimax-m2.7")).toBe("MiniMax-M2.7");
    expect(resolveModelArg("minimax-m3-cn")).toBe("MiniMax-M3");
  });

  it("suppresses the flag for empty models", () => {
    expect(resolveModelArg("   ")).toBeNull();
  });

  it("keeps GLM on the provider-default model", () => {
    expect(resolveModelArg("glm")).toBeNull();
    expect(resolveModelArg("  GLM  ")).toBeNull();
  });

  it("passes standard models through unchanged", () => {
    expect(resolveModelArg("opus")).toBe("opus");
  });
});

describe("resolvePrimaryModelConfig", () => {
  it("drops a GLM token when an override or agentic route selects MiniMax", () => {
    const configured = { model: "glm", api: "your-glm-token" };

    expect(resolvePrimaryModelConfig(configured, "minimax")).toEqual({
      model: "minimax",
      api: "",
    });
    expect(resolvePrimaryModelConfig(configured, "minimax-m3-cn")).toEqual({
      model: "minimax-m3-cn",
      api: "",
    });
  });

  it("drops a MiniMax token when an override or agentic route selects GLM", () => {
    expect(
      resolvePrimaryModelConfig(
        { model: "minimax-m3", api: "your-minimax-token" },
        "glm",
      ),
    ).toEqual({ model: "glm", api: "" });
  });

  it("keeps the configured token for aliases in the same provider family", () => {
    expect(
      resolvePrimaryModelConfig(
        { model: "minimax", api: "your-minimax-token" },
        "MiniMax-M2.7-cn",
      ),
    ).toEqual({ model: "MiniMax-M2.7-cn", api: "your-minimax-token" });
  });
});

describe("buildChildEnv", () => {
  it("routes MiniMax models to the selected Anthropic-compatible endpoint", () => {
    expect(buildChildEnv({}, "minimax-m3", "token").ANTHROPIC_BASE_URL).toBe(
      "https://api.minimax.io/anthropic",
    );
    expect(buildChildEnv({}, "minimax-m2.7-cn", "token").ANTHROPIC_BASE_URL).toBe(
      "https://api.minimax.cn/anthropic",
    );
  });

  it("passes the api token through as ANTHROPIC_AUTH_TOKEN", () => {
    expect(buildChildEnv({}, "minimax", "example-token").ANTHROPIC_AUTH_TOKEN).toBe(
      "example-token",
    );
  });

  it("does not forward inherited Anthropic credentials to MiniMax", () => {
    const env = buildChildEnv(
      {
        ANTHROPIC_AUTH_TOKEN: "your-inherited-token",
        ANTHROPIC_API_KEY: "your-inherited-key",
      },
      "minimax",
      "",
    );

    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("uses only the configured token for MiniMax", () => {
    const env = buildChildEnv(
      {
        ANTHROPIC_AUTH_TOKEN: "your-inherited-token",
        ANTHROPIC_API_KEY: "your-inherited-key",
      },
      "minimax",
      "your-minimax-token",
    );

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("your-minimax-token");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("preserves endpoint-bound credentials for exact full model IDs", () => {
    const env = buildChildEnv(
      {
        ANTHROPIC_BASE_URL: "https://gateway.example/anthropic",
        ANTHROPIC_AUTH_TOKEN: "your-gateway-token",
        ANTHROPIC_API_KEY: "your-gateway-key",
      },
      "MiniMax-M2.7",
      "",
    );

    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("your-gateway-token");
    expect(env.ANTHROPIC_API_KEY).toBe("your-gateway-key");
  });

  it("lets regional aliases override inherited provider routing", () => {
    const env = buildChildEnv(
      {
        ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
        ANTHROPIC_AUTH_TOKEN: "your-global-token",
        ANTHROPIC_API_KEY: "your-global-key",
      },
      "minimax-m3-cn",
      "your-cn-token",
    );

    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimax.cn/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("your-cn-token");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("leaves the base URL unset for default models", () => {
    expect(buildChildEnv({}, "opus", "").ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("does not apply a third-party token to default Anthropic models", () => {
    const env = buildChildEnv(
      { ANTHROPIC_AUTH_TOKEN: "your-anthropic-token" },
      "opus",
      "your-stale-provider-token",
    );

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("your-anthropic-token");
  });

  it("preserves the GLM endpoint and timeout", () => {
    const env = buildChildEnv(
      {
        ANTHROPIC_AUTH_TOKEN: "your-inherited-token",
        ANTHROPIC_API_KEY: "your-inherited-key",
      },
      "  GLM  ",
      "your-glm-token",
    );

    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.API_TIMEOUT_MS).toBe("3000000");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("your-glm-token");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
