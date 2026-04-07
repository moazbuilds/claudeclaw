/**
 * Tests for migrations.ts — Phase 17 legacy agent job migration shim.
 *
 * Run with: bun test src/__tests__/migrations.test.ts
 */

import { describe, it, expect, afterEach } from "bun:test";
import { rm, mkdir, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { migrateLegacyAgentJobs } from "../migrations";

const PROJECT = process.cwd();
const AGENTS_DIR = join(PROJECT, "agents");
const JOBS_DIR = join(PROJECT, ".claude", "claudeclaw", "jobs");

const TEST_PREFIX = "tst-mig-";
const createdAgents: string[] = [];
const createdJobFiles: string[] = [];

function uniq(suffix: string): string {
  return `${TEST_PREFIX}${suffix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

async function makeLegacyJob(name: string, frontmatter: string, body = "do thing"): Promise<string> {
  await mkdir(JOBS_DIR, { recursive: true });
  const path = join(JOBS_DIR, `${name}.md`);
  await writeFile(path, `---\n${frontmatter}\n---\n${body}\n`, "utf8");
  createdJobFiles.push(path);
  return path;
}

async function makeAgentDir(name: string): Promise<void> {
  await mkdir(join(AGENTS_DIR, name), { recursive: true });
  createdAgents.push(name);
}

afterEach(async () => {
  for (const a of createdAgents.splice(0)) {
    await rm(join(AGENTS_DIR, a), { recursive: true, force: true });
  }
  for (const f of createdJobFiles.splice(0)) {
    await rm(f, { force: true });
  }
});

describe("Phase 17: migrateLegacyAgentJobs", () => {
  it("migrates legacy agent job to agents/<name>/jobs/default.md", async () => {
    const agent = uniq("ok");
    await makeAgentDir(agent);
    const legacyPath = await makeLegacyJob(
      agent,
      `schedule: 0 9 * * *\nrecurring: true\nagent: ${agent}`,
    );

    const result = await migrateLegacyAgentJobs();
    expect(result.migrated).toContain(`${agent}/default`);

    const targetPath = join(AGENTS_DIR, agent, "jobs", "default.md");
    expect(existsSync(targetPath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);

    const content = await readFile(targetPath, "utf8");
    expect(content).toContain("label: default");
    expect(content).not.toMatch(/^agent:\s/m);
  });

  it("skips files with no agent: frontmatter", async () => {
    const name = uniq("noagent");
    const path = await makeLegacyJob(name, `schedule: 0 9 * * *\nrecurring: true`);

    const result = await migrateLegacyAgentJobs();
    expect(result.skipped).toContain(`${name}.md`);
    expect(existsSync(path)).toBe(true);
  });

  it("skips files where target agent dir does not exist", async () => {
    const ghost = uniq("ghost");
    const path = await makeLegacyJob(
      ghost,
      `schedule: 0 9 * * *\nrecurring: true\nagent: ${ghost}`,
    );

    const result = await migrateLegacyAgentJobs();
    expect(result.skipped).toContain(`${ghost}.md`);
    expect(existsSync(path)).toBe(true);
  });

  it("is idempotent — second call migrates nothing", async () => {
    const agent = uniq("idem");
    await makeAgentDir(agent);
    await makeLegacyJob(
      agent,
      `schedule: 0 9 * * *\nrecurring: true\nagent: ${agent}`,
    );

    const first = await migrateLegacyAgentJobs();
    expect(first.migrated.length).toBe(1);

    const second = await migrateLegacyAgentJobs();
    expect(second.migrated.length).toBe(0);
  });
});
