import { readdir } from "fs/promises";
import { join } from "path";
import { getJobsDir, getAgentsDir } from "./config";

export interface Job {
  /** Scheduler key. For standalone jobs this is the file stem. For agent-scoped jobs this is "agent/label". */
  name: string;
  schedule: string;
  prompt: string;
  recurring: boolean;
  notify: true | false | "error";
  /** When set, overrides the global model for this job. Useful for routing cheap tasks to haiku. */
  model?: string;
  /** When set, overrides the global session timeout for this job (in seconds). */
  timeoutSeconds?: number;
  /** If set, this job is scoped to an agent. */
  agent?: string;
  /** Human-readable label for agent-scoped jobs (file stem). */
  label?: string;
  /** When false, the job is loaded but not scheduled. Defaults to true. */
  enabled?: boolean;
  /** Max number of retry attempts on failure before giving up until next scheduled run. */
  retry?: number;
  /** Seconds to wait between retry attempts. Defaults to 300 (5 min). */
  retryDelay?: number;
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

  const modelLine = lines.find((l) => l.startsWith("model:"));
  const model = modelLine ? parseFrontmatterValue(modelLine.replace("model:", "")) || undefined : undefined;

  const timeoutLine = lines.find((l) => l.startsWith("timeout:"));
  const timeoutRaw = timeoutLine ? parseFrontmatterValue(timeoutLine.replace("timeout:", "")) : "";
  const timeoutParsed = timeoutRaw ? parseInt(timeoutRaw, 10) : NaN;
  const timeoutSeconds = Number.isFinite(timeoutParsed) && timeoutParsed > 0 ? timeoutParsed : undefined;

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

  const retryLine = lines.find((l) => l.startsWith("retry:"));
  const retry = retryLine ? parseInt(parseFrontmatterValue(retryLine.replace("retry:", "")), 10) || undefined : undefined;

  const retryDelayLine = lines.find((l) => l.startsWith("retry_delay:"));
  const retryDelay = retryDelayLine ? parseInt(parseFrontmatterValue(retryDelayLine.replace("retry_delay:", "")), 10) || undefined : undefined;

  return { name, schedule, prompt, recurring, notify, model, timeoutSeconds, agent, label, enabled, retry, retryDelay };
}

export async function loadJobs(): Promise<Job[]> {
  const jobs: Job[] = [];

  let flatFiles: string[] = [];
  try {
    flatFiles = await readdir(getJobsDir());
  } catch {
    /* missing dir is fine */
  }
  for (const file of flatFiles) {
    if (!file.endsWith(".md")) continue;
    const content = await Bun.file(join(getJobsDir(), file)).text();
    const job = parseJobFile(file.replace(/\.md$/, ""), content);
    if (!job) continue;
    if (job.enabled !== false) jobs.push(job);
  }

  // agents/ lives at project root (outside .claude/), so agent-managed jobs are writable by Claude Code.
  let agentDirs: string[] = [];
  try {
    agentDirs = await readdir(getAgentsDir());
  } catch {
    return jobs;
  }
  for (const agentName of agentDirs) {
    const agentJobsDir = join(getAgentsDir(), agentName, "jobs");
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
      job.agent = agentName;
      job.label = labelFromFile;
      if (job.enabled !== false) jobs.push(job);
    }
  }

  return jobs;
}

function resolveJobPath(jobName: string): string {
  const slash = jobName.indexOf("/");
  if (slash > 0 && slash < jobName.length - 1) {
    const agentName = jobName.slice(0, slash);
    const label = jobName.slice(slash + 1);
    return join(getAgentsDir(), agentName, "jobs", `${label}.md`);
  }
  return join(getJobsDir(), `${jobName}.md`);
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
