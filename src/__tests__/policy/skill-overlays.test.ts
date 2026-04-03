/**
 * Tests for policy/skill-overlays.ts
 * 
 * Run with: bun test src/__tests__/policy/skill-overlays.test.ts
 */

import { describe, it, expect } from "bun:test";
import {
  parseSkillMetadata,
  getSkillOverlayFromContent,
  overlayToRules,
  evaluateSkillPolicy,
  validateRequiredTools,
  getExampleSkillOverlays,
  type SkillOverlay,
} from "../../policy/skill-overlays";

describe("Skill Overlays - Metadata Parsing", () => {
  it("should parse requiredTools from SKILL.md frontmatter", () => {
    const content = `---
requiredTools:
  - View
  - GlobTool
  - GrepTool
---

# Skill Content
`;
    
    const overlay = parseSkillMetadata(content, "test-skill");
    expect(overlay).not.toBeNull();
    expect(overlay?.requiredTools).toEqual(["View", "GlobTool", "GrepTool"]);
  });

  it("should parse preferredTools from SKILL.md frontmatter", () => {
    const content = `---
preferredTools:
  - View
  - Bash
---

# Skill Content
`;
    
    const overlay = parseSkillMetadata(content, "test-skill");
    expect(overlay).not.toBeNull();
    expect(overlay?.preferredTools).toEqual(["View", "Bash"]);
  });

  it("should parse deniedTools from SKILL.md frontmatter", () => {
    const content = `---
deniedTools:
  - Bash
  - Edit
---

# Skill Content
`;
    
    const overlay = parseSkillMetadata(content, "test-skill");
    expect(overlay).not.toBeNull();
    expect(overlay?.deniedTools).toEqual(["Bash", "Edit"]);
  });

  it("should parse all policy fields together", () => {
    const content = `---
requiredTools:
  - View
preferredTools:
  - View
  - GrepTool
deniedTools:
  - Bash
---

# Skill Content
`;
    
    const overlay = parseSkillMetadata(content, "code-review");
    expect(overlay).not.toBeNull();
    expect(overlay?.skillName).toBe("code-review");
    expect(overlay?.requiredTools).toEqual(["View"]);
    expect(overlay?.preferredTools).toEqual(["View", "GrepTool"]);
    expect(overlay?.deniedTools).toEqual(["Bash"]);
  });

  it("should return null when no policy fields present", () => {
    const content = `---
description: A test skill
---

# Skill Content
`;
    
    const overlay = parseSkillMetadata(content, "test-skill");
    expect(overlay).toBeNull();
  });

  it("should return null for content without frontmatter", () => {
    const content = `# Skill Content
This is just regular markdown content.
`;
    
    const overlay = parseSkillMetadata(content, "test-skill");
    expect(overlay).toBeNull();
  });

  it("should handle empty tool lists", () => {
    const content = `---
requiredTools: []
preferredTools: []
deniedTools: []
---

# Skill Content
`;
    
    const overlay = parseSkillMetadata(content, "test-skill");
    expect(overlay).not.toBeNull();
    expect(overlay?.requiredTools).toEqual([]);
    expect(overlay?.preferredTools).toEqual([]);
    expect(overlay?.deniedTools).toEqual([]);
  });
});

describe("Skill Overlays - Overlay to Rules Conversion", () => {
  it("should convert denied tools to deny rules", () => {
    const overlay: SkillOverlay = {
      skillName: "code-review",
      deniedTools: ["Bash", "Edit"],
    };
    
    const rules = overlayToRules(overlay);
    
    expect(rules).toHaveLength(2);
    
    const bashRule = rules.find(r => r.tool === "Bash");
    expect(bashRule).toBeDefined();
    expect(bashRule?.action).toBe("deny");
    expect(bashRule?.scope?.skillName).toBe("code-review");
    expect(bashRule?.id).toContain("code-review");
    
    const editRule = rules.find(r => r.tool === "Edit");
    expect(editRule).toBeDefined();
    expect(editRule?.action).toBe("deny");
  });

  it("should not create rules for empty deniedTools", () => {
    const overlay: SkillOverlay = {
      skillName: "read-only",
      deniedTools: [],
    };
    
    const rules = overlayToRules(overlay);
    expect(rules).toHaveLength(0);
  });

  it("should use custom base priority when provided", () => {
    const overlay: SkillOverlay = {
      skillName: "test",
      deniedTools: ["Bash"],
    };
    
    const rules = overlayToRules(overlay, 200);
    expect(rules[0].priority).toBe(250); // base + 50
  });

  it("should not create rules for preferredTools or requiredTools", () => {
    const overlay: SkillOverlay = {
      skillName: "test",
      requiredTools: ["View"],
      preferredTools: ["View", "GrepTool"],
    };
    
    const rules = overlayToRules(overlay);
    expect(rules).toHaveLength(0);
  });
});

