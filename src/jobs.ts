import { readdir } from "fs/promises";
import { join } from "path";

const JOBS_DIR = join(process.cwd(), ".claude", "claudeclaw", "jobs");
const AGENTS_DIR = join(process.cwd(), "agents");

export interface Job {
  /** Scheduler key. For standalone jobs this is the file stem. For agent-scoped jobs this is "agent/label". */
  name: string;
  schedule: string;
  prompt: string;
  recurring: boolean;
  notify: true | false | "error";
  /** If set, this job is scoped to an agent. Triggers `--agent <name>` when fired. */
  agent?: string;
  /** Human-readable label for agent-scoped jobs (file stem). */
  label?: string;
  /** When false, the job is loaded but not scheduled. Defaults to true. */
  enabled?: boolean;
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
  const label = labelRaw || undefined;

  const enabledLine = lines.find((l) => l.startsWith("enabled:"));
  const enabledRaw = enabledLine
    ? parseFrontmatterValue(enabledLine.replace("enabled:", "")).toLowerCase()
    : "";
  const enabled =
    enabledRaw === "false" || enabledRaw === "no" || enabledRaw === "0"
      ? false
      : undefined;

  return { name, schedule, prompt, recurring, notify, agent, label, enabled };
}

export async function loadJobs(): Promise<Job[]> {
  const jobs: Job[] = [];

  // 1. Legacy / standalone scan: .claude/claudeclaw/jobs/*.md
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
    if (job.enabled !== false) jobs.push(job);
  }

  // 2. Agent-scoped scan: agents/<name>/jobs/*.md
  // agents/ lives at project root (outside .claude/), so Discord-triggered
  // file creation by the claude subprocess is not blocked by Claude Code's
  // hardcoded write protection on .claude/ paths.
  let agentDirs: string[] = [];
  try {
    agentDirs = await readdir(AGENTS_DIR);
  } catch {
    return jobs; // no agents/ at project root — nothing more to scan
  }
  for (const agentName of agentDirs) {
    const agentJobsDir = join(AGENTS_DIR, agentName, "jobs");
    let jobFiles: string[] = [];
    try {
      jobFiles = await readdir(agentJobsDir);
    } catch {
      continue; // agent has no jobs/ subdir — skip
    }
    for (const file of jobFiles) {
      if (!file.endsWith(".md")) continue;
      const labelFromFile = file.replace(/\.md$/, "");
      const content = await Bun.file(join(agentJobsDir, file)).text();
      const job = parseJobFile(`${agentName}/${labelFromFile}`, content);
      if (!job) continue;
      // Directory location is authoritative — override any frontmatter agent/label.
      job.agent = agentName;
      job.label = labelFromFile;
      if (job.enabled !== false) jobs.push(job);
    }
  }

  return jobs;
}

function resolveJobPath(jobName: string): string {
  const slash = jobName.indexOf("/");
  if (slash !== -1) {
    const agentName = jobName.slice(0, slash);
    const label = jobName.slice(slash + 1);
    return join(AGENTS_DIR, agentName, "jobs", `${label}.md`);
  }
  return join(JOBS_DIR, `${jobName}.md`);
}

export async function clearJobSchedule(jobName: string): Promise<void> {
  const path = resolveJobPath(jobName);
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
