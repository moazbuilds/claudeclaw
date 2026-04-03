/**
 * Policy Engine Core
 * 
 * Deterministic rule evaluation over normalized tool-use requests.
 * 
 * DESIGN:
 * - Policy file stored at .claude/claudeclaw/policies.json
 * - Default decision is DENY unless explicitly allowed
 * - Evaluation order: highest priority first, then specificity, then explicit deny > allow > require_approval
 * - Cache is configurable and bounded, invalidated on policy reload
 * 
 * CRASH CONSCIOUSNESS:
 * - All policy state is loaded from disk on init
 * - Invalid rules fail closed and are surfaced clearly
 * - Cache must not become source of truth
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "crypto";

const POLICY_DIR = join(process.cwd(), ".claude", "claudeclaw");
const POLICY_FILE = join(POLICY_DIR, "policies.json");

// ============================================================================
// Types
// ============================================================================

export interface ToolRequestContext {
  eventId: string;
  source: string;               // telegram, discord, slack, web, etc.
  channelId?: string;
  threadId?: string;
  userId?: string;
  skillName?: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  sessionId?: string;           // local session mapping ID
  claudeSessionId?: string | null;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export type PolicyAction = "allow" | "deny" | "require_approval";

export interface PolicyDecision {
  requestId: string;
  action: PolicyAction;
  matchedRuleId?: string;
  reason: string;
  evaluatedAt: string;
  cacheable?: boolean;
}

export interface PolicyScope {
  source?: string | string[]; // "telegram", ["telegram","discord"], "*"
  channelId?: string | string[];
  userId?: string | string[];
  skillName?: string | string[];
}

export interface PolicyConditions {
  timeWindow?: { start: string; end: string };
  argConstraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface PolicyRule {
  id: string;
  enabled?: boolean;
  priority?: number;            // higher priority evaluated first
  scope?: PolicyScope;
  tool: string | string[];      // specific tool(s) or "*"
  action: PolicyAction;
  conditions?: PolicyConditions;
  reason?: string;
}

export interface PolicyFile {
  version: number;
  rules: PolicyRule[];
  cache?: {
    enabled: boolean;
    maxEntries: number;
    ttlMs: number;
  };
  updatedAt: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  ruleId: string;
  field: string;
  message: string;
}

export interface ValidationWarning {
  ruleId: string;
  field: string;
  message: string;
}

// ============================================================================
// Cache
// ============================================================================

interface CacheEntry {
  requestKey: string;
  decision: PolicyDecision;
  expiresAt: number;
}

let policyCache: Map<string, CacheEntry> = new Map();
let cacheConfig = { enabled: false, maxEntries: 1000, ttlMs: 60000 };

// ============================================================================
// State
// ============================================================================

let loadedRules: PolicyRule[] = [];
let loadedAt: string = "";
let loadError: Error | null = null;

// ============================================================================
// Core API
// ============================================================================

/**
 * Evaluate a tool-use request against loaded policy rules.
 * Returns a deterministic PolicyDecision.
 */
export function evaluate(request: ToolRequestContext): PolicyDecision {
  const requestId = randomUUID();
  const evaluatedAt = new Date().toISOString();

  // Fail closed if policy engine failed to initialize
  if (loadError) {
    return {
      requestId,
      action: "deny",
      reason: `Policy engine failed to initialize: ${loadError.message}`,
      evaluatedAt,
      cacheable: false,
    };
  }

  // Check cache first if enabled
  if (cacheConfig.enabled) {
    const cached = getCachedDecision(request);
    if (cached) {
      return {
        ...cached,
        requestId, // Fresh request ID even for cached decisions
        evaluatedAt, // Fresh evaluation timestamp
      };
    }
  }
  
  // Get all applicable rules sorted by priority
  const applicableRules = getApplicableRules(request);
  
  if (applicableRules.length === 0) {
    // No matching rules - default deny
    const decision: PolicyDecision = {
      requestId,
      action: "deny",
      reason: "No matching policy rule - default deny",
      evaluatedAt,
      cacheable: true,
    };
    
    if (cacheConfig.enabled) {
      cacheDecision(request, decision);
    }
    
    return decision;
  }
  
  // Sort by priority (highest first), then by specificity
  const sortedRules = sortRules(applicableRules);
  
  // Find the best matching rule
  const matchedRule = sortedRules[0];
  
  const decision: PolicyDecision = {
    requestId,
    action: matchedRule.action,
    matchedRuleId: matchedRule.id,
    reason: matchedRule.reason || `Matched rule: ${matchedRule.id}`,
    evaluatedAt,
    cacheable: matchedRule.action === "allow" && !matchedRule.conditions?.timeWindow,
  };
  
  if (cacheConfig.enabled && decision.cacheable) {
    cacheDecision(request, decision);
  }
  
  return decision;
}

/**
 * Load and validate rules from the policy file.
 * Creates default policy file if none exists.
 */
