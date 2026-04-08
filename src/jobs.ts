import { readdir } from "fs/promises";
import { join } from "path";

const JOBS_DIR = join(process.cwd(), ".claude", "claudeclaw", "jobs");
const AGENTS_DIR = join(process.cwd(), "agents");

export const VALID_MODEL_STRINGS: ReadonlySet<string> = new Set(["opus", "sonnet", "haiku", "glm"]);

export function validateModelString(value: string | undefined, context: string): void {
  if (value === undefined || value === "") return;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return;
  if (!VALID_MODEL_STRINGS.has(normalized)) {
    throw new Error(
      `Invalid model "${value}" in ${context}. ` +
        `Allowed: ${[...VALID_MODEL_STRINGS].join(", ")} (or omit for default)`,
    );
  }
}

export async function resolveJobModel(job: Job): Promise<string | undefined> {
  if (job.model && job.model.trim() !== "") return job.model.trim().toLowerCase();
  return undefined;
}

function ts(): string {
  return new Date().toLocaleTimeString();
}

export interface Job {
  name: string;
  schedule: string;
  prompt: string;
  recurring: boolean;
  notify: true | false | "error";
  agent?: string;
  label?: string;
  enabled?: boolean;
  model?: string;
}

function parseFrontmatterValue(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

function parseJobFile(name: string, content: string): Job | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    console.error(`Invalid job file format: ${name}`);
    return null;
  }

  const frontmatter = match[1];
  const prompt = match[2].trim();
  const lines = frontmatter.split("\n").map((l) => l.trim());

  const scheduleLine = lines.find((l) => l.startsWith("schedule:"));
  if (!scheduleLine) {
    return null;
  }

  const schedule = parseFrontmatterValue(scheduleLine.replace("schedule:", ""));

  const recurringLine = lines.find((l) => l.startsWith("recurring:"));
  const dailyLine = lines.find((l) => l.startsWith("daily:")); // legacy alias
  const recurringRaw = recurringLine
    ? parseFrontmatterValue(recurringLine.replace("recurring:", "")).toLowerCase()
    : dailyLine
    ? parseFrontmatterValue(dailyLine.replace("daily:", "")).toLowerCase()
    : "";
  const recurring = recurringRaw === "true" || recurringRaw === "yes" || recurringRaw === "1";

  const notifyLine = lines.find((l) => l.startsWith("notify:"));
  const notifyRaw = notifyLine
    ? parseFrontmatterValue(notifyLine.replace("notify:", "")).toLowerCase()
    : "";
  const notify: true | false | "error" =
    notifyRaw === "false" || notifyRaw === "no" ? false
    : notifyRaw === "error" ? "error"
    : true;

  const agentLine = lines.find((l) => l.startsWith("agent:"));
  const agentRaw = agentLine ? parseFrontmatterValue(agentLine.replace("agent:", "")) : "";
  const agent = agentRaw || undefined;

  const labelLine = lines.find((l) => l.startsWith("label:"));
  const labelRaw = labelLine ? parseFrontmatterValue(labelLine.replace("label:", "")) : "";
  const label = labelRaw || name;

  const enabledLine = lines.find((l) => l.startsWith("enabled:"));
  const enabledRaw = enabledLine
    ? parseFrontmatterValue(enabledLine.replace("enabled:", "")).toLowerCase()
    : "";
  const enabled = !(enabledRaw === "false" || enabledRaw === "no");

  const modelLine = lines.find((l) => l.startsWith("model:"));
  const modelRaw = modelLine ? parseFrontmatterValue(modelLine.replace("model:", "")) : "";
  const model = modelRaw || undefined;

  return { name, schedule, prompt, recurring, notify, agent, label, enabled, model };
}

export async function loadJobs(): Promise<Job[]> {
  const jobs: Job[] = [];

  // 1. Flat-dir scan (legacy + standalone non-agent jobs)
  let flatFiles: string[] = [];
  try {
    flatFiles = await readdir(JOBS_DIR);
  } catch {
    /* missing dir is fine */
  }
  for (const file of flatFiles) {
    if (!file.endsWith(".md")) continue;
    const content = await Bun.file(join(JOBS_DIR, file)).text();
    const job = parseJobFile(file.replace(/\.md$/, ""), content);
    if (!job) continue;
    try {
      validateModelString(job.model, `standalone/${job.label ?? job.name}`);
    } catch (err) {
      console.error(`[${ts()}] Skipping job ${job.name}: ${(err as Error).message}`);
      continue;
    }
    if (job.enabled !== false) jobs.push(job);
  }

  // 2. agents/<name>/jobs/*.md scan (Phase 17)
  let agentDirs: string[] = [];
  try {
    agentDirs = await readdir(AGENTS_DIR);
  } catch {
    return jobs;
  }
  for (const agentName of agentDirs) {
    const agentJobsDir = join(AGENTS_DIR, agentName, "jobs");
    let jobFiles: string[] = [];
    try {
      jobFiles = await readdir(agentJobsDir);
    } catch {
      continue;
    }
    for (const file of jobFiles) {
      if (!file.endsWith(".md")) continue;
      const labelFromFile = file.replace(/\.md$/, "");
      const content = await Bun.file(join(agentJobsDir, file)).text();
      const job = parseJobFile(`${agentName}/${labelFromFile}`, content);
      if (!job) continue;
      // Directory location is authoritative.
      job.agent = agentName;
      job.label = labelFromFile;
      try {
        validateModelString(job.model, `${agentName}/${labelFromFile}`);
      } catch (err) {
        console.error(`[${ts()}] Skipping job ${agentName}:${labelFromFile}: ${(err as Error).message}`);
        continue;
      }
      if (job.enabled === false) continue;
      jobs.push(job);
    }
  }

  return jobs;
}

/**
 * Load all jobs for a given agent WITHOUT filtering disabled ones.
 * Used by `fire` (manual invocation) to allow firing disabled jobs on demand.
 * Returns [] if the agent directory or its jobs/ subdir doesn't exist.
 */
export async function loadAgentJobsUnfiltered(agentName: string): Promise<Job[]> {
  const jobs: Job[] = [];
  const agentJobsDir = join(AGENTS_DIR, agentName, "jobs");
  let jobFiles: string[] = [];
  try {
    jobFiles = await readdir(agentJobsDir);
  } catch {
    return jobs;
  }
  for (const file of jobFiles) {
    if (!file.endsWith(".md")) continue;
    const labelFromFile = file.replace(/\.md$/, "");
    const content = await Bun.file(join(agentJobsDir, file)).text();
    const job = parseJobFile(`${agentName}/${labelFromFile}`, content);
    if (!job) continue;
    job.agent = agentName;
    job.label = labelFromFile;
    jobs.push(job);
  }
  return jobs;
}

/** Returns true if `agents/<name>/` exists on disk. */
export async function agentDirExists(agentName: string): Promise<boolean> {
  try {
    await readdir(join(AGENTS_DIR, agentName));
    return true;
  } catch {
    return false;
  }
}

export async function clearJobSchedule(jobName: string): Promise<void> {
  const path = join(JOBS_DIR, `${jobName}.md`);
  const content = await Bun.file(path).text();
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return;

  const filteredFrontmatter = match[1]
    .split("\n")
    .filter((line) => !line.trim().startsWith("schedule:"))
    .join("\n")
    .trim();

  const body = match[2].trim();
  const next = `---\n${filteredFrontmatter}\n---\n${body}\n`;
  await Bun.write(path, next);
}
