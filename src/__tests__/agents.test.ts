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
  validateJobLabel,
  addJob,
  updateJob,
  removeJob,
  listAgentJobs,
  deleteAgent,
  agentJobsDir,
  applySoulPatch,
  applyClaudeMdPatch,
  updateAgent,
} from "../agents";
import { writeFile } from "fs/promises";
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

  it("writes a default job file under agents/<name>/jobs when schedule is provided", async () => {
    const name = uniq("sched");
    await createAgent({
      name,
      role: "Daily digest writer",
      personality: "Punchy.",
      schedule: "daily at 9am",
      defaultPrompt: "Write the digest.",
    });

    // Legacy path should NOT exist
    expect(existsSync(join(JOBS_DIR, `${name}.md`))).toBe(false);

    // New path
    const jobPath = join(AGENTS_DIR, name, "jobs", "default.md");
    expect(existsSync(jobPath)).toBe(true);
    const job = await readFile(jobPath, "utf8");
    expect(job).toContain("label: default");
    expect(job).toContain("cron: 0 9 * * *");
    expect(job).toContain("enabled: true");
    expect(job).toContain("Write the digest.");

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
    expect(existsSync(join(AGENTS_DIR, name, "jobs"))).toBe(false);
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

describe("integration: full agent lifecycle", () => {
  it("creates an agent end-to-end with all files, job, and listing", async () => {
    const name = uniq("suzy");
    const role = "Daily content sourcer for the team";
    const personality = "Sharp and curious. Loves weird internet corners. Skeptical of hype, allergic to filler.";
    const ctx = await createAgent({
      name,
      role,
      personality,
      schedule: "daily at 9am",
      discordChannels: ["#test", "#content"],
      dataSources: "RSS feeds + HackerNews + Lobsters",
    });

    // 1. All four .md files + .gitignore exist
    expect(existsSync(ctx.identityPath)).toBe(true);
    expect(existsSync(ctx.soulPath)).toBe(true);
    expect(existsSync(ctx.claudeMdPath)).toBe(true);
    expect(existsSync(ctx.memoryPath)).toBe(true);
    expect(existsSync(join(ctx.dir, ".gitignore"))).toBe(true);

    // 2. IDENTITY.md contains role
    const identity = await readFile(ctx.identityPath, "utf8");
    expect(identity).toContain(role);

    // 3. SOUL.md contains personality
    const soul = await readFile(ctx.soulPath, "utf8");
    expect(soul).toContain(personality);

    // 4. CLAUDE.md contains channels and data sources
    const claudeMd = await readFile(ctx.claudeMdPath, "utf8");
    expect(claudeMd).toContain("#test");
    expect(claudeMd).toContain("#content");
    expect(claudeMd).toContain("RSS feeds");

    // 5. Default job file exists under agents/<name>/jobs/
    const jobPath = join(AGENTS_DIR, name, "jobs", "default.md");
    expect(existsSync(jobPath)).toBe(true);
    const job = await readFile(jobPath, "utf8");
    expect(job).toContain("cron: 0 9 * * *");
    expect(job).toContain("label: default");

    // 6. listAgents includes the new agent
    const all = await listAgents();
    expect(all).toContain(name);

    // 7. loadAgent returns correct paths
    const loaded = await loadAgent(name);
    expect(loaded.name).toBe(name);
    expect(loaded.identityPath).toBe(ctx.identityPath);
    expect(loaded.soulPath).toBe(ctx.soulPath);
    expect(loaded.claudeMdPath).toBe(ctx.claudeMdPath);
    expect(loaded.memoryPath).toBe(ctx.memoryPath);
  });
});

describe("Phase 17: multi-job agents", () => {
  describe("validateJobLabel", () => {
    it("rejects invalid labels", () => {
      const bad = ["", "Foo", "with space", "../etc", "-bad", "bad-", "foo/bar"];
      for (const l of bad) {
        expect(validateJobLabel(l).valid).toBe(false);
      }
    });

    it("accepts kebab-case labels", () => {
      const good = ["default", "digest-scan", "morning-brief", "a", "a1"];
      for (const l of good) {
        expect(validateJobLabel(l).valid).toBe(true);
      }
    });
  });

  describe("addJob", () => {
    it("writes file with correct frontmatter and body", async () => {
      const name = uniq("multi");
      await createAgent({ name, role: "x", personality: "y" });
      const job = await addJob(name, "digest-scan", "0 9 * * 1-5", "Run the daily digest", "opus");

      expect(job.label).toBe("digest-scan");
      expect(job.cron).toBe("0 9 * * 1-5");
      expect(job.enabled).toBe(true);
      expect(job.model).toBe("opus");

      const path = join(AGENTS_DIR, name, "jobs", "digest-scan.md");
      expect(existsSync(path)).toBe(true);
      const content = await readFile(path, "utf8");
      expect(content).toContain("label: digest-scan");
      expect(content).toContain("cron: 0 9 * * 1-5");
      expect(content).toContain("enabled: true");
      expect(content).toContain("model: opus");
      expect(content).toContain("Run the daily digest");
    });

    it("throws on duplicate label", async () => {
      const name = uniq("dup-job");
      await createAgent({ name, role: "x", personality: "y" });
      await addJob(name, "task", "0 9 * * *", "do thing");
      await expect(addJob(name, "task", "0 9 * * *", "again")).rejects.toThrow();
    });

    it("throws on invalid cron", async () => {
      const name = uniq("badcron");
      await createAgent({ name, role: "x", personality: "y" });
      await expect(addJob(name, "task", "not a cron", "x")).rejects.toThrow();
    });

    it("throws on invalid label", async () => {
      const name = uniq("badlabel");
      await createAgent({ name, role: "x", personality: "y" });
      await expect(addJob(name, "Bad Label", "0 9 * * *", "x")).rejects.toThrow();
    });

    it("throws when agent does not exist", async () => {
      await expect(addJob("definitely-not-exists-xyz", "task", "0 9 * * *", "x")).rejects.toThrow();
    });
  });

  describe("updateJob", () => {
    it("patches only specified fields", async () => {
      const name = uniq("patch");
      await createAgent({ name, role: "x", personality: "y" });
      await addJob(name, "task", "0 9 * * *", "original body", "opus");

      const updated = await updateJob(name, "task", { cron: "0 10 * * *" });
      expect(updated.cron).toBe("0 10 * * *");
      expect(updated.trigger).toBe("original body");
      expect(updated.model).toBe("opus");
      expect(updated.enabled).toBe(true);
    });

    it("toggles enabled to false", async () => {
      const name = uniq("toggle");
      await createAgent({ name, role: "x", personality: "y" });
      await addJob(name, "task", "0 9 * * *", "body");

      const updated = await updateJob(name, "task", { enabled: false });
      expect(updated.enabled).toBe(false);

      const content = await readFile(join(AGENTS_DIR, name, "jobs", "task.md"), "utf8");
      expect(content).toContain("enabled: false");
    });

    it("replaces only the body when given trigger", async () => {
      const name = uniq("body");
      await createAgent({ name, role: "x", personality: "y" });
      await addJob(name, "task", "0 9 * * *", "old");
      const updated = await updateJob(name, "task", { trigger: "new body" });
      expect(updated.trigger).toBe("new body");
      expect(updated.cron).toBe("0 9 * * *");
    });

    it("throws when job missing", async () => {
      const name = uniq("missing");
      await createAgent({ name, role: "x", personality: "y" });
      await expect(updateJob(name, "ghost", { enabled: false })).rejects.toThrow();
    });
  });

  describe("removeJob", () => {
    it("unlinks the file", async () => {
      const name = uniq("remove");
      await createAgent({ name, role: "x", personality: "y" });
      await addJob(name, "task", "0 9 * * *", "body");
      const path = join(AGENTS_DIR, name, "jobs", "task.md");
      expect(existsSync(path)).toBe(true);
      await removeJob(name, "task");
      expect(existsSync(path)).toBe(false);
    });

    it("throws if missing", async () => {
      const name = uniq("rm-missing");
      await createAgent({ name, role: "x", personality: "y" });
      await expect(removeJob(name, "ghost")).rejects.toThrow();
    });
  });

  describe("listAgentJobs", () => {
    it("returns sorted parsed jobs", async () => {
      const name = uniq("list");
      await createAgent({ name, role: "x", personality: "y" });
      await addJob(name, "zeta", "0 9 * * *", "z");
      await addJob(name, "alpha", "0 10 * * *", "a");
      await addJob(name, "mid", "0 11 * * *", "m", "haiku");

      const jobs = await listAgentJobs(name);
      expect(jobs.map((j) => j.label)).toEqual(["alpha", "mid", "zeta"]);
      expect(jobs[1].model).toBe("haiku");
    });

    it("returns [] when jobs dir missing", async () => {
      const name = uniq("nojobs");
      await createAgent({ name, role: "x", personality: "y" });
      const jobs = await listAgentJobs(name);
      expect(jobs).toEqual([]);
    });
  });

  describe("deleteAgent", () => {
    it("removes entire agent dir including MEMORY.md and jobs/", async () => {
      const name = uniq("doomed");
      await createAgent({ name, role: "x", personality: "y" });
      await addJob(name, "task", "0 9 * * *", "body");

      const dir = join(AGENTS_DIR, name);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "jobs", "task.md"))).toBe(true);
      expect(existsSync(join(dir, "MEMORY.md"))).toBe(true);

      await deleteAgent(name);
      expect(existsSync(dir)).toBe(false);
    });

    it("is a no-op when dir missing", async () => {
      await deleteAgent("definitely-not-an-agent-zzz");
    });
  });

  describe("createAgent + multi-job integration", () => {
    it("createAgent with schedule writes agents/<name>/jobs/default.md (not legacy)", async () => {
      const name = uniq("default-job");
      await createAgent({
        name,
        role: "x",
        personality: "y",
        schedule: "daily at 9am",
        defaultPrompt: "do the thing",
      });

      expect(existsSync(join(JOBS_DIR, `${name}.md`))).toBe(false);
      const newPath = join(AGENTS_DIR, name, "jobs", "default.md");
      expect(existsSync(newPath)).toBe(true);

      const jobs = await listAgentJobs(name);
      expect(jobs.length).toBe(1);
      expect(jobs[0].label).toBe("default");
      expect(jobs[0].cron).toBe("0 9 * * *");
      expect(jobs[0].trigger).toContain("do the thing");
    });
  });

  describe("Phase 17: parseScheduleToCron broadening", () => {
    const cases: Array<[string, string | null]> = [
      ["every day at 7pm", "0 19 * * *"],
      ["every day at 7 pm", "0 19 * * *"],
      ["every weekday at 9am", "0 9 * * 1-5"],
      ["hourly", "0 * * * *"],
      ["every monday at 9am", "0 9 * * 1"],
      ["twice daily", "0 9,21 * * *"],
      ["thrice daily", "0 9,13,17 * * *"],
      ["every day at 7am and 7pm", "0 7,19 * * *"],
      ["every day at 9am, 1pm, 5pm", "0 9,13,17 * * *"],
      ["every 2 hours", "0 */2 * * *"],
      ["daily at noon", "0 12 * * *"],
      ["daily at midnight", "0 0 * * *"],
      ["every weekend", "0 0 * * 0,6"],
      // negatives
      ["blarghonk", null],
      ["every 0 hours", null],
      ["every 30 hours", null],
      ["every day at 25pm", null],
      // regressions
      ["every 15 minutes", "*/15 * * * *"],
      ["daily at 9am", "0 9 * * *"],
      ["*/5 * * * *", "*/5 * * * *"],
    ];
    for (const [input, expected] of cases) {
      it(`parseScheduleToCron(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
        expect(parseScheduleToCron(input)).toBe(expected);
      });
    }
  });
});

describe("Phase 17: SOUL/CLAUDE.md patching", () => {
  const MARKED_SOUL = [
    `## Personality`,
    `<!-- claudeclaw:personality:start -->`,
    `calm and clear`,
    `<!-- claudeclaw:personality:end -->`,
    ``,
    `## Workflow`,
    `<!-- claudeclaw:workflow:start -->`,
    `do A then B`,
    `<!-- claudeclaw:workflow:end -->`,
    ``,
    `## Core Truths`,
    ``,
    `Be helpful.`,
    ``,
  ].join("\n");

  const LEGACY_SOUL = [
    `_intro_`,
    ``,
    `## Personality`,
    ``,
    `calm and clear`,
    ``,
    `## Core Truths`,
    ``,
    `Be helpful.`,
    ``,
  ].join("\n");

  it("empty patch returns input unchanged", () => {
    expect(applySoulPatch(MARKED_SOUL, {})).toBe(MARKED_SOUL);
  });

  it("replaces workflow content between markers", () => {
    const out = applySoulPatch(MARKED_SOUL, { workflow: "do X then Y" });
    expect(out).toContain("do X then Y");
    expect(out).not.toContain("do A then B");
    expect(out).toContain("calm and clear"); // personality untouched
    expect(out).toContain("Be helpful."); // core truths untouched
  });

  it("replaces personality content between markers, leaves workflow", () => {
    const out = applySoulPatch(MARKED_SOUL, { personality: "sharp and warm" });
    expect(out).toContain("sharp and warm");
    expect(out).not.toContain("calm and clear");
    expect(out).toContain("do A then B");
    expect(out).toContain("Be helpful.");
  });

  it("applies both personality and workflow at once", () => {
    const out = applySoulPatch(MARKED_SOUL, {
      personality: "sharp",
      workflow: "X",
    });
    expect(out).toContain("sharp");
    expect(out).toContain("X");
    expect(out).not.toContain("calm and clear");
    expect(out).not.toContain("do A then B");
  });

  it("legacy SOUL without markers: adds workflow section after Personality", () => {
    const out = applySoulPatch(LEGACY_SOUL, { workflow: "do new thing" });
    expect(out).toContain("## Workflow");
    expect(out).toContain("<!-- claudeclaw:workflow:start -->");
    expect(out).toContain("do new thing");
    expect(out).toContain("<!-- claudeclaw:workflow:end -->");
    // Workflow comes before Core Truths
    expect(out.indexOf("## Workflow")).toBeLessThan(out.indexOf("## Core Truths"));
    expect(out.indexOf("## Personality")).toBeLessThan(out.indexOf("## Workflow"));
  });

  it("legacy SOUL without markers: replaces Personality section", () => {
    const out = applySoulPatch(LEGACY_SOUL, { personality: "fierce" });
    expect(out).toContain("fierce");
    expect(out).not.toContain("calm and clear");
    expect(out).toContain("Be helpful.");
  });

  it("applySoulPatch is idempotent", () => {
    const once = applySoulPatch(MARKED_SOUL, { workflow: "stable", personality: "stable" });
    const twice = applySoulPatch(once, { workflow: "stable", personality: "stable" });
    expect(twice).toBe(once);
  });

  const MARKED_CLAUDE = [
    `# Agent: x`,
    ``,
    `## Discord Channels`,
    `<!-- claudeclaw:discord:start -->`,
    `- #old`,
    `<!-- claudeclaw:discord:end -->`,
    ``,
    `## Data Sources`,
    `<!-- claudeclaw:datasources:start -->`,
    `old sources`,
    `<!-- claudeclaw:datasources:end -->`,
    ``,
  ].join("\n");

  const LEGACY_CLAUDE = [
    `# Agent: x`,
    ``,
    `## Role`,
    ``,
    `tester`,
    ``,
    `## Discord Channels`,
    ``,
    `- #old`,
    ``,
    `## Data Sources`,
    ``,
    `old sources`,
    ``,
  ].join("\n");

  it("rewrites discord channels block (marked)", () => {
    const out = applyClaudeMdPatch(MARKED_CLAUDE, { discordChannels: ["#a", "#b"] });
    expect(out).toContain("#a");
    expect(out).toContain("#b");
    expect(out).not.toContain("#old");
    expect(out).toContain("old sources"); // datasources untouched
  });

  it("rewrites data sources block (marked)", () => {
    const out = applyClaudeMdPatch(MARKED_CLAUDE, { dataSources: "fresh" });
    expect(out).toContain("fresh");
    expect(out).not.toContain("old sources");
    expect(out).toContain("#old"); // channels untouched
  });

  it("legacy CLAUDE.md: discord rewrite still works", () => {
    const out = applyClaudeMdPatch(LEGACY_CLAUDE, { discordChannels: ["#new"] });
    expect(out).toContain("#new");
    expect(out).not.toContain("#old");
    expect(out).toContain("old sources");
    expect(out).toContain("tester");
  });

  it("legacy CLAUDE.md: dataSources rewrite still works", () => {
    const out = applyClaudeMdPatch(LEGACY_CLAUDE, { dataSources: "shiny" });
    expect(out).toContain("shiny");
    expect(out).not.toContain("old sources");
    expect(out).toContain("#old");
  });

  it("applyClaudeMdPatch idempotent", () => {
    const once = applyClaudeMdPatch(MARKED_CLAUDE, {
      discordChannels: ["#a"],
      dataSources: "z",
    });
    const twice = applyClaudeMdPatch(once, {
      discordChannels: ["#a"],
      dataSources: "z",
    });
    expect(twice).toBe(once);
  });
});

describe("Phase 17: updateAgent + MEMORY invariant", () => {
  async function makeAgent(suffix: string) {
    const name = uniq(`up-${suffix}`);
    await createAgent({ name, role: "tester", personality: "calm" });
    return name;
  }

  it("createAgent({workflow}) writes a Workflow section in SOUL.md", async () => {
    const name = uniq("wf");
    await createAgent({
      name,
      role: "tester",
      personality: "calm",
      workflow: "do the thing",
    } as any);
    const soul = await readFile(join(AGENTS_DIR, name, "SOUL.md"), "utf8");
    expect(soul).toContain("## Workflow");
    expect(soul).toContain("<!-- claudeclaw:workflow:start -->");
    expect(soul).toContain("do the thing");
    expect(soul).toContain("<!-- claudeclaw:workflow:end -->");
  });

  it("updateAgent({workflow}) does not modify MEMORY.md", async () => {
    const name = await makeAgent("mem-wf");
    const memPath = join(AGENTS_DIR, name, "MEMORY.md");
    await writeFile(memPath, "important state\n", "utf8");
    const before = (await stat(memPath)).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await updateAgent(name, { workflow: "always be sharp" });
    const after = (await stat(memPath)).mtimeMs;
    expect(after).toBe(before);
    expect(await readFile(memPath, "utf8")).toBe("important state\n");
    const soul = await readFile(join(AGENTS_DIR, name, "SOUL.md"), "utf8");
    expect(soul).toContain("always be sharp");
  });

  it("updateAgent({personality}) does not modify MEMORY.md", async () => {
    const name = await makeAgent("mem-p");
    const memPath = join(AGENTS_DIR, name, "MEMORY.md");
    await writeFile(memPath, "state\n", "utf8");
    const before = (await stat(memPath)).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await updateAgent(name, { personality: "fierce" });
    const after = (await stat(memPath)).mtimeMs;
    expect(after).toBe(before);
    const soul = await readFile(join(AGENTS_DIR, name, "SOUL.md"), "utf8");
    expect(soul).toContain("fierce");
  });

  it("updateAgent({discordChannels}) does not modify MEMORY.md", async () => {
    const name = await makeAgent("mem-d");
    const memPath = join(AGENTS_DIR, name, "MEMORY.md");
    await writeFile(memPath, "state\n", "utf8");
    const before = (await stat(memPath)).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await updateAgent(name, { discordChannels: ["#alpha"] });
    const after = (await stat(memPath)).mtimeMs;
    expect(after).toBe(before);
    const cmd = await readFile(join(AGENTS_DIR, name, "CLAUDE.md"), "utf8");
    expect(cmd).toContain("#alpha");
  });

  it("updateAgent({dataSources}) does not modify MEMORY.md", async () => {
    const name = await makeAgent("mem-ds");
    const memPath = join(AGENTS_DIR, name, "MEMORY.md");
    await writeFile(memPath, "state\n", "utf8");
    const before = (await stat(memPath)).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await updateAgent(name, { dataSources: "vault://x" });
    const after = (await stat(memPath)).mtimeMs;
    expect(after).toBe(before);
    const cmd = await readFile(join(AGENTS_DIR, name, "CLAUDE.md"), "utf8");
    expect(cmd).toContain("vault://x");
  });

  it("updateAgent on legacy SOUL.md (no markers) adds workflow", async () => {
    const name = await makeAgent("legacy");
    // Overwrite SOUL.md with legacy format (no markers)
    const soulPath = join(AGENTS_DIR, name, "SOUL.md");
    await writeFile(
      soulPath,
      `## Personality\n\ncalm\n\n## Core Truths\n\nbe helpful\n`,
      "utf8"
    );
    await updateAgent(name, { workflow: "fresh workflow" });
    const soul = await readFile(soulPath, "utf8");
    expect(soul).toContain("## Workflow");
    expect(soul).toContain("fresh workflow");
    expect(soul).toContain("calm");
    expect(soul).toContain("be helpful");
  });

  it("updateAgent throws if agent does not exist", async () => {
    await expect(updateAgent("definitely-not-an-agent-xyz", { workflow: "x" })).rejects.toThrow();
  });

  it("updateAgent function body contains zero MEMORY/session references", async () => {
    const src = await readFile(join(PROJECT, "src", "agents.ts"), "utf8");
    const idx = src.indexOf("export async function updateAgent");
    expect(idx).toBeGreaterThan(-1);
    // Find matching closing brace via depth tracking from the first `{` after idx.
    const openIdx = src.indexOf("{", idx);
    let depth = 0;
    let endIdx = -1;
    for (let i = openIdx; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    expect(endIdx).toBeGreaterThan(openIdx);
    const body = src.slice(openIdx, endIdx + 1);
    expect(body).not.toMatch(/memoryPath/);
    expect(body).not.toMatch(/MEMORY\.md/);
    expect(body).not.toMatch(/ensureMemoryFile/);
    expect(body).not.toMatch(/getMemoryPath/);
    expect(body).not.toMatch(/sessionPath/);
    expect(body).not.toMatch(/session\.json/);
  });
});
