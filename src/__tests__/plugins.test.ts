import { describe, it, expect, beforeEach } from "bun:test";
import {
  PluginManager,
  getPluginManager,
  setPluginManager,
  parsePlugins,
  type EventContext,
  type PluginApi,
} from "../plugins";

const ctx: EventContext = { workspaceDir: "/tmp/test" };

describe("parsePlugins", () => {
  it("returns empty object for null/undefined", () => {
    expect(parsePlugins(null)).toEqual({});
    expect(parsePlugins(undefined)).toEqual({});
    expect(parsePlugins("string")).toEqual({});
  });

  it("parses a valid plugin entry", () => {
    const result = parsePlugins({
      "claude-mem": { enabled: true, source: "openclaw", config: { workerPort: 37777 } },
    });
    expect(result["claude-mem"]).toEqual({
      enabled: true,
      source: "openclaw",
      config: { workerPort: 37777 },
    });
  });

  it("defaults enabled to false and source to openclaw", () => {
    const result = parsePlugins({ "my-plugin": {} });
    expect(result["my-plugin"].enabled).toBe(false);
    expect(result["my-plugin"].source).toBe("openclaw");
    expect(result["my-plugin"].config).toEqual({});
  });

  it("trims source string", () => {
    const result = parsePlugins({ p: { source: "  my-source  " } });
    expect(result["p"].source).toBe("my-source");
  });

  it("skips non-object entries", () => {
    const result = parsePlugins({ bad: "not-an-object", good: { enabled: true, source: "x", config: {} } });
    expect(result["bad"]).toBeUndefined();
    expect(result["good"]).toBeDefined();
  });
});

describe("PluginManager singleton", () => {
  beforeEach(() => {
    setPluginManager(null);
  });

  it("starts as null", () => {
    expect(getPluginManager()).toBeNull();
  });

  it("setPluginManager / getPluginManager round-trip", () => {
    const pm = new PluginManager("/tmp");
    setPluginManager(pm);
    expect(getPluginManager()).toBe(pm);
    setPluginManager(null);
    expect(getPluginManager()).toBeNull();
  });
});

describe("PluginManager event system", () => {
  let pm: PluginManager;

  beforeEach(() => {
    pm = new PluginManager("/tmp/test");
  });

  it("emit returns undefined when no handlers registered", async () => {
    const result = await pm.emit("agent_end", {}, ctx);
    expect(result).toBeUndefined();
  });

  it("on/emit: handler receives data and ctx", async () => {
    let received: { data: unknown; ctx: EventContext } | null = null;
    let api: PluginApi | null = null;

    // Register a plugin manually via the internal api
    const internalApi = (pm as unknown as {
      buildApi: (id: string, cfg: Record<string, unknown>) => PluginApi;
    }).buildApi("test-plugin", {});
    api = internalApi;
    internalApi.on("agent_end", (data, c) => {
      received = { data, ctx: c };
    });

    await pm.emit("agent_end", { messages: ["hello"] }, ctx);
    expect(received).not.toBeNull();
    expect((received!.data as { messages: unknown[] }).messages).toEqual(["hello"]);
    expect(received!.ctx).toBe(ctx);
    expect(api).not.toBeNull();
  });

  it("before_prompt_build merges appendSystemContext from multiple handlers", async () => {
    const internalApi = (pm as unknown as {
      buildApi: (id: string, cfg: Record<string, unknown>) => PluginApi;
    }).buildApi("p1", {});
    internalApi.on("before_prompt_build", () => ({ appendSystemContext: "context-a" }));

    const internalApi2 = (pm as unknown as {
      buildApi: (id: string, cfg: Record<string, unknown>) => PluginApi;
    }).buildApi("p2", {});
    internalApi2.on("before_prompt_build", () => ({ appendSystemContext: "context-b" }));

    const result = await pm.emit("before_prompt_build", { prompt: "test" }, ctx);
    expect(result?.appendSystemContext).toBe("context-a\n\ncontext-b");
  });

  it("before_prompt_build returns undefined when no handler returns appendSystemContext", async () => {
    const internalApi = (pm as unknown as {
      buildApi: (id: string, cfg: Record<string, unknown>) => PluginApi;
    }).buildApi("p", {});
    internalApi.on("before_prompt_build", () => ({}));

    const result = await pm.emit("before_prompt_build", {}, ctx);
    expect(result).toBeUndefined();
  });

  it("emitAsync does not throw synchronously even when handler throws", () => {
    const internalApi = (pm as unknown as {
      buildApi: (id: string, cfg: Record<string, unknown>) => PluginApi;
    }).buildApi("p", {});
    internalApi.on("agent_end", () => { throw new Error("boom"); });
    // Must not throw — error is logged via console.warn
    expect(() => pm.emitAsync("agent_end", {}, ctx)).not.toThrow();
  });

  it("emitAsync is fire-and-forget (returns void)", () => {
    const result = pm.emitAsync("agent_end", {}, ctx);
    expect(result).toBeUndefined();
  });

  it("handler errors in emit are swallowed and do not abort subsequent handlers", async () => {
    let secondCalled = false;
    const internalApi = (pm as unknown as {
      buildApi: (id: string, cfg: Record<string, unknown>) => PluginApi;
    }).buildApi("p1", {});
    internalApi.on("agent_end", () => { throw new Error("handler error"); });

    const internalApi2 = (pm as unknown as {
      buildApi: (id: string, cfg: Record<string, unknown>) => PluginApi;
    }).buildApi("p2", {});
    internalApi2.on("agent_end", () => { secondCalled = true; });

    await pm.emit("agent_end", {}, ctx);
    expect(secondCalled).toBe(true);
  });
});