describe("Skill Overlays - Policy Evaluation", () => {
  it("should deny when tool is in deniedTools", () => {
    const overlay: SkillOverlay = {
      skillName: "code-review",
      deniedTools: ["Bash", "Edit"],
    };
    
    const result = evaluateSkillPolicy(overlay, "Bash");
    
    expect(result.allowed).toBe(false);
    expect(result.deniedTools).toContain("Bash");
    expect(result.skillOverlay).toBe(overlay);
  });

  it("should allow when tool is not in deniedTools", () => {
    const overlay: SkillOverlay = {
      skillName: "code-review",
      deniedTools: ["Bash", "Edit"],
    };
    
    const result = evaluateSkillPolicy(overlay, "View");
    
    expect(result.allowed).toBe(true);
    expect(result.deniedTools).toBeUndefined();
  });

  it("should handle empty deniedTools", () => {
    const overlay: SkillOverlay = {
      skillName: "open-skill",
      deniedTools: [],
    };
    
    const result = evaluateSkillPolicy(overlay, "Bash");
    expect(result.allowed).toBe(true);
  });

  it("should handle overlay with no deniedTools", () => {
    const overlay: SkillOverlay = {
      skillName: "basic-skill",
    };
    
    const result = evaluateSkillPolicy(overlay, "View");
    expect(result.allowed).toBe(true);
  });
});

describe("Skill Overlays - Required Tools Validation", () => {
  it("should validate all required tools are available", () => {
    const overlay: SkillOverlay = {
      skillName: "code-review",
      requiredTools: ["View", "GlobTool", "GrepTool"],
    };
    
    const availableTools = ["View", "GlobTool", "GrepTool", "Bash"];
    const result = validateRequiredTools(overlay, availableTools);
    
    expect(result.valid).toBe(true);
    expect(result.missingTools).toHaveLength(0);
  });

  it("should detect missing required tools", () => {
    const overlay: SkillOverlay = {
      skillName: "code-review",
      requiredTools: ["View", "GlobTool", "GrepTool"],
    };
    
    const availableTools = ["View", "Bash"];
    const result = validateRequiredTools(overlay, availableTools);
    
    expect(result.valid).toBe(false);
    expect(result.missingTools).toContain("GlobTool");
    expect(result.missingTools).toContain("GrepTool");
  });

  it("should handle empty requiredTools", () => {
    const overlay: SkillOverlay = {
      skillName: "basic-skill",
      requiredTools: [],
    };
    
    const result = validateRequiredTools(overlay, []);
    expect(result.valid).toBe(true);
  });

  it("should handle undefined requiredTools", () => {
    const overlay: SkillOverlay = {
      skillName: "basic-skill",
    };
    
    const result = validateRequiredTools(overlay, []);
    expect(result.valid).toBe(true);
  });
});

describe("Skill Overlays - Example Configurations", () => {
  it("should provide valid example overlays", () => {
    const examples = getExampleSkillOverlays();
    
    // Code review should be read-only
    const codeReview = examples["code-review"];
    expect(codeReview.deniedTools).toContain("Bash");
    expect(codeReview.deniedTools).toContain("Edit");
    expect(codeReview.deniedTools).toContain("Write");
    expect(codeReview.requiredTools).toContain("View");
    
    // Admin should have full access
    const admin = examples["admin"];
    expect(admin.deniedTools).toHaveLength(0);
    expect(admin.requiredTools).toContain("Bash");
    
    // Web scrape needs network
    const webScrape = examples["web-scrape"];
    expect(webScrape.requiredTools).toContain("WebFetch");
    expect(webScrape.requiredTools).toContain("Bash");
  });
});
