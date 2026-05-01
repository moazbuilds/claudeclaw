import { describe, it, expect } from "bun:test";
import { PluginManager, parsePlugins } from "../plugins";

describe("parsePlugins", () => {
  it("returns empty object for null input", () => {
    expect(parsePlugins(null)).toEqual({});
    expect(parsePlugins(undefined)).toEqual({});
  });

  it("returns empty object for non-object input", () => {
    expect(parsePlugins("string")).toEqual({});
    expect(parsePlugins(42)).toEqual({});
  });

  it("skips entries that are not objects", () => {
    const result = parsePlugins({ bad: "string", good: { enabled: true, source: "openclaw" } });
    expect(result).not.toHaveProperty("bad");
    expect(result).toHaveProperty("good");
  });

  it("parses a valid plugin entry with defaults", () => {
    const result = parsePlugins({
      "claude-mem": { enabled: true, source: "openclaw", config: { workerPort: 37777 } },
    });
    expect(result["claude-mem"]).toEqual({
      enabled: true,
      source: "openclaw",
      config: { workerPort: 37777 },
    });
  });

  it("defaults enabled to false and source to openclaw when missing", () => {
    const result = parsePlugins({ myplugin: {} });
    expect(result["myplugin"].enabled).toBe(false);
    expect(result["myplugin"].source).toBe("openclaw");
    expect(result["myplugin"].config).toEqual({});
  });

  it("trims whitespace from source", () => {
    const result = parsePlugins({ p: { enabled: true, source: "  /some/path  " } });
    expect(result["p"].source).toBe("/some/path");
  });
});

describe("PluginManager emit", () => {
  it("returns undefined when no handlers registered", async () => {
    const pm = new PluginManager("/tmp");
    const result = await pm.emit("agent_end", {}, {});
    expect(result).toBeUndefined();
  });

  it("runs registered handler and returns result", async () => {
    const pm = new PluginManager("/tmp");
    // Register directly via buildApi
    let received: any;
    const api = (pm as any).buildApi("test", {});
    api.on("agent_end", (data: any) => {
      received = data;
      return "done";
    });
    const result = await pm.emit("agent_end", { exitCode: 0 }, {});
    expect(received).toEqual({ exitCode: 0 });
    expect(result).toBe("done");
  });

  it("before_prompt_build collects appendSystemContext from multiple handlers", async () => {
    const pm = new PluginManager("/tmp");
    const api = (pm as any).buildApi("test", {});
    api.on("before_prompt_build", () => ({ appendSystemContext: "context A" }));
    api.on("before_prompt_build", () => ({ appendSystemContext: "context B" }));
    const result = await pm.emit("before_prompt_build", {}, {});
    expect(result?.appendSystemContext).toBe("context A\n\ncontext B");
  });

  it("before_prompt_build returns undefined when no handler returns appendSystemContext", async () => {
    const pm = new PluginManager("/tmp");
    const api = (pm as any).buildApi("test", {});
    api.on("before_prompt_build", () => ({ something: "else" }));
    const result = await pm.emit("before_prompt_build", {}, {});
    expect(result).toBeUndefined();
  });
});

describe("PluginManager tool_result_persist payload shape", () => {
  it("emitAsync fires handler with correct tool_result payload", async () => {
    const pm = new PluginManager("/tmp");
    const api = (pm as any).buildApi("test", {});
    let payload: any;
    api.on("tool_result_persist", (data: any) => { payload = data; });

    await new Promise<void>((resolve) => {
      api.on("tool_result_persist", () => resolve());
      pm.emitAsync("tool_result_persist", {
        toolName: "Bash",
        input: { command: "ls" },
        output: "file.txt\n",
        toolUseId: "tu_abc123",
      }, { sessionKey: "sess_xyz" });
    });

    expect(payload.toolName).toBe("Bash");
    expect(payload.input).toEqual({ command: "ls" });
    expect(payload.output).toBe("file.txt\n");
    expect(payload.toolUseId).toBe("tu_abc123");
  });
});

describe("PluginManager unloadAll", () => {
  it("clears handlers and resets loaded list", async () => {
    const pm = new PluginManager("/tmp");
    const api = (pm as any).buildApi("test", {});
    api.on("agent_end", () => "result");
    (pm as any).loadedPlugins.push("test");

    await pm.unloadAll();

    expect(pm.loaded).toEqual([]);
    expect(pm.hasPlugins).toBe(false);
    const result = await pm.emit("agent_end", {}, {});
    expect(result).toBeUndefined();
  });
});
