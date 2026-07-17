import { test, expect } from "bun:test";
import {
  formatHistoryFileNote,
  appendFileNotes,
  formatThreadHistoryAsContext,
} from "../src/commands/slack";

// --- formatHistoryFileNote: one line per attachment, by kind ---

test("downloaded image renders as a saved-path note", () => {
  expect(
    formatHistoryFileNote({ id: "F1", name: "invoice.jpg", mimetype: "image/jpeg" }, "/tmp/inbox/F1.jpg"),
  ).toBe("[image saved: /tmp/inbox/F1.jpg]");
});

test("downloaded document renders with its filename", () => {
  expect(
    formatHistoryFileNote(
      { id: "F2", name: "report.pdf", mimetype: "application/pdf", url_private: "https://x" },
      "/tmp/inbox/F2.pdf",
    ),
  ).toBe('[file "report.pdf" saved: /tmp/inbox/F2.pdf]');
});

test("voice files are marked, never downloaded", () => {
  expect(formatHistoryFileNote({ id: "F3", mimetype: "audio/ogg" }, null)).toBe(
    "[voice message — not transcribed]",
  );
});

test("undownloaded attachment still becomes visible with name and type", () => {
  expect(
    formatHistoryFileNote({ id: "F4", name: "big.zip", filetype: "zip", url_private: "https://x" }, null),
  ).toBe('[attachment "big.zip" (zip) — not downloaded]');
});

test("nameless file falls back to its id and mimetype", () => {
  expect(formatHistoryFileNote({ id: "F5", mimetype: "application/octet-stream" }, null)).toBe(
    '[attachment "F5" (application/octet-stream) — not downloaded]',
  );
});

// --- appendFileNotes: the core fix — file-only messages are no longer blank ---

test("a file-only message renders its attachment note instead of an empty line", () => {
  const resolved = new Map([["F1", "/tmp/inbox/F1.jpg"]]);
  expect(appendFileNotes("", [{ id: "F1", name: "invoice.jpg", mimetype: "image/jpeg" }], resolved)).toBe(
    "[image saved: /tmp/inbox/F1.jpg]",
  );
});

test("text and multiple attachments combine line by line", () => {
  const resolved = new Map<string, string | null>([
    ["F1", "/tmp/inbox/F1.jpg"],
    ["F2", null],
  ]);
  const out = appendFileNotes(
    "see these",
    [
      { id: "F1", name: "a.png", mimetype: "image/png" },
      { id: "F2", name: "b.pdf", filetype: "pdf", url_private: "https://x" },
    ],
    resolved,
  );
  expect(out).toBe('see these\n[image saved: /tmp/inbox/F1.jpg]\n[attachment "b.pdf" (pdf) — not downloaded]');
});

test("messages without files pass through untouched", () => {
  expect(appendFileNotes("plain text", undefined, new Map())).toBe("plain text");
  expect(appendFileNotes("plain text", [], new Map())).toBe("plain text");
});

// --- formatThreadHistoryAsContext: read-your-attachments instruction ---

test("thread history with a saved attachment appends the read instruction", () => {
  const ctx = formatThreadHistoryAsContext([
    { role: "user", text: "here is the invoice\n[image saved: /tmp/inbox/F1.jpg]", user: "U1", ts: "1" },
  ]);
  expect(ctx).toContain("[image saved: /tmp/inbox/F1.jpg]");
  expect(ctx).toContain("read the relevant ones directly");
});

test("thread history without attachments has no instruction line", () => {
  const ctx = formatThreadHistoryAsContext([
    { role: "user", text: "just words", user: "U1", ts: "1" },
  ]);
  expect(ctx).not.toContain("read the relevant ones directly");
});
