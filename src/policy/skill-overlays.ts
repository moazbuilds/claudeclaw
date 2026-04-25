/**
 * Skill Policy Overlays
 * 
 * Allow skills to declare tool constraints that integrate with the policy engine.
 * Skill overlays are translated into policy-relevant constraints.
 * 
 * IMPORTANT: Skill overlays must not become a privilege-escalation path.
 * - "preferredTools" influences recommendation, not security overrides
 * - "requiredTools" surfaces actionable policy errors when unavailable
 * - "deniedTools" are enforced as restrictions even when globally allowed
 */

import {
  type PolicyRule,
  type ToolRequestContext,
} from "./engine";
import { resolveSkillPrompt } from "../skills";

// ============================================================================
// Types
// ============================================================================

export interface SkillOverlay {
  skillName: string;
  requiredTools?: string[];
  preferredTools?: string[];
  deniedTools?: string[];
  reason?: string;
}

export interface SkillPolicyResult {
  allowed: boolean;
  reason: string;
  skillOverlay?: SkillOverlay;
  missingTools?: string[];
  deniedTools?: string[];
}

// ============================================================================
// Skill Metadata Parsing
// ============================================================================

/**
 * Parse skill metadata from SKILL.md content.
 * Looks for policy-related frontmatter fields.
 */
export function parseSkillMetadata(skillContent: string, skillName: string): SkillOverlay | null {
  // Parse YAML frontmatter
  const fmMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return null;
  }
  
  const fm = fmMatch[1];
  
  // Look for policy-related fields
  let requiredTools: string[] | undefined;
  let preferredTools: string[] | undefined;
  let deniedTools: string[] | undefined;
  
  // Helper to parse array fields (handles both multiline and inline formats)
  function parseArrayField(fieldName: string): string[] | undefined {
    // Match multiline format:
    // requiredTools:
    //   - item1
    //   - item2
    const multilineMatch = fm.match(new RegExp(`^${fieldName}:\\s*\\n((?:\\s*-\\s*.+\\n?)+)`, 'm'));
    if (multilineMatch) {
      return multilineMatch[1]
        .split("\n")
        .map(line => line.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean);
    }
    
    // Match inline empty array: requiredTools: []
    const emptyMatch = fm.match(new RegExp(`^${fieldName}:\\s*\\[\\s*\\]`, 'm'));
    if (emptyMatch) {
      return [];
    }
    
    // Match inline array: requiredTools: [item1, item2]
    const inlineMatch = fm.match(new RegExp(`^${fieldName}:\\s*\\[([^\\]]+)\\]`, 'm'));
    if (inlineMatch) {
      return inlineMatch[1]
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
    }
    
    return undefined;
  }
  
  // Parse requiredTools
  const parsedRequired = parseArrayField("requiredTools");
  if (parsedRequired !== undefined) {
    requiredTools = parsedRequired;
  }
  
  // Parse preferredTools
  const parsedPreferred = parseArrayField("preferredTools");
  if (parsedPreferred !== undefined) {
    preferredTools = parsedPreferred;
  }
  
  // Parse deniedTools
  const parsedDenied = parseArrayField("deniedTools");
  if (parsedDenied !== undefined) {
    deniedTools = parsedDenied;
  }
  
  // If no policy fields found, return null
  if (!requiredTools && !preferredTools && !deniedTools) {
    return null;
  }
  
  return {
    skillName,
    requiredTools,
    preferredTools,
    deniedTools,
  };
}

// ============================================================================
// Skill Overlay Resolution
// ============================================================================

/**
 * Get the skill overlay for a given skill name.
 * Loads and parses the skill's SKILL.md to extract policy metadata.
 */
export async function getSkillOverlay(skillName: string): Promise<SkillOverlay | null> {
  // Resolve skill prompt (reads SKILL.md)
  const content = await resolveSkillPrompt(skillName);
  if (!content) {
    return null;
  }
  
  return parseSkillMetadata(content, skillName);
}

