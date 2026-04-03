/**
 * Tests for policy/channel-policies.ts
 * 
 * Run with: bun test src/__tests__/policy/channel-policies.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, rm, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  getScopedRules,
  mergeScopedPolicies,
  validateScopedPolicyConfig,
  createDefaultScopedPolicyConfig,
  getExampleScopedPolicyConfig,
  reloadScopedPolicy,
  type ScopedPolicyConfig,
} from "../../policy/channel-policies";
import { loadRules, type ToolRequestContext, type PolicyRule } from "../../policy/engine";

const POLICY_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SCOPED_POLICY_FILE = join(POLICY_DIR, "scoped-policies.json");

// Helper to create a test request
const createRequest = (overrides: Partial<ToolRequestContext> = {}): ToolRequestContext => ({
  eventId: "test-event-1",
  source: "telegram",
  channelId: "telegram:123",
  threadId: "thread-1",
  userId: "user-1",
  skillName: undefined,
  toolName: "Bash",
  toolArgs: {},
  sessionId: "session-1",
  claudeSessionId: null,
  timestamp: new Date().toISOString(),
  metadata: {},
  ...overrides,
});

describe("Channel Policies - Scoped Rules", () => {
  beforeEach(async () => {
    // Clear any cached config
    reloadScopedPolicy();
    
    // Ensure directory exists
    await mkdir(POLICY_DIR, { recursive: true });
    
    // Clean up
    try {
      await rm(SCOPED_POLICY_FILE, { force: true });
    } catch {
      // Ignore
    }
    
    await loadRules();
  });

  afterEach(async () => {
    try {
      await rm(SCOPED_POLICY_FILE, { force: true });
    } catch {
      // Ignore
    }
  });

  it("should return empty array when no scoped policy file exists", () => {
    const request = createRequest();
    const rules = getScopedRules(request);
    expect(Array.isArray(rules)).toBe(true);
  });

  it("should resolve channel-specific deny rules", async () => {
    const scopedConfig = {
      version: 1,
      sources: {
        telegram: {
          source: "telegram",
          channels: {
            "telegram:123": {
              channelId: "telegram:123",
              denyRules: [
                {
                  id: "channel-deny-bash",
                  priority: 200,
                  tool: "Bash",
                  action: "deny",
                  reason: "Bash denied in this channel",
                },
              ],
            },
          },
        },
      },
      globalRules: [],
      updatedAt: new Date().toISOString(),
    };
    
    await writeFile(SCOPED_POLICY_FILE, JSON.stringify(scopedConfig, null, 2), "utf8");
    reloadScopedPolicy();
    
    const request = createRequest({ toolName: "Bash" });
    const rules = getScopedRules(request);
    
    // Should have the channel deny rule
    const denyRule = rules.find(r => r.id === "channel-deny-bash");
    expect(denyRule).toBeDefined();
    expect(denyRule?.action).toBe("deny");
  });

  it("should resolve user-specific overrides", async () => {
    const scopedConfig = {
      version: 1,
      sources: {
        telegram: {
          source: "telegram",
          channels: {
            "telegram:123": {
              channelId: "telegram:123",
              userOverrides: {
                "admin-user": {
                  userId: "admin-user",
                  allowRules: [
                    {
                      id: "admin-allow-all",
                      priority: 200,
                      tool: "*",
                      action: "allow",
                      reason: "Admin has full access",
                    },
                  ],
                },
              },
            },
          },
        },
      },
      globalRules: [],
      updatedAt: new Date().toISOString(),
    };
    
    await writeFile(SCOPED_POLICY_FILE, JSON.stringify(scopedConfig, null, 2), "utf8");
    reloadScopedPolicy();
    
    const request = createRequest({ userId: "admin-user", toolName: "Bash" });
    const rules = getScopedRules(request);
    
    const adminRule = rules.find(r => r.id === "admin-allow-all");
    expect(adminRule).toBeDefined();
    expect(adminRule?.action).toBe("allow");
  });

  it("should handle discord and telegram as different contexts", async () => {
    const scopedConfig = {
      version: 1,
      sources: {
        telegram: {
          source: "telegram",
          defaultRules: [
            {
              id: "telegram-deny-bash",
              priority: 100,
              tool: "Bash",
              action: "deny",
            },
          ],
        },
        discord: {
          source: "discord",
          defaultRules: [
            {
              id: "discord-allow-bash",
              priority: 100,
              tool: "Bash",
              action: "allow",
            },
          ],
        },
      },
      globalRules: [],
      updatedAt: new Date().toISOString(),
    };
    
    await writeFile(SCOPED_POLICY_FILE, JSON.stringify(scopedConfig, null, 2), "utf8");
    reloadScopedPolicy();
    
    const telegramRequest = createRequest({ source: "telegram", toolName: "Bash" });
    const telegramRules = getScopedRules(telegramRequest);
    const telegramDeny = telegramRules.find(r => r.id === "telegram-deny-bash");
    expect(telegramDeny?.action).toBe("deny");
    
    const discordRequest = createRequest({ source: "discord", toolName: "Bash" });
    const discordRules = getScopedRules(discordRequest);
    const discordAllow = discordRules.find(r => r.id === "discord-allow-bash");
    expect(discordAllow?.action).toBe("allow");
  });
});

describe("Channel Policies - Merge Scoped Policies", () => {
  it("should merge global and scoped rules without duplicates", () => {
    const globalRules: PolicyRule[] = [
      { id: "global-allow", tool: "View", action: "allow" },
    ];
    
    const scopedRules: PolicyRule[] = [
      { id: "scoped-deny", tool: "Edit", action: "deny" },
    ];
    
    const merged = mergeScopedPolicies(globalRules, scopedRules);
    
    expect(merged).toHaveLength(2);
    expect(merged.find(r => r.id === "global-allow")).toBeDefined();
    expect(merged.find(r => r.id === "scoped-deny")).toBeDefined();
  });

  it("should prefer scoped rules over global rules with same ID", () => {
    const globalRules: PolicyRule[] = [
      { id: "same-id", tool: "View", action: "allow" },
    ];
    
    const scopedRules: PolicyRule[] = [
      { id: "same-id", tool: "View", action: "deny" },
    ];
    
    const merged = mergeScopedPolicies(globalRules, scopedRules);
    
    expect(merged).toHaveLength(1);
    expect(merged[0].action).toBe("deny");
  });

  it("should filter out disabled rules", () => {
    const globalRules: PolicyRule[] = [
      { id: "disabled-global", tool: "View", action: "allow", enabled: false },
      { id: "enabled-global", tool: "Edit", action: "allow" },
    ];
    
    const scopedRules: PolicyRule[] = [
      { id: "disabled-scoped", tool: "Bash", action: "deny", enabled: false },
    ];
    
    const merged = mergeScopedPolicies(globalRules, scopedRules);
    
    expect(merged.find(r => r.id === "disabled-global")).toBeUndefined();
    expect(merged.find(r => r.id === "enabled-global")).toBeDefined();
    expect(merged.find(r => r.id === "disabled-scoped")).toBeUndefined();
  });
});

describe("Channel Policies - Validation", () => {
  it("should validate a correct scoped policy config", () => {
    const config = getExampleScopedPolicyConfig();
    const result = validateScopedPolicyConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should detect missing version", () => {
    const config = {
      sources: {},
      globalRules: [],
    } as any;
    
    const result = validateScopedPolicyConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("version"))).toBe(true);
  });

  it("should detect mismatched channel IDs", () => {
    const config: ScopedPolicyConfig = {
      version: 1,
      sources: {
        telegram: {
          source: "telegram",
          channels: {
            "channel-1": {
              channelId: "different-id", // Mismatch!
            },
          },
        },
      },
      globalRules: [],
      updatedAt: new Date().toISOString(),
    };
    
    const result = validateScopedPolicyConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("mismatch"))).toBe(true);
  });
});

describe("Channel Policies - Default Config", () => {
  it("should create a valid default config", () => {
    const config = createDefaultScopedPolicyConfig();
    expect(config.version).toBe(1);
    expect(config.sources).toEqual({});
    expect(config.globalRules).toEqual([]);
  });

  it("should have proper structure in example config", () => {
    const config = getExampleScopedPolicyConfig();
    
    // Should have telegram and discord sources
    expect(config.sources["telegram"]).toBeDefined();
    expect(config.sources["discord"]).toBeDefined();
    
    // Telegram should have channel config
    expect(config.sources["telegram"].channels?.["telegram:123"]).toBeDefined();
    
    // Should have global deny rule
    const globalDeny = config.globalRules.find(r => r.id === "global-deny-dangerous");
    expect(globalDeny).toBeDefined();
    expect(globalDeny?.action).toBe("deny");
  });
});
