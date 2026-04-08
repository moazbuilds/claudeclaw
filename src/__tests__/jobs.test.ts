/**
 * Tests for jobs.ts — Phase 17 multi-job loader extension.
 *
 * Run with: bun test src/__tests__/jobs.test.ts
 */

import { describe, it, expect, afterEach } from "bun:test";
import { rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { loadJobs, validateModelString, resolveJobModel, VALID_MODEL_STRINGS, type Job } from "../jobs";
import { spyOn } from "bun:test";

const PROJECT = process.cwd();
const AGENTS_DIR = join(PROJECT, "agents");
const JOBS_DIR = join(PROJECT, ".claude", "claudeclaw", "jobs");

const TEST_PREFIX = "tst-jobs-";
const createdAgents: string[] = [];
const createdJobFiles: string[] = [];

function uniq(suffix: string): string {
  const name = `${TEST_PREFIX}${suffix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  return name;
}

async function writeAgentJob(agent: string, label: string, frontmatter: string, body = "do the thing"): Promise<void> {
  const dir = join(AGENTS_DIR, agent, "jobs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${label}.md`), `---\n${frontmatter}\n---\n${body}\n`, "utf8");
  createdAgents.push(agent);
}

async function writeFlatJob(name: string, frontmatter: string, body = "flat thing"): Promise<void> {
  await mkdir(JOBS_DIR, { recursive: true });
  const path = join(JOBS_DIR, `${name}.md`);
  await writeFile(path, `---\n${frontmatter}\n---\n${body}\n`, "utf8");
  createdJobFiles.push(path);
}

afterEach(async () => {
  for (const a of createdAgents.splice(0)) {
    await rm(join(AGENTS_DIR, a), { recursive: true, force: true });
  }
  for (const f of createdJobFiles.splice(0)) {
    await rm(f, { force: true });
  }
});

describe("Phase 17: loadJobs multi-source", () => {
  it("loads agent job from agents/<name>/jobs/<label>.md", async () => {
    const agent = uniq("multi");
    await writeAgentJob(agent, "foo", "schedule: 0 9 * * *\nrecurring: true");

    const jobs = await loadJobs();
    const job = jobs.find((j) => j.name === `${agent}/foo`);
    expect(job).toBeDefined();
    expect(job!.agent).toBe(agent);
    expect(job!.label).toBe("foo");
    expect(job!.schedule).toBe("0 9 * * *");
  });

  it("loads standalone flat-dir job without agent field", async () => {
    const name = uniq("standalone");
    await writeFlatJob(name, "schedule: 0 10 * * *\nrecurring: false");

    const jobs = await loadJobs();
    const job = jobs.find((j) => j.name === name);
    expect(job).toBeDefined();
    expect(job!.agent).toBeUndefined();
    expect(job!.label).toBe(name);
  });

  it("excludes jobs with enabled: false", async () => {
    const agent = uniq("dis");
    await writeAgentJob(agent, "off", "schedule: 0 9 * * *\nrecurring: true\nenabled: false");

    const jobs = await loadJobs();
    expect(jobs.find((j) => j.name === `${agent}/off`)).toBeUndefined();
  });

  it("parses model field", async () => {
    const agent = uniq("model");
    await writeAgentJob(agent, "x", "schedule: 0 9 * * *\nrecurring: true\nmodel: opus");

    const jobs = await loadJobs();
    const job = jobs.find((j) => j.name === `${agent}/x`);
    expect(job!.model).toBe("opus");
  });

  it("does not throw when agents/<name>/jobs/ missing for an agent", async () => {
    const agent = uniq("empty");
    await mkdir(join(AGENTS_DIR, agent), { recursive: true });
    createdAgents.push(agent);

    const jobs = await loadJobs();
    expect(Array.isArray(jobs)).toBe(true);
  });

  it("directory location overrides any frontmatter agent: field", async () => {
    const agent = uniq("auth");
    await writeAgentJob(agent, "bar", `schedule: 0 9 * * *\nrecurring: true\nagent: someone-else`);
    const jobs = await loadJobs();
    const job = jobs.find((j) => j.name === `${agent}/bar`);
    expect(job!.agent).toBe(agent);
  });
});

describe("Phase 18: validateModelString", () => {
  it("allows undefined", () => {
    expect(() => validateModelString(undefined, "ctx")).not.toThrow();
  });
  it("allows empty string", () => {
    expect(() => validateModelString("", "ctx")).not.toThrow();
  });
  it("allows opus/sonnet/haiku/glm", () => {
    for (const m of ["opus", "sonnet", "haiku", "glm"]) {
      expect(() => validateModelString(m, "ctx")).not.toThrow();
    }
  });
  it("is case-insensitive and trimmed", () => {
    expect(() => validateModelString("  OPUS  ", "ctx")).not.toThrow();
  });
  it("rejects unknown model with context + allowed list in message", () => {
    let caught: Error | null = null;
    try {
      validateModelString("opuz", "reg/digest-scan");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("opuz");
    expect(caught!.message).toContain("reg/digest-scan");
    expect(caught!.message).toContain("opus");
    expect(caught!.message).toContain("sonnet");
    expect(caught!.message).toContain("haiku");
    expect(caught!.message).toContain("glm");
  });
  it("VALID_MODEL_STRINGS contains exactly the four models", () => {
    expect(VALID_MODEL_STRINGS.size).toBe(4);
    expect([...VALID_MODEL_STRINGS].sort()).toEqual(["glm", "haiku", "opus", "sonnet"]);
  });
});

describe("Phase 18: resolveJobModel", () => {
  const baseJob: Job = {
    name: "x",
    schedule: "0 9 * * *",
    prompt: "",
    recurring: true,
    notify: true,
  };
  it("returns lowercased trimmed model when set", async () => {
    expect(await resolveJobModel({ ...baseJob, model: "OPUS " })).toBe("opus");
  });
  it("returns undefined when model is undefined", async () => {
    expect(await resolveJobModel({ ...baseJob })).toBeUndefined();
  });
  it("returns undefined when model is empty string", async () => {
    expect(await resolveJobModel({ ...baseJob, model: "" })).toBeUndefined();
  });
});

describe("Phase 18: loadJobs invalid model rejection", () => {
  it("skips agent job with invalid model and logs error; valid sibling still loads", async () => {
    const agent = uniq("badmodel");
    await writeAgentJob(agent, "bad", "schedule: 0 9 * * *\nrecurring: true\nmodel: opuz");
    await writeAgentJob(agent, "good", "schedule: 0 9 * * *\nrecurring: true\nmodel: opus");

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const jobs = await loadJobs();
      const bad = jobs.find((j) => j.name === `${agent}/bad`);
      const good = jobs.find((j) => j.name === `${agent}/good`);
      expect(bad).toBeUndefined();
      expect(good).toBeDefined();
      expect(good!.model).toBe("opus");
      const logged = errSpy.mock.calls.some((c) =>
        String(c[0] ?? "").includes(`Skipping job ${agent}:bad`),
      );
      expect(logged).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});
