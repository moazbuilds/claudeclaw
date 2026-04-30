import { describe, it, expect } from "bun:test";
import { buildArgs, type PluginAction } from "../commands/plugin-cli";

describe("buildArgs", () => {
  it("marketplace-add", () => {
    const action: PluginAction = { kind: "marketplace-add", source: "https://github.com/example/plugins" };
    expect(buildArgs(action)).toEqual(["claude", "plugin", "marketplace", "add", "https://github.com/example/plugins"]);
  });

  it("marketplace-list", () => {
    expect(buildArgs({ kind: "marketplace-list" })).toEqual(["claude", "plugin", "marketplace", "list"]);
  });

  it("marketplace-update with name", () => {
    expect(buildArgs({ kind: "marketplace-update", name: "my-marketplace" })).toEqual([
      "claude", "plugin", "marketplace", "update", "my-marketplace",
    ]);
  });

  it("marketplace-update without name (update all)", () => {
    expect(buildArgs({ kind: "marketplace-update" })).toEqual(["claude", "plugin", "marketplace", "update"]);
  });

  it("marketplace-remove", () => {
    expect(buildArgs({ kind: "marketplace-remove", name: "old-marketplace" })).toEqual([
      "claude", "plugin", "marketplace", "remove", "old-marketplace",
    ]);
  });

  it("install user scope", () => {
    expect(buildArgs({ kind: "install", plugin: "my-plugin", scope: "user" })).toEqual([
      "claude", "plugin", "install", "my-plugin", "-s", "user",
    ]);
  });

  it("install project scope", () => {
    expect(buildArgs({ kind: "install", plugin: "my-plugin@my-marketplace", scope: "project" })).toEqual([
      "claude", "plugin", "install", "my-plugin@my-marketplace", "-s", "project",
    ]);
  });

  it("list", () => {
    expect(buildArgs({ kind: "list" })).toEqual(["claude", "plugin", "list"]);
  });

  it("uninstall", () => {
    expect(buildArgs({ kind: "uninstall", plugin: "my-plugin" })).toEqual(["claude", "plugin", "uninstall", "my-plugin"]);
  });

  it("enable", () => {
    expect(buildArgs({ kind: "enable", plugin: "my-plugin" })).toEqual(["claude", "plugin", "enable", "my-plugin"]);
  });

  it("disable", () => {
    expect(buildArgs({ kind: "disable", plugin: "my-plugin" })).toEqual(["claude", "plugin", "disable", "my-plugin"]);
  });
});