/**
 * Get skill overlay synchronously from cached content.
 */
export function getSkillOverlayFromContent(content: string, skillName: string): SkillOverlay | null {
  return parseSkillMetadata(content, skillName);
}

// ============================================================================
// Overlay to Rules Conversion
// ============================================================================

/**
 * Convert a skill overlay into policy rules.
 * 
 * Rules generated:
 * - deniedTools → high-priority deny rules (restrictive)
 * - requiredTools → no direct rules, tracked for validation
 * - preferredTools → informational only (not security-critical)
 */
export function overlayToRules(overlay: SkillOverlay, basePriority: number = 100): PolicyRule[] {
  const rules: PolicyRule[] = [];
  
  // Denied tools become deny rules (high priority)
  if (overlay.deniedTools && overlay.deniedTools.length > 0) {
    for (const tool of overlay.deniedTools) {
      rules.push({
        id: `skill-${overlay.skillName}-deny-${tool}`,
        priority: basePriority + 50, // Higher than typical rules
        scope: {
          skillName: overlay.skillName,
        },
        tool,
        action: "deny",
        reason: overlay.reason || `Tool ${tool} denied by skill ${overlay.skillName} policy`,
      });
    }
  }
  
  return rules;
}

// ============================================================================
// Skill Policy Evaluation
// ============================================================================

/**
 * Evaluate a tool request in the context of skill policy.
 * Checks if the requested tool is allowed given the skill's policy overlay.
 */
export function evaluateSkillPolicy(
  overlay: SkillOverlay,
  toolName: string
): SkillPolicyResult {
  // Check if tool is explicitly denied
  if (overlay.deniedTools && overlay.deniedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool ${toolName} is explicitly denied by skill ${overlay.skillName}`,
      skillOverlay: overlay,
      deniedTools: [toolName],
    };
  }
  
  // Check if required tools are missing (but not for the requested tool)
  if (overlay.requiredTools) {
    const missingTools = overlay.requiredTools.filter(t => t !== toolName);
    if (missingTools.length > 0) {
      // Tool requested is not missing, but some required tools might be
      // This is informational - not a blocking error
    }
  }
  
  // If we get here, the tool is allowed by the skill overlay
  return {
    allowed: true,
    reason: `Tool ${toolName} is allowed by skill ${overlay.skillName} policy`,
    skillOverlay: overlay,
  };
}

/**
 * Validate that all required tools for a skill are available.
 * Returns information about missing required tools.
 */
export function validateRequiredTools(
  overlay: SkillOverlay,
  availableTools: string[]
): { valid: boolean; missingTools: string[] } {
  if (!overlay.requiredTools || overlay.requiredTools.length === 0) {
    return { valid: true, missingTools: [] };
  }
  
  const missingTools = overlay.requiredTools.filter(
    required => !availableTools.includes(required)
  );
  
  return {
    valid: missingTools.length === 0,
    missingTools,
  };
}

// ============================================================================
// Example Skill Overlays
// ============================================================================

/**
 * Get example skill overlay configurations for documentation.
 */
export function getExampleSkillOverlays(): Record<string, SkillOverlay> {
  return {
    "code-review": {
      skillName: "code-review",
      requiredTools: ["View", "GlobTool", "GrepTool"],
      preferredTools: ["View", "GlobTool", "GrepTool"],
      deniedTools: ["Bash", "Edit", "Write"],
      reason: "Code review skill is read-only by default",
    },
    "web-scrape": {
      skillName: "web-scrape",
      requiredTools: ["WebFetch", "Bash"],
      preferredTools: ["WebFetch"],
      deniedTools: [],
      reason: "Web scraping requires network access and shell",
    },
    "admin": {
      skillName: "admin",
      requiredTools: ["Bash", "Write", "Edit", "View"],
      preferredTools: ["Bash", "Write", "Edit", "View"],
      deniedTools: [],
      reason: "Admin skill has full tool access",
    },
  };
}
