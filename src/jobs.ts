import { readdir } from "fs/promises";
import { join } from "path";

const JOBS_DIR = join(process.cwd(), ".claude", "claudeclaw", "jobs");

export interface Job {
  name: string;
  schedule: string;
  prompt: string;
  recurring: boolean;
  notify: true | false | "error";
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

  return { name, schedule, prompt, recurring, notify };
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

/**
 * Snapshot a job file's frontmatter before execution.
 * Returns a restore function that re-applies the original frontmatter
 * if Claude overwrote or stripped it during the run.
 */
export async function snapshotJobFrontmatter(
  jobName: string
): Promise<() => Promise<boolean>> {
  const path = join(JOBS_DIR, `${jobName}.md`);
  let originalContent: string;
  try {
    originalContent = await Bun.file(path).text();
  } catch {
    return async () => false;
  }

  const originalMatch = originalContent.match(
    /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/
  );
  if (!originalMatch) return async () => false;

  const originalFrontmatter = originalMatch[1];

  return async () => {
    let currentContent: string;
    try {
      currentContent = await Bun.file(path).text();
    } catch {
      return false;
    }

    const currentMatch = currentContent.match(
      /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/
    );

    // File completely mangled — restore entire original
    if (!currentMatch) {
      await Bun.write(path, originalContent);
      return true;
    }

    // Frontmatter was modified — restore it, keep current body
    if (currentMatch[1].trim() !== originalFrontmatter.trim()) {
      const restoredBody = currentMatch[2].trim();
      const restored = `---\n${originalFrontmatter}\n---\n${restoredBody}\n`;
      await Bun.write(path, restored);
      return true;
    }

    return false;
  };
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
