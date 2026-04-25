/**
 * Scoped Channel and User Policies
 * 
 * Helper layer that resolves channel/user scoped policy rules into
 * normalized engine rules without hard-coding channel-specific logic.
 * 
 * This module produces normalized rules - not a parallel evaluator.
 */

import {
  type PolicyRule,
  type ToolRequestContext,
  getRules,
} from "./engine";

import { readFileSync, existsSync } from "fs";

// ============================================================================
// Types
// ============================================================================

export interface SourceConfig {
  source: string;
  channels?: Record<string, ChannelConfig>;
  defaultRules?: PolicyRule[];
}

export interface ChannelConfig {
  channelId: string;
  denyRules?: PolicyRule[];
  allowRules?: PolicyRule[];
  userOverrides?: Record<string, UserOverride>;
}

export interface UserOverride {
  userId: string;
  denyRules?: PolicyRule[];
  allowRules?: PolicyRule[];
}

export interface ScopedPolicyConfig {
  version: number;
  sources: Record<string, SourceConfig>;
  globalRules: PolicyRule[];
  updatedAt: string;
}

const POLICY_DIR = ".claude/claudeclaw";
const SCOPED_POLICY_FILE = `${POLICY_DIR}/scoped-policies.json`;

// ============================================================================
// Core API
// ============================================================================

/**
 * Get all scoped rules applicable to a request context.
 * Returns rules from global, source, channel, and user levels.
 */
export function getScopedRules(context: ToolRequestContext): PolicyRule[] {
  const allRules: PolicyRule[] = [];
  
  // Get global rules (these are already loaded in engine)
  const globalRules = getRules();
  allRules.push(...globalRules);
  
  // Try to load and merge scoped policies
  try {
    const scopedConfig = loadScopedPolicyConfig();
    if (scopedConfig) {
      const sourceConfig = scopedConfig.sources[context.source];
      if (sourceConfig) {
        // Add source-level default rules
        if (sourceConfig.defaultRules) {
          allRules.push(...sourceConfig.defaultRules);
        }
        
        // Find channel-specific rules
        if (context.channelId && sourceConfig.channels) {
          const channelConfig = sourceConfig.channels[context.channelId];
          if (channelConfig) {
            // Add channel deny rules (high priority)
            if (channelConfig.denyRules) {
              allRules.push(...channelConfig.denyRules.map(rule => ({
                ...rule,
                priority: rule.priority ?? 150, // Higher than typical
              })));
            }
            
            // Add channel allow rules
            if (channelConfig.allowRules) {
              allRules.push(...channelConfig.allowRules.map(rule => ({
                ...rule,
                priority: rule.priority ?? 100,
              })));
            }
            
            // Find user-specific overrides
            if (context.userId && channelConfig.userOverrides) {
              const userOverride = channelConfig.userOverrides[context.userId];
              if (userOverride) {
                // User deny rules override channel allows
                if (userOverride.denyRules) {
                  allRules.push(...userOverride.denyRules.map(rule => ({
                    ...rule,
                    priority: rule.priority ?? 200, // Even higher priority
                  })));
                }
                
                // User allow rules
                if (userOverride.allowRules) {
                  allRules.push(...userOverride.allowRules.map(rule => ({
                    ...rule,
                    priority: rule.priority ?? 100,
                  })));
                }
              }
            }
          }
        }
      }
    }
  } catch {
    // Scoped policy config not found or invalid - proceed with global rules only
  }
  
  return allRules;
}

/**
 * Merge scoped policies with global rules to produce effective rule set.
 * This is the main entry point for the channel policy system.
 */
export function mergeScopedPolicies(
  globalRules: PolicyRule[],
  scopedRules: PolicyRule[]
): PolicyRule[] {
  // Scoped rules are already enriched with priorities in getScopedRules
  // Here we just combine them with global rules
  
  // Filter out any disabled rules
  const enabledGlobal = globalRules.filter(r => r.enabled !== false);
  const enabledScoped = scopedRules.filter(r => r.enabled !== false);
  
  // Return combined and deduplicated rules
  const ruleMap = new Map<string, PolicyRule>();
  
  // Add global rules first (lower base priority)
  for (const rule of enabledGlobal) {
    ruleMap.set(rule.id, rule);
  }
  
  // Add scoped rules (may override global rules with same ID)
  for (const rule of enabledScoped) {
    ruleMap.set(rule.id, rule);
  }
  
  return Array.from(ruleMap.values());
}

