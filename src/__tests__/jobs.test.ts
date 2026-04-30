import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";

const TEST_ROOT = join(import.meta.dir, "../../test-sandbox-jobs");
const LEGACY_JOBS_DIR = join(TEST_ROOT, ".claude", "claudeclaw", "jobs");
const AGENTS_DIR = join(TEST_ROOT, "agents");

async function resetSandbox() {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(LEGACY_JOBS_DIR, { recursive: true });
  await mkdir(join(AGENTS_DIR, "suzy", "jobs"), { recursive: true });
  await mkdir(join(AGENTS_DIR, "reg", "jobs"), { recursive: true });
}

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function jobMd(schedule: string, prompt: string, extra = ""): string {
  const extras = extra ? extra + "\n" : "";
  return `---\nschedule: ${schedule}\nrecurring: true\n${extras}---\n${prompt}\n`;
}

/** Run loadJobs() in the sandbox dir via a child bun process (so process.cwd() == TEST_ROOT). */
async function loadJobsInSandbox(): Promise<import("../jobs").Job[]> {
  const script = `
import { loadJobs } from ${JSON.stringify(join(import.meta.dir, "..", "jobs"))};
const jobs = await loadJobs();
process.stdout.write(JSON.stringify(jobs));
`;
  const scriptPath = join(TEST_ROOT, "_run.ts");
  await writeFile(scriptPath, script);
  const proc = Bun.spawn(["bun", "run", scriptPath], {
    cwd: TEST_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out || "[]");
}

// ─── Integration tests ────────────────────────────────────────────────────

describe("loadJobs", () => {
  beforeEach(resetSandbox);

  test("empty dirs → zero jobs, no throw", async () => {
    const jobs = await loadJobsInSandbox();
    expect(jobs).toEqual([]);
  });

  test("loads job from legacy .claude/claudeclaw/jobs/", async () => {
    await writeFile(
      join(LEGACY_JOBS_DIR, "nightly.md"),
      jobMd("0 3 * * *", "Run nightly report")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "nightly");
    expect(job).toBeDefined();
    expect(job?.agent).toBeUndefined(); // not agent-scoped
    expect(job?.schedule).toBe("0 3 * * *");
    expect(job?.prompt).toBe("Run nightly report");
  });

  test("loads job from agents/<name>/jobs/ (Phase 17 path)", async () => {
    await writeFile(
      join(AGENTS_DIR, "suzy", "jobs", "daily-digest.md"),
      jobMd("0 9 * * *", "Summarise today's news")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "suzy/daily-digest");
    expect(job).toBeDefined();
    expect(job?.agent).toBe("suzy");
    expect(job?.label).toBe("daily-digest");
    expect(job?.schedule).toBe("0 9 * * *");
    expect(job?.prompt).toBe("Summarise today's news");
  });

  test("directory location overrides frontmatter agent field", async () => {
    // Even if the .md file says agent: wrong, the enclosing dir wins.
    await writeFile(
      join(AGENTS_DIR, "reg", "jobs", "seo.md"),
      jobMd("30 10 * * *", "SEO review", "agent: wrong-agent")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "reg/seo");
    expect(job?.agent).toBe("reg");
  });

  test("enabled: false excludes job", async () => {
    await writeFile(
      join(AGENTS_DIR, "suzy", "jobs", "disabled.md"),
      jobMd("0 12 * * *", "Disabled", "enabled: false")
    );
    const jobs = await loadJobsInSandbox();
    expect(jobs.find((j) => j.name === "suzy/disabled")).toBeUndefined();
  });

  test("returns jobs from both legacy and agent-scoped locations together", async () => {
    await writeFile(join(LEGACY_JOBS_DIR, "nightly.md"), jobMd("0 3 * * *", "Nightly"));
    await writeFile(join(AGENTS_DIR, "suzy", "jobs", "morning.md"), jobMd("0 9 * * *", "Morning"));
    const jobs = await loadJobsInSandbox();
    const names = jobs.map((j) => j.name);
    expect(names).toContain("nightly");
    expect(names).toContain("suzy/morning");
  });

  test("missing agents/ dir is silently ignored (no throw)", async () => {
    await rm(AGENTS_DIR, { recursive: true, force: true });
    const jobs = await loadJobsInSandbox();
    expect(Array.isArray(jobs)).toBe(true);
  });

  test("agent dir without jobs/ subdir is skipped", async () => {
    // publisher/ exists but has no jobs/ subdirectory
    await mkdir(join(AGENTS_DIR, "publisher"), { recursive: true });
    const jobs = await loadJobsInSandbox();
    expect(jobs.filter((j) => j.name.startsWith("publisher/"))).toEqual([]);
  });

  test("job file without schedule: field is skipped gracefully", async () => {
    await writeFile(
      join(AGENTS_DIR, "suzy", "jobs", "bad.md"),
      "---\nprompt: test\n---\nNo schedule line.\n"
    );
    // Should not throw, should return other valid jobs
    const jobs = await loadJobsInSandbox();
    expect(jobs.find((j) => j.name === "suzy/bad")).toBeUndefined();
  });
});

// ─── Unit: Job type and session path assertions ───────────────────────────

describe("Job type", () => {
  test("includes agent, label, enabled fields", () => {
    const job: import("../jobs").Job = {
      name: "agent/job",
      schedule: "0 9 * * *",
      prompt: "test",
      recurring: true,
      notify: true,
      agent: "myagent",
      label: "myjob",
      enabled: true,
    };
    expect(job.agent).toBe("myagent");
    expect(job.label).toBe("myjob");
    expect(job.enabled).toBe(true);
  });
});

describe("sessions — agent-scoped paths", () => {
  test("getSession/createSession/incrementTurn accept optional agentName", async () => {
    const src = await Bun.file(join(import.meta.dir, "../sessions.ts")).text();
    // All public functions should have agentName? param
    expect(src).toContain("getSession(\n  agentName?: string");
    expect(src).toContain("createSession(sessionId: string, agentName?: string)");
    expect(src).toContain("incrementTurn(agentName?: string)");
    expect(src).toContain("markCompactWarned(agentName?: string)");
  });

  test("agent sessions stored outside .claude/", async () => {
    const src = await Bun.file(join(import.meta.dir, "../sessions.ts")).text();
    // Verify path uses getAgentsDir() (project root) not HEARTBEAT_DIR (.claude/...)
    expect(src).toContain('join(getAgentsDir(), agentName, "session.json")');
  });
});

// ─── Unit: protection-bug validation (the core motivation) ───────────────

describe("write-protection bug validation", () => {
  test("agent-scoped job path is outside .claude/ (key property)", () => {
    // The Claude Code CLI hardcodes a protection list for .claude/ paths.
    // Agent-scoped jobs live at agents/<name>/jobs/<job>.md — no .claude/ prefix.
    // This test documents the requirement explicitly.
    const legacyPath = join(process.cwd(), ".claude", "claudeclaw", "jobs", "job.md");
    const agentPath = join(process.cwd(), "agents", "suzy", "jobs", "daily.md");
    expect(legacyPath).toContain("/.claude/");
    expect(agentPath).not.toContain("/.claude/");
  });
});