export async function loadRules(): Promise<PolicyRule[]> {
  // Ensure directory exists
  if (!existsSync(POLICY_DIR)) {
    await mkdir(POLICY_DIR, { recursive: true });
  }
  
  // Create default policy file if none exists
  if (!existsSync(POLICY_FILE)) {
    const defaultPolicy: PolicyFile = {
      version: 1,
      rules: [],
      cache: { enabled: false, maxEntries: 1000, ttlMs: 60000 },
      updatedAt: new Date().toISOString(),
    };
    await writeFile(POLICY_FILE, JSON.stringify(defaultPolicy, null, 2), "utf8");
  }
  
  // Read and parse policy file
  const content = await readFile(POLICY_FILE, "utf8");
  const policyFile: PolicyFile = JSON.parse(content);
  
  // Validate rules
  const validation = validateRules(policyFile.rules);
  if (!validation.valid) {
    // Fail closed - don't load invalid rules
    const errorMsg = validation.errors.map(e => `${e.ruleId}: ${e.message}`).join("; ");
    throw new Error(`Policy file contains invalid rules: ${errorMsg}`);
  }
  
  // Update cache config
  if (policyFile.cache) {
    cacheConfig = { ...cacheConfig, ...policyFile.cache };
  }
  
  // Clear cache on reload
  policyCache.clear();
  
  loadedRules = policyFile.rules;
  loadedAt = new Date().toISOString();
  
  return loadedRules;
}

/**
 * Validate a set of policy rules.
 * Returns validation result with errors and warnings.
 */
