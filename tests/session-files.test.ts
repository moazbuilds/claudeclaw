import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findSessionJsonlPath,
  getClaudeProjectDir,
  sanitizeProjectSlug,
} from "../src/sessionFiles.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

let fakeHome = "";
let previousHome: string | undefined;

beforeEach(() => {
  fakeHome = join(tmpdir(), `claudeclaw-session-files-${Date.now()}`);
  mkdirSync(join(fakeHome, ".claude", "projects"), { recursive: true });
  previousHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("sessionFiles", () => {
  it("sanitizeProjectSlug matches Claude Code directory rules", () => {
    assert.equal(sanitizeProjectSlug("/home/claw/newsletter"), "-home-claw-newsletter");
    assert.equal(sanitizeProjectSlug("C:\\Users\\claw\\project"), "C:-Users-claw-project");
  });

  it("getClaudeProjectDir uses sanitized cwd under HOME", () => {
    const cwd = "/home/claw/my.project";
    assert.equal(
      getClaudeProjectDir(cwd),
      join(fakeHome, ".claude", "projects", sanitizeProjectSlug(cwd)),
    );
  });

  it("findSessionJsonlPath prefers cwd project dir", () => {
    const cwd = "/home/claw/newsletter";
    const projectDir = join(fakeHome, ".claude", "projects", sanitizeProjectSlug(cwd));
    mkdirSync(projectDir, { recursive: true });
    const expected = join(projectDir, `${SESSION_ID}.jsonl`);
    writeFileSync(expected, '{"type":"user"}\n', "utf8");

    const otherDir = join(fakeHome, ".claude", "projects", "-other-project");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, `${SESSION_ID}.jsonl`), '{"type":"user"}\n', "utf8");

    assert.equal(findSessionJsonlPath(SESSION_ID, cwd), expected);
  });

  it("findSessionJsonlPath scans projects when cwd slug misses", () => {
    const cwd = "/home/claw/wrong-launch-dir";
    const actualDir = join(fakeHome, ".claude", "projects", "-home-claw-real-project");
    mkdirSync(actualDir, { recursive: true });
    const expected = join(actualDir, `${SESSION_ID}.jsonl`);
    writeFileSync(expected, '{"type":"user"}\n', "utf8");

    assert.equal(findSessionJsonlPath(SESSION_ID, cwd), expected);
  });

  it("findSessionJsonlPath rejects non-uuid session ids", () => {
    assert.equal(findSessionJsonlPath("../escape"), null);
  });
});

describe("telegram command imports", () => {
  it("imports existsSync for voice directive filtering", () => {
    const src = readFileSync(new URL("../src/commands/telegram.ts", import.meta.url), "utf8");
    assert.match(src, /import \{ existsSync \} from "node:fs";/);
    assert.match(src, /existsSync\(p\)/);
  });
});
