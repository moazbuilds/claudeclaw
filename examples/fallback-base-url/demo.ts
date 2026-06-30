import { buildChildEnv } from "../../src/runner";
import type { ModelConfig } from "../../src/config";

const fallback: ModelConfig = {
  model: "deepseek-chat",
  api: "demo-fallback-token",
  baseUrl: "https://proxy.example.com/anthropic",
};

const env = buildChildEnv({ PATH: process.env.PATH ?? "" }, fallback);

console.log(JSON.stringify({
  fallback,
  childEnv: {
    ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    API_TIMEOUT_MS: env.API_TIMEOUT_MS ?? null,
  },
}, null, 2));
