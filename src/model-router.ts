/**
 * Intelligent model routing based on task type.
 * Routes planning/thinking tasks to Opus, implementation tasks to Sonnet.
 */

export type TaskType = "planning" | "implementation";

interface TaskClassification {
  type: TaskType;
  confidence: number;
  reasoning: string;
}

// Keywords that strongly indicate planning/thinking tasks (Opus)
const PLANNING_KEYWORDS = [
  "plan", "design", "architect", "strategy", "approach",
  "research", "investigate", "analyze", "explore", "understand",
  "think", "consider", "evaluate", "assess", "review",
  "system design", "trade-off", "decision", "choose", "compare",
  "why", "how should", "what if", "pros and cons",
  "brainstorm", "ideate", "concept", "proposal",
];

// Keywords that strongly indicate implementation tasks (Sonnet)
const IMPLEMENTATION_KEYWORDS = [
  "implement", "code", "write", "create", "build", "add",
  "fix", "debug", "refactor", "update", "modify", "change",
  "deploy", "run", "execute", "install", "configure",
  "test", "commit", "push", "merge", "release",
  "generate", "scaffold", "setup", "initialize",
];

// Phrases that indicate planning even if implementation keywords are present
const PLANNING_PHRASES = [
  "how to implement",
  "how should i implement",
  "what's the best way to",
  "should i",
  "which approach",
  "help me decide",
  "help me understand",
];

/**
 * Classify a prompt to determine which model should handle it.
 */
export function classifyTask(prompt: string): TaskClassification {
  const normalized = prompt.toLowerCase().trim();

  // Check for planning phrases first (highest priority)
  for (const phrase of PLANNING_PHRASES) {
    if (normalized.includes(phrase)) {
      return {
        type: "planning",
        confidence: 0.95,
        reasoning: `Contains planning phrase: "${phrase}"`,
      };
    }
  }

  // Count keyword matches
  let planningScore = 0;
  let implementationScore = 0;

  for (const keyword of PLANNING_KEYWORDS) {
    if (normalized.includes(keyword)) {
      planningScore++;
    }
  }

  for (const keyword of IMPLEMENTATION_KEYWORDS) {
    if (normalized.includes(keyword)) {
      implementationScore++;
    }
  }

  // Question marks often indicate planning/research
  const questionMarks = (normalized.match(/\?/g) || []).length;
  if (questionMarks > 0) {
    planningScore += questionMarks * 0.5;
  }

  // Determine task type based on scores
  if (planningScore > implementationScore) {
    const confidence = Math.min(0.9, 0.6 + (planningScore - implementationScore) * 0.1);
    return {
      type: "planning",
      confidence,
      reasoning: `Planning keywords: ${planningScore}, Implementation keywords: ${implementationScore}`,
    };
  } else if (implementationScore > planningScore) {
    const confidence = Math.min(0.9, 0.6 + (implementationScore - planningScore) * 0.1);
    return {
      type: "implementation",
      confidence,
      reasoning: `Implementation keywords: ${implementationScore}, Planning keywords: ${planningScore}`,
    };
  }

  // Default to planning for ambiguous cases (safer choice)
  return {
    type: "planning",
    confidence: 0.5,
    reasoning: "Ambiguous prompt, defaulting to planning model",
  };
}

/**
 * Select the appropriate model based on task classification.
 * Returns the model identifier to use.
 */
export function selectModel(
  prompt: string,
  opusModel: string,
  sonnetModel: string
): { model: string; taskType: TaskType; reasoning: string } {
  const classification = classifyTask(prompt);

  const model = classification.type === "planning" ? opusModel : sonnetModel;

  return {
    model,
    taskType: classification.type,
    reasoning: classification.reasoning,
  };
}
