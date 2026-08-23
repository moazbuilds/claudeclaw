import { describe, test, expect } from "bun:test";

import { resolveChannelModel } from "../commands/discord";

describe("resolveChannelModel", () => {
  const models = { "111": "sonnet", "222": " haiku ", "333": "" };

  test("returns the model configured for a guild channel", () => {
    expect(resolveChannelModel(models, "111", true)).toBe("sonnet");
  });

  test("trims whitespace around the model name", () => {
    expect(resolveChannelModel(models, "222", true)).toBe("haiku");
  });

  test("threads inherit their parent channel's model", () => {
    expect(resolveChannelModel(models, "thread-1", true, "111")).toBe("sonnet");
  });

  test("a thread's own entry wins over its parent's", () => {
    expect(resolveChannelModel(models, "222", true, "111")).toBe("haiku");
  });

  test("returns undefined for unlisted channels, empty entries, DMs, and missing config", () => {
    expect(resolveChannelModel(models, "999", true)).toBeUndefined();
    expect(resolveChannelModel(models, "333", true)).toBeUndefined();
    expect(resolveChannelModel(models, "111", false)).toBeUndefined();
    expect(resolveChannelModel(undefined, "111", true)).toBeUndefined();
  });
});
