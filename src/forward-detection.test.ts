import { describe, test, expect } from "bun:test";
import { classifyForward } from "./commands/discord";

// Regression coverage for: "the router keeps hitting messages that are just
// Discord forwarding one of my own prior posts back into the channel" —
// reported 3x in one week. Discord's native Forward feature reposts a
// message via `message_reference.type === 1 (FORWARD)` + `message_snapshots`,
// and (per Discord docs) never through `content`/`attachments` on the
// forwarding message itself. The snapshot deliberately omits `author`
// (anti-spoofing), so we can't tell whose message it originally was — only
// whether there's any real *new* content alongside the forward.

function baseMessage(overrides: Record<string, any> = {}): any {
  return {
    id: "100",
    channel_id: "chan-1",
    author: { id: "u1", username: "dork", discriminator: "0", bot: false },
    content: "",
    attachments: [],
    mentions: [],
    type: 0,
    ...overrides,
  };
}

describe("classifyForward", () => {
  test("plain message is not a forward and keeps its full content", () => {
    const result = classifyForward(baseMessage({ content: "hey can you check the deploy" }));
    expect(result.isForward).toBe(false);
    expect(result.shouldSkip).toBe(false);
    expect(result.addedText).toBe("hey can you check the deploy");
  });

  test("a reply (not a forward) is unaffected", () => {
    const result = classifyForward(
      baseMessage({
        content: "yes do that",
        message_reference: { type: 0, message_id: "50" }, // DEFAULT = reply
        referenced_message: baseMessage({ id: "50", content: "old bot msg" }),
      }),
    );
    expect(result.isForward).toBe(false);
    expect(result.addedText).toBe("yes do that");
  });

  test("pure forward with no added commentary is skipped", () => {
    const result = classifyForward(
      baseMessage({
        content: "",
        message_reference: { type: 1, message_id: "50" },
        message_snapshots: [{ message: { type: 0, content: "Noticed the router keeps hitting messages that are just forwards." } }],
      }),
    );
    expect(result.isForward).toBe(true);
    expect(result.shouldSkip).toBe(true);
    expect(result.addedText).toBe("");
  });

  test("forward of a non-bot message with no commentary is also skipped — the rule is 'no new content', not 'whose message'", () => {
    const result = classifyForward(
      baseMessage({
        content: "",
        message_reference: { type: 1, message_id: "77" },
        message_snapshots: [{ message: { type: 0, content: "some other user's old message" } }],
      }),
    );
    expect(result.shouldSkip).toBe(true);
  });

  test("forward with genuine added commentary is processed, using only the commentary", () => {
    const result = classifyForward(
      baseMessage({
        content: "can you turn this into a job?",
        message_reference: { type: 1, message_id: "50" },
        message_snapshots: [{ message: { type: 0, content: "Noticed the router keeps hitting messages..." } }],
      }),
    );
    expect(result.isForward).toBe(true);
    expect(result.shouldSkip).toBe(false);
    expect(result.addedText).toBe("can you turn this into a job?");
  });

  test("content that's an exact duplicate of the snapshot (leak/quirk) counts as no new content", () => {
    const text = "Noticed the router keeps hitting messages that are just forwards.";
    const result = classifyForward(
      baseMessage({
        content: text,
        message_reference: { type: 1, message_id: "50" },
        message_snapshots: [{ message: { type: 0, content: text } }],
      }),
    );
    expect(result.shouldSkip).toBe(true);
  });

  test("content that's a truncated, ellipsis-trailing prefix of the snapshot counts as no new content", () => {
    const result = classifyForward(
      baseMessage({
        content: "Noticed the router keeps hitting messages that are just...",
        message_reference: { type: 1, message_id: "50" },
        message_snapshots: [
          {
            message: {
              type: 0,
              content:
                "Noticed the router keeps hitting messages that are just Discord forwarding one of my own prior posts back into the channel.",
            },
          },
        ],
      }),
    );
    expect(result.shouldSkip).toBe(true);
  });

  test("multiple snapshots — classification is based on the first", () => {
    const result = classifyForward(
      baseMessage({
        content: "",
        message_reference: { type: 1, message_id: "50" },
        message_snapshots: [
          { message: { type: 0, content: "first forwarded message" } },
          { message: { type: 0, content: "second forwarded message" } },
        ],
      }),
    );
    expect(result.shouldSkip).toBe(true);
  });

  test("message_reference.type=FORWARD with no snapshots (malformed/incomplete payload) is not treated as a forward — real content is preserved", () => {
    const result = classifyForward(
      baseMessage({
        content: "just a normal message that happens to carry a stray reference type",
        message_reference: { type: 1 },
        message_snapshots: [],
      }),
    );
    expect(result.isForward).toBe(false);
    expect(result.addedText).toBe("just a normal message that happens to carry a stray reference type");
  });

  test("snapshots present but reference type is a reply (0) — not misclassified as a forward", () => {
    const result = classifyForward(
      baseMessage({
        content: "hey check this out",
        message_reference: { type: 0, message_id: "50" },
        message_snapshots: [{ message: { type: 0, content: "unrelated snapshot data" } }],
      }),
    );
    expect(result.isForward).toBe(false);
  });

  test("coincidental text match with no forward wire signals is NOT skipped — false-positive guard", () => {
    // A user retyping or pasting text that happens to match a prior bot
    // message, with none of Discord's forward metadata present, must still
    // be treated as a genuine fresh message.
    const result = classifyForward(
      baseMessage({ content: "Noticed the router keeps hitting messages that are just forwards." }),
    );
    expect(result.isForward).toBe(false);
    expect(result.shouldSkip).toBe(false);
    expect(result.addedText).toBe("Noticed the router keeps hitting messages that are just forwards.");
  });

  test("forward with only whitespace as content has no added commentary", () => {
    const result = classifyForward(
      baseMessage({
        content: "   ",
        message_reference: { type: 1, message_id: "50" },
        message_snapshots: [{ message: { type: 0, content: "the original text" } }],
      }),
    );
    expect(result.shouldSkip).toBe(true);
    expect(result.addedText).toBe("");
  });
});
