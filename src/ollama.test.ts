import { expect, test, describe, beforeAll } from "bun:test";
import { classifyReadOnly, isOllamaAvailable, LOCAL_SIGIL } from "./ollama";

const CLASSIFIER_MODEL = "phi3:mini";
const TIMEOUT = 15000;

// These are live-LLM integration tests: slow (17 phi3:mini generations) and
// inherently nondeterministic — phi3 misclassifies borderline prompts on some
// runs, which made the default `bun test` sweep flaky. The Ollama routing
// feature is currently disabled in runner.ts, so only run these when
// explicitly requested: OLLAMA_TESTS=1 bun test src/ollama.test.ts
const optedIn = process.env.OLLAMA_TESTS === "1";

// Skip all tests gracefully if Ollama isn't running
let ollamaUp = false;
beforeAll(async () => {
  if (!optedIn) return;
  ollamaUp = await isOllamaAvailable();
  if (!ollamaUp) console.warn("⚠ Ollama not running — skipping classifier tests");
});

describe("read/write classifier", () => {
  const reads: string[] = [
    "how many whiskeys have I logged?",
    "what's my highest rated beer?",
    "summarize my todo list",
    "what beers from Belgium have I tried?",
    "show me all whiskeys rated 7 or higher",
    "who has a birthday this week?",
    "what's the last song I added to the banjo songbook?",
    "how many beers do I have from IPAs?",
    "give me a report on my whiskey collection",
  ];

  const writes: string[] = [
    "log a whiskey: Lagavulin 16 rated 7/8",
    "add Pliny the Elder to my beer list, 4.5/5",
    "create a todo: buy groceries",
    "mark the todo about groceries as done",
    "delete the song Old Blue from the banjo list",
    "update Sierra's birthday",
    "deploy the whiskey dashboard",
    "remove Talisker Storm from the wishlist",
  ];

  for (const prompt of reads) {
    test(`READ: "${prompt}"`, async () => {
      if (!optedIn || !ollamaUp) return;
      const result = await classifyReadOnly(prompt, CLASSIFIER_MODEL);
      expect(result).toBe(true);
    }, TIMEOUT);
  }

  for (const prompt of writes) {
    test(`WRITE: "${prompt}"`, async () => {
      if (!optedIn || !ollamaUp) return;
      const result = await classifyReadOnly(prompt, CLASSIFIER_MODEL);
      expect(result).toBe(false);
    }, TIMEOUT);
  }
});

describe("sigil", () => {
  test("LOCAL_SIGIL is defined and non-empty", () => {
    expect(LOCAL_SIGIL).toBeTruthy();
    expect(typeof LOCAL_SIGIL).toBe("string");
  });
});
