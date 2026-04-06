/**
 * Tests for agents.ts
 *
 * Run with: bun test src/__tests__/agents.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  createAgent,
  loadAgent,
  listAgents,
  validateAgentName,
  parseScheduleToCron,
} from "../agents";
import { cronMatches } from "../cron";

const PROJECT = process.cwd();
const AGENTS_DIR = join(PROJECT, "agents");
const JOBS_DIR = join(PROJECT, ".claude", "claudeclaw", "jobs");

// Use a unique prefix for test agents so we never collide with real agents.
const TEST_PREFIX = "tst-agent-";
const created: string[] = [];

function uniq(suffix: string): string {
  const name = `${TEST_PREFIX}${suffix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  created.push(name);
  return name;
}

async function cleanup(): Promise<void> {
  for (const name of created) {
    await rm(join(AGENTS_DIR, name), { recursive: true, force: true });
    await rm(join(JOBS_DIR, `${name}.md`), { force: true });
  }
  created.length = 0;
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe("validateAgentName", () => {
  it("accepts simple kebab-case names", () => {
    expect(validateAgentName("suzy").valid).toBe(true);
    expect(validateAgentName("daily-digest").valid).toBe(true);
    expect(validateAgentName("a").valid).toBe(true);
  });

  it("rejects uppercase", () => {
    expect(validateAgentName("Suzy").valid).toBe(false);
  });

  it("rejects underscores", () => {
    expect(validateAgentName("has_underscore").valid).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateAgentName("").valid).toBe(false);
  });

  it("rejects names starting with a digit", () => {
    expect(validateAgentName("123start").valid).toBe(false);
  });

  it("rejects names starting or ending with hyphen", () => {
    expect(validateAgentName("-foo").valid).toBe(false);
    expect(validateAgentName("foo-").valid).toBe(false);
  });

  it("rejects existing agent dirs", async () => {
    const name = uniq("dup");
    await mkdir(join(AGENTS_DIR, name), { recursive: true });
    const result = validateAgentName(name);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("parseScheduleToCron", () => {
  const cases: Array<[string, string]> = [
    ["hourly", "0 * * * *"],
    ["every hour", "0 * * * *"],
    ["daily", "0 0 * * *"],
    ["daily at 9am", "0 9 * * *"],
    ["daily at 5pm", "0 17 * * *"],
    ["weekly", "0 0 * * 0"],
    ["every weekday at 9am", "0 9 * * 1-5"],
    ["every 30 minutes", "*/30 * * * *"],
    ["every monday", "0 0 * * 1"],
  ];

  for (const [input, expected] of cases) {
    it(`parses "${input}" -> "${expected}"`, () => {
      expect(parseScheduleToCron(input)).toBe(expected);
    });
  }

  it("passes through raw cron expressions", () => {
    expect(parseScheduleToCron("0 9 * * 1-5")).toBe("0 9 * * 1-5");
  });

  it("returns null for gibberish", () => {
    expect(parseScheduleToCron("banana pancakes")).toBeNull();
  });
});

describe("createAgent", () => {
  it("scaffolds the agent directory and files", async () => {
    const name = uniq("scaffold");
    const ctx = await createAgent({
      name,
      role: "Researcher who summarizes papers",
      personality: "Curious and concise.",
    });

    expect(ctx.name).toBe(name);
    expect(existsSync(ctx.dir)).toBe(true);
    expect(existsSync(ctx.identityPath)).toBe(true);
    expect(existsSync(ctx.soulPath)).toBe(true);
    expect(existsSync(ctx.claudeMdPath)).toBe(true);
    expect(existsSync(ctx.memoryPath)).toBe(true);

    const identity = await readFile(ctx.identityPath, "utf8");
    expect(identity).toContain("Researcher who summarizes papers");

    const soul = await readFile(ctx.soulPath, "utf8");
    expect(soul).toContain("Curious and concise.");

    const claudeMd = await readFile(ctx.claudeMdPath, "utf8");
    expect(claudeMd).toContain("Researcher who summarizes papers");
    expect(claudeMd.toLowerCase()).toContain("discord channels");
    expect(claudeMd.toLowerCase()).toContain("data sources");
  });

  it("writes a .gitignore that ignores session.json and MEMORY.md", async () => {
    const name = uniq("gitignore");
    await createAgent({
      name,
      role: "x",
      personality: "y",
    });
    const gi = await readFile(join(AGENTS_DIR, name, ".gitignore"), "utf8");
    expect(gi).toContain("session.json");
    expect(gi).toContain("MEMORY.md");
  });

  it("writes a job file with valid cron when schedule is provided", async () => {
    const name = uniq("sched");
    await createAgent({
      name,
      role: "Daily digest writer",
      personality: "Punchy.",
      schedule: "daily at 9am",
      defaultPrompt: "Write the digest.",
    });

    const jobPath = join(JOBS_DIR, `${name}.md`);
    expect(existsSync(jobPath)).toBe(true);
    const job = await readFile(jobPath, "utf8");
    expect(job).toContain(`agent: ${name}`);
    expect(job).toContain("schedule: 0 9 * * *");
    expect(job).toContain("Write the digest.");

    // Cron is valid per cronMatches at 09:00 UTC
    const at9 = new Date(Date.UTC(2026, 0, 1, 9, 0, 0));
    expect(cronMatches("0 9 * * *", at9)).toBe(true);
  });

  it("does not write a job file when no schedule is given", async () => {
    const name = uniq("nosched");
    await createAgent({
      name,
      role: "x",
      personality: "y",
    });
    expect(existsSync(join(JOBS_DIR, `${name}.md`))).toBe(false);
  });

  it("rejects duplicate creation", async () => {
    const name = uniq("dup2");
    await createAgent({ name, role: "x", personality: "y" });
    await expect(
      createAgent({ name, role: "x", personality: "y" })
    ).rejects.toThrow();
  });
});

describe("listAgents and loadAgent", () => {
  it("listAgents enumerates created agents", async () => {
    const name = uniq("list");
    await createAgent({ name, role: "x", personality: "y" });
    const all = await listAgents();
    expect(all).toContain(name);
  });

  it("loadAgent returns context paths", async () => {
    const name = uniq("load");
    await createAgent({ name, role: "x", personality: "y" });
    const ctx = await loadAgent(name);
    expect(ctx.name).toBe(name);
    expect(ctx.dir).toBe(join(AGENTS_DIR, name));
    expect(ctx.identityPath).toBe(join(AGENTS_DIR, name, "IDENTITY.md"));
    expect(ctx.soulPath).toBe(join(AGENTS_DIR, name, "SOUL.md"));
    expect(ctx.claudeMdPath).toBe(join(AGENTS_DIR, name, "CLAUDE.md"));
    expect(ctx.memoryPath).toBe(join(AGENTS_DIR, name, "MEMORY.md"));
    expect(ctx.sessionPath).toBe(join(AGENTS_DIR, name, "session.json"));
    const s = await stat(ctx.dir);
    expect(s.isDirectory()).toBe(true);
  });

  it("loadAgent throws for missing agent", async () => {
    await expect(loadAgent("definitely-not-an-agent-xyz")).rejects.toThrow();
  });
});
