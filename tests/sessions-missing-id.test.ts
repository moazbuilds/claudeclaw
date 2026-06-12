import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasValidSessionId } from "../src/sessionValidate.ts";

describe("hasValidSessionId", () => {
  it("accepts sessions with a non-empty sessionId", () => {
    assert.equal(
      hasValidSessionId({
        sessionId: "11111111-1111-4111-8111-111111111111",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        turnCount: 0,
        compactWarned: false,
      }),
      true,
    );
  });

  it("rejects parseable JSON missing sessionId (issue #228)", () => {
    assert.equal(
      hasValidSessionId({
        turnCount: 0,
        compactWarned: false,
        lastUsedAt: "2026-01-01T00:00:00.000Z",
      }),
      false,
    );
    assert.equal(hasValidSessionId({ sessionId: "" }), false);
    assert.equal(hasValidSessionId(null), false);
  });
});

describe("runner treats missing sessionId as new session", () => {
  it("uses optional sessionId when computing isNew", () => {
    const src = readFileSync(new URL("../src/runner.ts", import.meta.url), "utf8");
    assert.match(src, /const isNew = !existing\?\.sessionId;/);
  });
});

describe("thread session peeking", () => {
  it("validates sessions.json rows before returning them", () => {
    const src = readFileSync(new URL("../src/sessionManager.ts", import.meta.url), "utf8");
    assert.match(src, /return hasValidSessionId\(session\) \? session : null;/);
  });
});
