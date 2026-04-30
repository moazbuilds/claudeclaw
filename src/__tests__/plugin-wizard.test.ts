import { describe, it, expect, beforeEach } from "bun:test";
import {
  isWizardTrigger,
  hasActiveWizard,
  handleWizardInput,
  cancelWizard,
  type WizardContext,
} from "../commands/plugin-wizard";

// Wizard tests use real state machine but rely on the fact that
// runPluginCli is never reached in unit tests (all paths that would call
// it require valid CLI responses). We only test state transitions and
// input classification here.

const ctx: WizardContext = { iface: "web", scopeId: "test-unit" };

beforeEach(() => {
  cancelWizard(ctx);
});

// --- isWizardTrigger ---

describe("isWizardTrigger", () => {
  it("recognises /plugin", () => { expect(isWizardTrigger("/plugin")).toBe(true); });
  it("recognises /claudeclaw:plugin", () => { expect(isWizardTrigger("/claudeclaw:plugin")).toBe(true); });
  it("ignores case differences", () => { expect(isWizardTrigger("/PLUGIN")).toBe(true); });
  it("rejects non-plugin commands", () => { expect(isWizardTrigger("/reset")).toBe(false); });
  it("rejects plain text", () => { expect(isWizardTrigger("hello world")).toBe(false); });
  it("accepts /plugin with trailing args", () => { expect(isWizardTrigger("/plugin some args")).toBe(true); });
});

// --- hasActiveWizard / lifecycle ---

describe("hasActiveWizard", () => {
  it("returns false before any interaction", () => {
    expect(hasActiveWizard(ctx)).toBe(false);
  });

  it("returns true after opening the wizard", async () => {
    await handleWizardInput(ctx, "/plugin");
    expect(hasActiveWizard(ctx)).toBe(true);
  });

  it("returns false after cancel", async () => {
    await handleWizardInput(ctx, "/plugin");
    await handleWizardInput(ctx, "cancel");
    expect(hasActiveWizard(ctx)).toBe(false);
  });
});

// --- cancelWizard ---

describe("cancelWizard", () => {
  it("clears an active session", async () => {
    await handleWizardInput(ctx, "/plugin");
    cancelWizard(ctx);
    expect(hasActiveWizard(ctx)).toBe(false);
  });

  it("is safe to call when no session exists", () => {
    expect(() => cancelWizard(ctx)).not.toThrow();
  });
});

// --- wizard flow: menu ---

describe("wizard menu", () => {
  it("returns the action menu on /plugin", async () => {
    const reply = await handleWizardInput(ctx, "/plugin");
    expect(reply).toContain("Add marketplace");
    expect(reply).toContain("Install plugin");
  });

  it("shows menu on unrecognised option", async () => {
    await handleWizardInput(ctx, "/plugin");
    const reply = await handleWizardInput(ctx, "99");
    expect(reply).toContain("Add marketplace");
  });
});

// --- wizard flow: marketplace source prompt ---

describe("marketplace-source step", () => {
  it("asks for source URL after choosing option 1", async () => {
    await handleWizardInput(ctx, "/plugin");
    const reply = await handleWizardInput(ctx, "1");
    expect(reply).toMatch(/url|path|repo/i);
  });

  it("can be cancelled mid-flow", async () => {
    await handleWizardInput(ctx, "/plugin");
    await handleWizardInput(ctx, "1");
    const reply = await handleWizardInput(ctx, "cancel");
    expect(reply).toContain("cancelled");
    expect(hasActiveWizard(ctx)).toBe(false);
  });
});

// --- wizard flow: install scope prompt ---

describe("install-scope step", () => {
  it("asks for scope after providing plugin name", async () => {
    await handleWizardInput(ctx, "/plugin");
    await handleWizardInput(ctx, "4");
    const reply = await handleWizardInput(ctx, "my-plugin");
    expect(reply).toContain("user");
    expect(reply).toContain("project");
  });

  it("rejects invalid scope choice and re-prompts", async () => {
    await handleWizardInput(ctx, "/plugin");
    await handleWizardInput(ctx, "4");
    await handleWizardInput(ctx, "my-plugin");
    const reply = await handleWizardInput(ctx, "3");
    expect(reply).toMatch(/1.*user|2.*project/i);
  });
});

// --- install-confirm: no manifest path (readPluginManifest returns null) ---

describe("install-confirm step", () => {
  it("shows confirmation prompt with plugin name", async () => {
    await handleWizardInput(ctx, "/plugin");
    await handleWizardInput(ctx, "4");
    await handleWizardInput(ctx, "test-plugin");
    const reply = await handleWizardInput(ctx, "1"); // scope: user
    expect(reply).toContain("test-plugin");
    expect(reply).toMatch(/yes/i);
  });

  it("rejects non-yes reply and re-prompts", async () => {
    await handleWizardInput(ctx, "/plugin");
    await handleWizardInput(ctx, "4");
    await handleWizardInput(ctx, "test-plugin");
    await handleWizardInput(ctx, "1");
    const reply = await handleWizardInput(ctx, "nope");
    expect(reply).toMatch(/yes.*install|cancel/i);
  });
});

// --- independent contexts don't interfere ---

describe("context isolation", () => {
  it("sessions from different contexts are independent", async () => {
    const ctx2: WizardContext = { iface: "discord", scopeId: "channel-abc" };
    cancelWizard(ctx2);

    await handleWizardInput(ctx, "/plugin");
    expect(hasActiveWizard(ctx)).toBe(true);
    expect(hasActiveWizard(ctx2)).toBe(false);
  });
});