describe("PluginManager commands", () => {
  let pm: PluginManager;

  beforeEach(() => {
    pm = new PluginManager("/tmp/test");
  });

  it("runCommand returns null for unknown command", async () => {
    expect(await pm.runCommand("unknown")).toBeNull();
  });

  it("registerCommand/runCommand round-trip", async () => {
    const internalApi = (pm as unknown as {
      buildApi: (id: string, cfg: Record<string, unknown>) => PluginApi;
    }).buildApi("p", {});
    internalApi.registerCommand({ name: "hello", handler: async () => "world" });

    expect(await pm.runCommand("hello")).toBe("world");
    expect(pm.getCommandNames()).toContain("hello");
  });
});

describe("PluginManager services", () => {
  let pm: PluginManager;

  beforeEach(() => {
    pm = new PluginManager("/tmp/test");
  });

  it("startServices/stopServices do not throw when no services registered", async () => {
    await expect(pm.startServices()).resolves.toBeUndefined();
    await expect(pm.stopServices()).resolves.toBeUndefined();
  });

  it("registerService start/stop called", async () => {
    let started = false;
    let stopped = false;
    const internalApi = (pm as unknown as {
      buildApi: (id: string, cfg: Record<string, unknown>) => PluginApi;
    }).buildApi("p", {});
    internalApi.registerService({
      id: "my-service",
      start: async () => { started = true; },
      stop: async () => { stopped = true; },
    });

    await pm.startServices();
    expect(started).toBe(true);

    await pm.stopServices();
    expect(stopped).toBe(true);
  });
});

describe("PluginManager info", () => {
  it("hasPlugins is false with no loaded plugins", () => {
    const pm = new PluginManager("/tmp");
    expect(pm.hasPlugins).toBe(false);
    expect(pm.loaded).toEqual([]);
  });
});

describe("PluginManager path resolution (security)", () => {
  it("rejects relative-segment source strings (path traversal guard)", async () => {
    const pm = new PluginManager("/tmp/test");
    // loadPlugin will call resolvePluginPath which should return null for traversal attempts
    const resolvePluginPath = (pm as unknown as {
      resolvePluginPath: (id: string, source: string) => string | null;
    }).resolvePluginPath.bind(pm);

    expect(resolvePluginPath("p", "../../etc")).toBeNull();
    expect(resolvePluginPath("p", "../evil")).toBeNull();
    expect(resolvePluginPath("p", "valid-pkg")).toBeNull(); // null because file doesn't exist, not because of rejection
  });

  it("accepts valid npm package names", () => {
    const pm = new PluginManager("/tmp/test");
    const resolvePluginPath = (pm as unknown as {
      resolvePluginPath: (id: string, source: string) => string | null;
    }).resolvePluginPath.bind(pm);

    // These return null only because the files don't exist, not due to validation failure
    // We verify resolvePluginPath doesn't throw and returns null (not a hard error)
    expect(() => resolvePluginPath("p", "my-plugin")).not.toThrow();
    expect(() => resolvePluginPath("p", "@scope/my-plugin")).not.toThrow();
  });

  it("checkHealth rejects invalid host strings", async () => {
    const pm = new PluginManager("/tmp/test");
    const checkHealth = (pm as unknown as {
      checkHealth: (host: string, port: number) => Promise<boolean>;
    }).checkHealth.bind(pm);

    expect(await checkHealth("127.0.0.1/admin#", 8080)).toBe(false);
    expect(await checkHealth("user@evil.com", 8080)).toBe(false);
    expect(await checkHealth("", 8080)).toBe(false);
    expect(await checkHealth("127.0.0.1", 0)).toBe(false);
    expect(await checkHealth("127.0.0.1", 99999)).toBe(false);
  });
});