// ============================================================================
// Configuration Loading
// ============================================================================

let cachedConfig: ScopedPolicyConfig | null = null;
let configLoadedAt: string = "";

function loadScopedPolicyConfig(): ScopedPolicyConfig | null {
  try {
    if (!existsSync(SCOPED_POLICY_FILE)) {
      return null;
    }
    
    const content = readFileSync(SCOPED_POLICY_FILE, "utf8");
    const config = JSON.parse(content) as ScopedPolicyConfig;
    
    cachedConfig = config;
    configLoadedAt = new Date().toISOString();
    
    return config;
  } catch {
    return null;
  }
}

/**
 * Get the scoped policy configuration.
 */
export function getScopedPolicyConfig(): ScopedPolicyConfig | null {
  if (!cachedConfig) {
    return loadScopedPolicyConfig();
  }
  return cachedConfig;
}

/**
 * Reload the scoped policy configuration from disk.
 */
export function reloadScopedPolicy(): ScopedPolicyConfig | null {
  cachedConfig = null;
  return loadScopedPolicyConfig();
}

/**
 * Validate a scoped policy configuration.
 */
export function validateScopedPolicyConfig(
  config: ScopedPolicyConfig
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!config.version) {
    errors.push("Missing version field");
  }
  
  if (!config.sources || typeof config.sources !== "object") {
    errors.push("Missing or invalid sources object");
  } else {
    for (const [source, sourceConfig] of Object.entries(config.sources)) {
      if (!sourceConfig.source) {
        errors.push(`Source "${source}" missing source field`);
      }
      
      if (sourceConfig.channels) {
        for (const [channelId, channelConfig] of Object.entries(sourceConfig.channels)) {
          if (channelConfig.channelId !== channelId) {
            errors.push(`Channel ${channelId} has mismatched channelId`);
          }
          
          // Validate nested rules
          if (channelConfig.denyRules) {
            for (const rule of channelConfig.denyRules) {
              if (!rule.id || !rule.tool || !rule.action) {
                errors.push(`Channel ${channelId} has invalid deny rule`);
              }
            }
          }
        }
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// Default Configuration Factory
// ============================================================================

/**
 * Create a default scoped policy configuration.
 */
export function createDefaultScopedPolicyConfig(): ScopedPolicyConfig {
  return {
    version: 1,
    sources: {},
    globalRules: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Get example configuration structure.
 */
export function getExampleScopedPolicyConfig(): ScopedPolicyConfig {
  return {
    version: 1,
    sources: {
      telegram: {
        source: "telegram",
        channels: {
          "telegram:123": {
            channelId: "telegram:123",
            denyRules: [
              {
                id: "telegram-123-deny-bash",
                priority: 200,
                tool: "Bash",
                action: "deny",
                reason: "Bash disabled in this channel",
              },
            ],
            allowRules: [
              {
                id: "telegram-123-allow-view",
                priority: 100,
                tool: ["View", "GlobTool", "GrepTool"],
                action: "allow",
                reason: "Read-only tools allowed",
              },
            ],
            userOverrides: {
              "admin-user": {
                userId: "admin-user",
                allowRules: [
                  {
                    id: "telegram-123-admin-allow-all",
                    priority: 200,
                    tool: "*",
                    action: "allow",
                    reason: "Admin has full access in this channel",
                  },
                ],
              },
            },
          },
        },
        defaultRules: [
          {
            id: "telegram-default-deny-edit",
            priority: 50,
            tool: "Edit",
            action: "require_approval",
            reason: "Edit requires approval on telegram by default",
          },
        ],
      },
      discord: {
        source: "discord",
        defaultRules: [
          {
            id: "discord-default-allow-view",
            priority: 50,
            tool: ["View", "GlobTool"],
            action: "allow",
            reason: "View tools allowed on discord",
          },
        ],
      },
    },
    globalRules: [
      {
        id: "global-deny-dangerous",
        priority: 100,
        tool: "Bash",
        action: "deny",
        reason: "Bash disabled globally unless explicitly allowed",
      },
    ],
    updatedAt: new Date().toISOString(),
  };
}
