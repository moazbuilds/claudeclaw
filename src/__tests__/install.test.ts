import { describe, test, expect } from "bun:test";
import { mkdir, writeFile, rm, readlink, lstat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { ensureUserSymlinks } from "../install";

// Each test gets an isolated fake CLAUDECLAW_ROOT plus a fake HOME directory
// so we never touch the developer's real ~/.claude/.
async function makeFakeInstall(): Promise<{ root: string; home: string; cleanup: () => Promise<void> }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const root = join(tmpdir(), `claudeclaw-install-test-root-${stamp}`);
  const home = join(tmpdir(), `claudeclaw-install-test-home-${stamp}`);

  // Fake claudeclaw install layout
  await mkdir(join(root, "skills", "create-agent"), { recursive: true });
  await writeFile(join(root, "skills", "create-agent", "SKILL.md"), "---\nname: create-agent\n---\n");
  await mkdir(join(root, "skills", "update-agent"), { recursive: true });
  await writeFile(join(root, "skills", "update-agent", "SKILL.md"), "---\nname: update-agent\n---\n");
  await mkdir(join(root, "commands", "claudeclaw"), { recursive: true });
  await writeFile(join(root, "commands", "claudeclaw", "create-agent.md"), "cmd");

  // Fake home dir (empty)
  await mkdir(join(home, ".claude"), { recursive: true });

  return {
    root,
    home,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}

describe("ensureUserSymlinks", () => {
  test("no-op when CLAUDECLAW_ROOT is unset (local dev)", async () => {
    const result = await ensureUserSymlinks({ claudeclawRoot: undefined, homeDir: "/nonexistent" });
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("no-op when CLAUDECLAW_ROOT equals cwd (dev running from repo root)", async () => {
    const result = await ensureUserSymlinks({ claudeclawRoot: process.cwd(), homeDir: "/nonexistent" });
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("creates symlinks for every skill + commands/claudeclaw in deployed mode", async () => {
    const { root, home, cleanup } = await makeFakeInstall();
    try {
      const result = await ensureUserSymlinks({ claudeclawRoot: root, homeDir: home });

      expect(result.errors).toEqual([]);
      expect(result.created.length).toBe(3); // 2 skills + 1 commands dir

      const createAgentLink = join(home, ".claude", "skills", "create-agent");
      expect((await lstat(createAgentLink)).isSymbolicLink()).toBe(true);
      expect(await readlink(createAgentLink)).toBe(join(root, "skills", "create-agent"));

      const updateAgentLink = join(home, ".claude", "skills", "update-agent");
      expect((await lstat(updateAgentLink)).isSymbolicLink()).toBe(true);

      const commandsLink = join(home, ".claude", "commands", "claudeclaw");
      expect((await lstat(commandsLink)).isSymbolicLink()).toBe(true);
      expect(await readlink(commandsLink)).toBe(join(root, "commands", "claudeclaw"));
    } finally {
      await cleanup();
    }
  });

  test("idempotent: running twice skips already-linked paths, no errors", async () => {
    const { root, home, cleanup } = await makeFakeInstall();
    try {
      const first = await ensureUserSymlinks({ claudeclawRoot: root, homeDir: home });
      expect(first.created.length).toBe(3);

      const second = await ensureUserSymlinks({ claudeclawRoot: root, homeDir: home });
      expect(second.created).toEqual([]);
      expect(second.skipped.length).toBe(3);
      expect(second.errors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("does not overwrite user-created skills with the same name", async () => {
    const { root, home, cleanup } = await makeFakeInstall();
    try {
      // User already has their own create-agent skill (not a symlink — a real dir)
      const userOwnDir = join(home, ".claude", "skills", "create-agent");
      await mkdir(userOwnDir, { recursive: true });
      await writeFile(join(userOwnDir, "SKILL.md"), "user's own skill");

      const result = await ensureUserSymlinks({ claudeclawRoot: root, homeDir: home });

      // The user's create-agent was skipped
      expect(result.skipped).toContain(userOwnDir);
      // create-agent is still a real directory, not a symlink
      expect((await lstat(userOwnDir)).isDirectory()).toBe(true);
      expect((await lstat(userOwnDir)).isSymbolicLink()).toBe(false);
      // update-agent still got linked (different name, no collision)
      expect(result.created).toContain(join(home, ".claude", "skills", "update-agent"));
    } finally {
      await cleanup();
    }
  });
});
