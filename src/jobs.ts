import { readdir } from "fs/promises";
import { join } from "path";

const JOBS_DIR = join(process.cwd(), ".claude", "claudeclaw", "jobs");

export interface Job {
  name: string;
  schedule: string;
  prompt: string;
  recurring: boolean;
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

  return { name, schedule, prompt, recurring };
}

export async function loadJobs(): Promise<Job[]> {
  const jobs: Job[] = [];
  let files: string[];
  try {
    files = await readdir(JOBS_DIR);
  } catch {
    return jobs;
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const content = await Bun.file(join(JOBS_DIR, file)).text();
    const job = parseJobFile(file.replace(/\.md$/, ""), content);
    if (job) jobs.push(job);
  }
  return jobs;
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