export function validateRules(rules: PolicyRule[]): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  
  for (const rule of rules) {
    // Validate rule ID
    if (!rule.id || typeof rule.id !== "string") {
      errors.push({ ruleId: rule.id || "unknown", field: "id", message: "Rule must have a valid id string" });
    }
    
    // Validate action
    if (!rule.action || !["allow", "deny", "require_approval"].includes(rule.action)) {
      errors.push({ ruleId: rule.id, field: "action", message: "Rule must have action: allow | deny | require_approval" });
    }
    
    // Validate tool
    if (!rule.tool) {
      errors.push({ ruleId: rule.id, field: "tool", message: "Rule must specify tool(s)" });
    } else if (Array.isArray(rule.tool) && rule.tool.length === 0) {
      errors.push({ ruleId: rule.id, field: "tool", message: "Tool array cannot be empty" });
    }
    
    // Validate scope values
    if (rule.scope) {
      if (rule.scope.source === "") {
        errors.push({ ruleId: rule.id, field: "scope.source", message: "Scope source cannot be empty string" });
      }
    }
    
    // Validate conditions
    if (rule.conditions) {
      if (rule.conditions.timeWindow) {
        const tw = rule.conditions.timeWindow;
        if (!tw.start || !tw.end) {
          errors.push({ ruleId: rule.id, field: "conditions.timeWindow", message: "timeWindow requires start and end" });
        } else {
          const startDate = new Date(tw.start);
          const endDate = new Date(tw.end);
          if (isNaN(startDate.getTime())) {
            errors.push({ ruleId: rule.id, field: "conditions.timeWindow.start", message: "Invalid start date format" });
          }
          if (isNaN(endDate.getTime())) {
            errors.push({ ruleId: rule.id, field: "conditions.timeWindow.end", message: "Invalid end date format" });
          }
          if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime()) && startDate >= endDate) {
            warnings.push({ ruleId: rule.id, field: "conditions.timeWindow", message: "timeWindow end is not after start - rule will never match" });
          }
        }
      }
    }
    
    // Warnings for potentially problematic patterns
    if (rule.action === "allow" && !rule.scope) {
      warnings.push({ ruleId: rule.id, field: "scope", message: "Unscoped allow rule - will apply to all requests" });
    }
    
    if (rule.tool === "*" && !rule.scope) {
      warnings.push({ ruleId: rule.id, field: "tool/scope", message: "Globally allow all tools - may be overly permissive" });
    }
  }
  
  // Check for duplicate rule IDs
  const ids = rules.map(r => r.id);
  const duplicates = ids.filter((id, idx) => ids.indexOf(id) !== idx);
  if (duplicates.length > 0) {
    errors.push({ ruleId: "global", field: "rules", message: `Duplicate rule IDs: ${[...new Set(duplicates)].join(", ")}` });
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Get the currently loaded rules.
 */
export function getRules(): PolicyRule[] {
  return [...loadedRules];
}

/**
 * Get the last time rules were loaded.
 */
export function getLoadedAt(): string {
  return loadedAt;
}

/**
 * Check if cache is enabled.
 */
export function isCacheEnabled(): boolean {
  return cacheConfig.enabled;
}

/**
 * Clear the decision cache.
 */
export function clearCache(): void {
  policyCache.clear();
}

// ============================================================================
// Internal Helpers
// ============================================================================

function getApplicableRules(request: ToolRequestContext): PolicyRule[] {
  return loadedRules.filter(rule => {
    // Skip disabled rules
    if (rule.enabled === false) return false;
    
    // Check tool match
    if (!matchesTool(rule.tool, request.toolName)) return false;
    
    // Check scope match
    if (!matchesScope(rule.scope, request)) return false;
    
    // Check conditions
    if (!matchesConditions(rule.conditions, request)) return false;
    
    return true;
  });
}

function matchesTool(ruleTool: string | string[], requestTool: string): boolean {
  if (ruleTool === "*") return true;
  if (Array.isArray(ruleTool)) return ruleTool.includes(requestTool);
  return ruleTool === requestTool;
}

function matchesScope(scope: PolicyScope | undefined, request: ToolRequestContext): boolean {
  if (!scope) return true; // No scope = match all
  
  // Check source
  if (scope.source) {
    if (Array.isArray(scope.source)) {
      if (!scope.source.includes(request.source)) return false;
    } else if (scope.source !== "*") {
      if (scope.source !== request.source) return false;
    }
  }
  
  // Check channelId
  if (scope.channelId) {
    if (!request.channelId) return false;
    if (Array.isArray(scope.channelId)) {
      if (!scope.channelId.includes(request.channelId)) return false;
    } else if (scope.channelId !== "*") {
      if (scope.channelId !== request.channelId) return false;
    }
  }

  // Check userId
  if (scope.userId) {
    if (!request.userId) return false;
    if (Array.isArray(scope.userId)) {
      if (!scope.userId.includes(request.userId)) return false;
    } else if (scope.userId !== "*") {
      if (scope.userId !== request.userId) return false;
    }
  }

  // Check skillName
  if (scope.skillName) {
    if (!request.skillName) return false;
    if (Array.isArray(scope.skillName)) {
      if (!scope.skillName.includes(request.skillName)) return false;
    } else if (scope.skillName !== "*") {
      if (scope.skillName !== request.skillName) return false;
    }
  }
  
  return true;
}

function matchesConditions(conditions: PolicyConditions | undefined, request: ToolRequestContext): boolean {
  if (!conditions) return true;
  
  // Check time window
  if (conditions.timeWindow) {
    const now = new Date(request.timestamp);
    const start = new Date(conditions.timeWindow.start);
    const end = new Date(conditions.timeWindow.end);
    
    if (now < start || now > end) return false;
  }
  
  // Check arg constraints
  if (conditions.argConstraints) {
    if (!request.toolArgs) return false;
    for (const [key, expectedValue] of Object.entries(conditions.argConstraints)) {
      const actualValue = request.toolArgs[key];
      if (actualValue !== expectedValue) return false;
    }
  }

  // Check metadata constraints
  if (conditions.metadata) {
    if (!request.metadata) return false;
    for (const [key, expectedValue] of Object.entries(conditions.metadata)) {
      const actualValue = request.metadata[key];
      if (actualValue !== expectedValue) return false;
    }
  }
  
  return true;
}

function sortRules(rules: PolicyRule[]): PolicyRule[] {
  return [...rules].sort((a, b) => {
    // Highest priority first
    const priorityA = a.priority ?? 0;
    const priorityB = b.priority ?? 0;
    if (priorityB !== priorityA) return priorityB - priorityA;
    
    // More specific scope first (more scope fields set = more specific)
    const specificityA = countScopeFields(a.scope);
    const specificityB = countScopeFields(b.scope);
    if (specificityB !== specificityA) return specificityB - specificityA;
    
    // Explicit deny beats require_approval beats allow
    const actionOrder: Record<PolicyAction, number> = { deny: 0, require_approval: 1, allow: 2 };
    return actionOrder[a.action] - actionOrder[b.action];
  });
}

function countScopeFields(scope: PolicyScope | undefined): number {
  if (!scope) return 0;
  let count = 0;
  if (scope.source) count++;
  if (scope.channelId) count++;
  if (scope.userId) count++;
  if (scope.skillName) count++;
  return count;
}

function getRequestKey(request: ToolRequestContext): string {
  const parts = [
    request.source,
    request.channelId || "",
    request.userId || "",
    request.skillName || "",
    request.toolName,
    request.toolArgs ? JSON.stringify(request.toolArgs) : "",
  ];
  return parts.join("|");
}

function getCachedDecision(request: ToolRequestContext): PolicyDecision | null {
  const key = getRequestKey(request);
  const entry = policyCache.get(key);
  
  if (!entry) return null;
  
  if (Date.now() > entry.expiresAt) {
    policyCache.delete(key);
    return null;
  }
  
  return entry.decision;
}

function cacheDecision(request: ToolRequestContext, decision: PolicyDecision): void {
  if (!decision.cacheable) return;
  
  const key = getRequestKey(request);
  
  // Evict oldest if at capacity
  if (policyCache.size >= cacheConfig.maxEntries) {
    const oldestKey = policyCache.keys().next().value;
    if (oldestKey) policyCache.delete(oldestKey);
  }
  
  policyCache.set(key, {
    requestKey: key,
    decision,
    expiresAt: Date.now() + cacheConfig.ttlMs,
  });
}

// ============================================================================
// Initialization
// ============================================================================

// Auto-load rules on module import
loadRules().catch(err => {
  loadError = err instanceof Error ? err : new Error(String(err));
  console.error("Failed to load policy rules:", err);
});
