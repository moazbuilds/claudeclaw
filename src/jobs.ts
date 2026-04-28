import { readdir } from "fs/promises";
import { join } from "path";
import { getJobsDir } from "./config";

export interface Job {
  name: string;
  schedule: string;
  prompt: string;
  recurring: boolean;
  notify: true | false | "error";
  /** When set, overrides the global model for this job. Useful for routing cheap tasks to haiku. */
  model?: string;
  /** When set, overrides the global session timeout for this job (in seconds). */
  timeoutSeconds?: number;
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

  const retryLine = lines.find((l) => l.startsWith("retry:"));
  const retry = retryLine ? parseInt(parseFrontmatterValue(retryLine.replace("retry:", "")), 10) || undefined : undefined;

  const retryDelayLine = lines.find((l) => l.startsWith("retry_delay:"));
  const retryDelay = retryDelayLine ? parseInt(parseFrontmatterValue(retryDelayLine.replace("retry_delay:", "")), 10) || undefined : undefined;

  return { name, schedule, prompt, recurring, notify, model, timeoutSeconds, retry, retryDelay };
}

export async function loadJobs(): Promise<Job[]> {
  const jobs: Job[] = [];
  let files: string[];
  try {
    files = await readdir(getJobsDir());
  } catch {
    return jobs;
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const content = await Bun.file(join(getJobsDir(), file)).text();
    const job = parseJobFile(file.replace(/\.md$/, ""), content);
    if (job) jobs.push(job);
  }
  return jobs;
}

export async function clearJobSchedule(jobName: string): Promise<void> {
  const path = join(getJobsDir(), `${jobName}.md`);
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
