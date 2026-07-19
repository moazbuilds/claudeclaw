import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdir, writeFile, readFile, readdir, rm } from "fs/promises";
import { join } from "path";

const TEST_ROOT = join(import.meta.dir, "../../test-sandbox-usage");
const CLAUDECLAW_DIR = join(TEST_ROOT, ".claude", "claudeclaw");

const GLOBAL_SESSION_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_SESSION_ID = "22222222-2222-2222-2222-222222222222";
const MISSING_SESSION_ID = "99999999-9999-9999-9999-999999999999";

async function resetSandbox() {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(CLAUDECLAW_DIR, { recursive: true });
}

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

/** Run resetSessionById() in the sandbox dir via a child bun process (so process.cwd() == TEST_ROOT). */
async function resetSessionInSandbox(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  const script = `
import { resetSessionById } from ${JSON.stringify(join(import.meta.dir, "..", "ui", "services", "usage"))};
try {
  await resetSessionById(${JSON.stringify(sessionId)});
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err) }));
}
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
  return JSON.parse(out || "{}");
}

describe("resetSessionById", () => {
  beforeEach(resetSandbox);

  test("global web session: backs up session.json and clears it", async () => {
    await writeFile(
      join(CLAUDECLAW_DIR, "session.json"),
      JSON.stringify({
        sessionId: GLOBAL_SESSION_ID,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        turnCount: 3,
      })
    );

    const result = await resetSessionInSandbox(GLOBAL_SESSION_ID);
    expect(result.ok).toBe(true);

    const files = await readdir(CLAUDECLAW_DIR);
    expect(files).not.toContain("session.json");
    expect(files.some((f) => f.startsWith("session_backup_"))).toBe(true);
  });

  test("thread session: removes the thread from sessions.json", async () => {
    await writeFile(
      join(CLAUDECLAW_DIR, "sessions.json"),
      JSON.stringify({
        threads: {
          "thread-1": {
            sessionId: THREAD_SESSION_ID,
            threadId: "thread-1",
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
            turnCount: 1,
            compactWarned: false,
          },
        },
      })
    );

    const result = await resetSessionInSandbox(THREAD_SESSION_ID);
    expect(result.ok).toBe(true);

    const sessions = JSON.parse(await readFile(join(CLAUDECLAW_DIR, "sessions.json"), "utf-8"));
    expect(sessions.threads["thread-1"]).toBeUndefined();
  });

  test("unknown sessionId: rejects with 'session not found'", async () => {
    const result = await resetSessionInSandbox(MISSING_SESSION_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("session not found");
  });

  test("invalid (non-UUID) sessionId: rejects without touching disk", async () => {
    const result = await resetSessionInSandbox("not-a-uuid");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid sessionId");
  });
});
