import { describe, test, expect } from "bun:test";
import {
  formatThreadHistory,
  THREAD_HISTORY_DEFAULT_MAX_CHARS,
  THREAD_HISTORY_DEFAULT_MAX_MESSAGES,
  type HistoryMsg,
} from "./commands/discord";
import { extractShellBlock } from "./runner";
import { parseJobFile } from "./jobs";

// These tests lock in the invariants that prevent the
// "1000-turn shared session + 40-message history dump" context bleed
// from happening again. If any of them fail, something in the bot is
// about to (re)consume a giant chunk of context per invocation.

function msg(i: number, body: string, opts: Partial<HistoryMsg> = {}): HistoryMsg {
  return {
    id: String(i),
    author: { username: "dork", bot: false, ...opts.author },
    content: body,
    timestamp: "2026-05-22T15:00:00.000Z",
    attachments: [],
    ...opts,
  };
}

describe("formatThreadHistory — bounds seed context for a fresh thread session", () => {
  test("returns null when there is nothing to render", () => {
    expect(formatThreadHistory(null, [])).toBeNull();
    expect(formatThreadHistory(null, [msg(1, "")])).toBeNull();
  });

  test("never returns more than maxMessages worth of lines", () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg(i, `line ${i}`));
    const out = formatThreadHistory(null, messages, { maxMessages: 5 }) ?? "";
    const lines = out.split("\n").filter((l) => l.includes(": line "));
    expect(lines.length).toBe(5);
    expect(out).toContain("line 199");
    expect(out).not.toContain("line 100");
  });

  test("keeps the starter even when truncating", () => {
    const starter = msg(0, "the original ask", { author: { username: "dork" } });
    const messages = Array.from({ length: 50 }, (_, i) => msg(i + 1, `reply ${i}`));
    const out = formatThreadHistory(starter, messages, { maxMessages: 5 }) ?? "";
    expect(out).toContain("[thread starter]");
    expect(out).toContain("the original ask");
  });

  test("hard char cap is enforced — a giant thread can't blow past it", () => {
    // 500 messages × 200 chars = 100kB of raw input
    const bigBody = "x".repeat(200);
    const messages = Array.from({ length: 500 }, (_, i) => msg(i, bigBody));
    const out = formatThreadHistory(null, messages, { maxChars: 5_000 }) ?? "";
    expect(out.length).toBeLessThanOrEqual(5_000);
  });

  test("default caps are conservative — protect against accidental dumps", () => {
    expect(THREAD_HISTORY_DEFAULT_MAX_MESSAGES).toBeLessThanOrEqual(25);
    expect(THREAD_HISTORY_DEFAULT_MAX_CHARS).toBeLessThanOrEqual(25_000);
  });

  test("real-world: 200-msg thread under default caps stays bounded", () => {
    const messages = Array.from({ length: 200 }, (_, i) =>
      msg(i, `turn ${i}: ${"some real-ish content ".repeat(10)}`),
    );
    const out = formatThreadHistory(null, messages) ?? "";
    expect(out.length).toBeLessThanOrEqual(THREAD_HISTORY_DEFAULT_MAX_CHARS);
  });
});

describe("extractShellBlock — shell-mode jobs must not pull in extra prompt text", () => {
  test("extracts the bash code from a fenced block", () => {
    const prompt = "Some prose.\n\n```bash\ncd ~/Dev && npm run sync\n```\n\nMore prose.";
    expect(extractShellBlock(prompt)).toBe("cd ~/Dev && npm run sync");
  });

  test("falls back to whole body when no fence is present", () => {
    expect(extractShellBlock("  echo hi  ")).toBe("echo hi");
  });

  test("strips the trailing prose so it can't accidentally be executed", () => {
    const prompt = "```bash\necho 1\n```\n\nDo NOT also do this part.";
    expect(extractShellBlock(prompt)).toBe("echo 1");
  });
});

describe("parseJobFile — shell:true jobs skip the Claude session entirely", () => {
  test("shell:true frontmatter parses to shell=true", () => {
    const body = `---\nschedule: "*/15 * * * *"\nrecurring: true\nnotify: error\nshell: true\n---\n` +
      "```bash\necho hi\n```\n";
    const job = parseJobFile("shellish", body);
    expect(job?.shell).toBe(true);
    expect(job?.schedule).toBe("*/15 * * * *");
  });

  test("absence of shell frontmatter defaults to shell=false (LLM path)", () => {
    const body = `---\nschedule: "0 9 * * *"\nrecurring: true\n---\nWrite a haiku.\n`;
    const job = parseJobFile("llm", body);
    expect(job?.shell).toBe(false);
  });

  test("any non-truthy shell value is treated as false", () => {
    for (const raw of ["false", "no", "0", ""]) {
      const body = `---\nschedule: "0 * * * *"\nshell: ${raw}\n---\nbody\n`;
      const job = parseJobFile("x", body);
      expect(job?.shell).toBe(false);
    }
  });
});
