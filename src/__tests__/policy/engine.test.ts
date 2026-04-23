/**
 * Tests for policy/engine.ts
 * 
 * Run with: bun test src/__tests__/policy/engine.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  evaluate,
  loadRules,
  validateRules,
  getRules,
  clearCache,
  isCacheEnabled,
  type ToolRequestContext,
  type PolicyRule,
} from "../../policy/engine";

const POLICY_DIR = join(process.cwd(), ".claude", "claudeclaw");
const POLICY_FILE = join(POLICY_DIR, "policies.json");

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

// Helper to write a policy file
async function writePolicyFile(rules: PolicyRule[], cache?: { enabled: boolean; maxEntries: number; ttlMs: number }): Promise<void> {
  const policy = {
    version: 1,
    rules,
    cache: cache || { enabled: false, maxEntries: 1000, ttlMs: 60000 },
    updatedAt: new Date().toISOString(),
  };
  await mkdir(POLICY_DIR, { recursive: true });
  await writeFile(POLICY_FILE, JSON.stringify(policy, null, 2), "utf8");
}

describe("Policy Engine - Core Evaluation", () => {
  beforeEach(async () => {
    clearCache();
    await loadRules();
  });

  afterEach(async () => {
    clearCache();
    try {
      await rm(POLICY_FILE, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should deny request when no rules match", async () => {
    await writePolicyFile([]);
    
    const request = createRequest();
    const decision = evaluate(request);
    
    expect(decision.action).toBe("deny");
    expect(decision.matchedRuleId).toBeUndefined();
    expect(decision.reason).toContain("No matching policy rule");
  });

  it("should allow request when explicit allow rule matches", async () => {
    await writePolicyFile([
      {
        id: "allow-telegram",
        priority: 100,
        scope: { source: "telegram" },
        tool: "*",
        action: "allow",
        reason: "Allow all tools on telegram",
      },
    ]);
    
    await loadRules();
    const request = createRequest();
    const decision = evaluate(request);
    
    expect(decision.action).toBe("allow");
    expect(decision.matchedRuleId).toBe("allow-telegram");
  });

  it("should deny request when explicit deny rule matches", async () => {
    await writePolicyFile([
      {
        id: "allow-telegram",
        priority: 100,
        scope: { source: "telegram" },
        tool: "*",
        action: "allow",
      },
      {
        id: "deny-bash",
        priority: 200,
        tool: "Bash",
        action: "deny",
        reason: "Deny bash tool",
      },
    ]);
    
    await loadRules();
    const request = createRequest();
    const decision = evaluate(request);
    
    expect(decision.action).toBe("deny");
    expect(decision.matchedRuleId).toBe("deny-bash");
  });

  it("should require_approval when require_approval rule matches", async () => {
    await writePolicyFile([
      {
        id: "approval-edit",
        priority: 100,
        tool: "Edit",
        action: "require_approval",
        reason: "Edit requires approval",
      },
    ]);
    
    await loadRules();
    const request = createRequest({ toolName: "Edit" });
    const decision = evaluate(request);
    
    expect(decision.action).toBe("require_approval");
    expect(decision.matchedRuleId).toBe("approval-edit");
  });

  it("should evaluate rules by highest priority first", async () => {
    await writePolicyFile([
      {
        id: "low-priority-allow",
        priority: 50,
        tool: "Bash",
        action: "allow",
      },
      {
        id: "high-priority-deny",
        priority: 100,
        tool: "Bash",
        action: "deny",
      },
    ]);
    
    await loadRules();
    const request = createRequest();
    const decision = evaluate(request);
    
    expect(decision.action).toBe("deny");
    expect(decision.matchedRuleId).toBe("high-priority-deny");
  });

  it("should use specificity as tiebreaker when priorities equal", async () => {
    await writePolicyFile([
      {
        id: "global-allow",
        priority: 100,
        tool: "Bash",
        action: "allow",
        reason: "Global allow",
      },
      {
        id: "telegram-deny",
        priority: 100,
        scope: { source: "telegram" },
        tool: "Bash",
        action: "deny",
        reason: "Telegram specific deny",
      },
    ]);
    
    await loadRules();
    const request = createRequest();
    const decision = evaluate(request);
    
    // More specific rule (telegram-deny) should win
    expect(decision.action).toBe("deny");
    expect(decision.matchedRuleId).toBe("telegram-deny");
  });

  it("should deny when no allow rule matches but deny rule exists", async () => {
    await writePolicyFile([
      {
        id: "deny-bash",
        priority: 100,
        tool: "Bash",
        action: "deny",
      },
    ]);
    
    await loadRules();
    const request = createRequest({ toolName: "Bash" });
    const decision = evaluate(request);
    
    expect(decision.action).toBe("deny");
  });

  it("should match wildcard tool", async () => {
    await writePolicyFile([
      {
        id: "allow-all",
        priority: 100,
        tool: "*",
        action: "allow",
      },
    ]);
    
    await loadRules();
    const request = createRequest({ toolName: "AnyTool" });
    const decision = evaluate(request);
    
    expect(decision.action).toBe("allow");
  });

  it("should match tool array", async () => {
    await writePolicyFile([
      {
        id: "allow-view-edit",
        priority: 100,
        tool: ["View", "Edit", "GrepTool"],
        action: "allow",
      },
    ]);
    
    await loadRules();
    
    const viewRequest = createRequest({ toolName: "View" });
    expect(evaluate(viewRequest).action).toBe("allow");
    
    const editRequest = createRequest({ toolName: "Edit" });
    expect(evaluate(editRequest).action).toBe("allow");
    
    const bashRequest = createRequest({ toolName: "Bash" });
    expect(evaluate(bashRequest).action).toBe("deny");
  });

  it("should match source array", async () => {
    await writePolicyFile([
      {
        id: "allow-multiple-sources",
        priority: 100,
        scope: { source: ["telegram", "discord"] },
        tool: "*",
        action: "allow",
      },
    ]);
    
    await loadRules();
    
    const telegramRequest = createRequest({ source: "telegram" });
    expect(evaluate(telegramRequest).action).toBe("allow");
    
    const discordRequest = createRequest({ source: "discord" });
    expect(evaluate(discordRequest).action).toBe("allow");
    
    const slackRequest = createRequest({ source: "slack" });
    expect(evaluate(slackRequest).action).toBe("deny");
  });

  it("should skip disabled rules", async () => {
    await writePolicyFile([
      {
        id: "allow-disabled",
        priority: 100,
        enabled: false,
        tool: "*",
        action: "allow",
      },
    ]);
    
    await loadRules();
    const request = createRequest();
    const decision = evaluate(request);
    
    expect(decision.action).toBe("deny");
  });

  it("should handle userId scope correctly", async () => {
    await writePolicyFile([
      {
        id: "allow-admin",
        priority: 100,
        scope: { userId: "admin-user" },
        tool: "*",
        action: "allow",
      },
    ]);
    
    await loadRules();
    
    const adminRequest = createRequest({ userId: "admin-user" });
    expect(evaluate(adminRequest).action).toBe("allow");
    
    const regularRequest = createRequest({ userId: "regular-user" });
    expect(evaluate(regularRequest).action).toBe("deny");
  });

  it("should handle skillName scope correctly", async () => {
    await writePolicyFile([
      {
        id: "allow-code-review",
        priority: 100,
        scope: { skillName: "code-review" },
        tool: ["View", "GlobTool", "GrepTool"],
        action: "allow",
      },
    ]);
    
    await loadRules();
    
    const codeReviewRequest = createRequest({ 
      skillName: "code-review",
      toolName: "View",
    });
    expect(evaluate(codeReviewRequest).action).toBe("allow");
    
    const otherSkillRequest = createRequest({ 
      skillName: "other-skill",
      toolName: "View",
    });
    expect(evaluate(otherSkillRequest).action).toBe("deny");
  });
});

describe("Policy Engine - Time Window Conditions", () => {
  afterEach(async () => {
    try {
      await rm(POLICY_FILE, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should deny request outside time window", async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    const lastWeek = new Date(Date.now() - 7 * 86400000).toISOString();
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString();
    
    await writePolicyFile([
      {
        id: "allow-business-hours",
        priority: 100,
        tool: "*",
        action: "allow",
        conditions: {
          timeWindow: { start: lastWeek, end: yesterday }, // Past window
        },
      },
    ]);
    
    await loadRules();
    const request = createRequest();
    const decision = evaluate(request);
    
    expect(decision.action).toBe("deny");
  });
});

describe("Policy Engine - Validation", () => {
  it("should return valid for correct rules", () => {
    const rules: PolicyRule[] = [
      {
        id: "valid-rule",
        tool: "Bash",
        action: "allow",
        reason: "Valid rule",
      },
    ];
    
    const result = validateRules(rules);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject rule without id", () => {
    const rules: PolicyRule[] = [
      {
        id: "",
        tool: "Bash",
        action: "allow",
      },
    ];
    
    const result = validateRules(rules);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "id")).toBe(true);
  });

  it("should reject rule without tool", () => {
    // Cast to PolicyRule[] to test validation catches missing tool
    const rules = [
      {
        id: "no-tool",
        action: "allow",
      },
    ] as unknown as PolicyRule[];
    
    const result = validateRules(rules);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "tool")).toBe(true);
  });

  it("should reject rule with invalid action", () => {
    const rules: PolicyRule[] = [
      {
        id: "invalid-action",
        tool: "Bash",
        action: "invalid" as any,
      },
    ];
    
    const result = validateRules(rules);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "action")).toBe(true);
  });

  it("should warn about unscoped allow rules", () => {
    const rules: PolicyRule[] = [
      {
        id: "unscoped-allow",
        tool: "*",
        action: "allow",
      },
    ];
    
    const result = validateRules(rules);
    expect(result.warnings.some(w => w.field === "scope")).toBe(true);
  });

  it("should detect duplicate rule IDs", () => {
    const rules: PolicyRule[] = [
      { id: "duplicate", tool: "Bash", action: "allow" },
      { id: "duplicate", tool: "Edit", action: "deny" },
    ];
    
    const result = validateRules(rules);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("Duplicate"))).toBe(true);
  });

  it("should warn on invalid time window dates", () => {
    const rules: PolicyRule[] = [
      {
        id: "bad-timewindow",
        tool: "Bash",
        action: "allow",
        conditions: {
          timeWindow: { start: "not-a-date", end: "also-not-a-date" },
        },
      },
    ];
    
    const result = validateRules(rules);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("Policy Engine - Cache", () => {
  afterEach(async () => {
    try {
      await rm(POLICY_FILE, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should cache decisions when cache enabled", async () => {
    await writePolicyFile([
      {
        id: "allow-all",
        priority: 100,
        tool: "*",
        action: "allow",
      },
    ], { enabled: true, maxEntries: 100, ttlMs: 60000 });
    
    await loadRules();
    expect(isCacheEnabled()).toBe(true);
    
    const request = createRequest();
    const decision1 = evaluate(request);
    expect(decision1.action).toBe("allow");
    
    // Second evaluation should use cache
    const decision2 = evaluate(request);
    expect(decision2.action).toBe("allow");
  });

  it("should clear cache on reload", async () => {
    await writePolicyFile([
      {
        id: "allow-all",
        priority: 100,
        tool: "*",
        action: "allow",
      },
    ], { enabled: true, maxEntries: 100, ttlMs: 60000 });
    
    await loadRules();
    const request = createRequest();
    evaluate(request);
    
    // Change policy
    await writePolicyFile([
      {
        id: "deny-all",
        priority: 100,
        tool: "*",
        action: "deny",
      },
    ], { enabled: true, maxEntries: 100, ttlMs: 60000 });
    
    await loadRules();
    const decision = evaluate(request);
    
    // Should reflect new policy, not cached
    expect(decision.action).toBe("deny");
    expect(decision.matchedRuleId).toBe("deny-all");
  });

  it("should not cache require_approval decisions", async () => {
    await writePolicyFile([
      {
        id: "approval-edit",
        priority: 100,
        tool: "Edit",
        action: "require_approval",
      },
    ], { enabled: true, maxEntries: 100, ttlMs: 60000 });
    
    await loadRules();
    const request = createRequest({ toolName: "Edit" });
    const decision = evaluate(request);
    
    expect(decision.action).toBe("require_approval");
    expect(decision.cacheable).toBe(false);
  });
});
