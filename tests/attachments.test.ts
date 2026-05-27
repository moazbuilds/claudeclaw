import { test, expect } from "bun:test";
import {
  isDocumentAttachment,
  isImageDocument,
  isAudioDocument,
  pickMediaAttachment,
} from "../src/commands/telegram";

// --- isDocumentAttachment: any file-as-document is accepted ---

test("accepts arbitrary document mime types", () => {
  for (const mime of [
    "application/zip",
    "application/json",
    "text/x-python",
    "application/octet-stream",
    "application/x-sqlite3",
  ]) {
    expect(isDocumentAttachment({ file_id: "f", mime_type: mime })).toBe(true);
  }
});

test("accepts a document with no mime type", () => {
  expect(isDocumentAttachment({ file_id: "f" })).toBe(true);
  expect(isDocumentAttachment({ file_id: "f", file_name: "archive.tar.gz" })).toBe(true);
});

test("routes image and audio documents away from the document path", () => {
  expect(isDocumentAttachment({ file_id: "f", mime_type: "image/png" })).toBe(false);
  expect(isDocumentAttachment({ file_id: "f", mime_type: "audio/ogg" })).toBe(false);
});

test("returns false for an absent document", () => {
  expect(isDocumentAttachment(undefined)).toBe(false);
});

test("image/audio detectors still classify by mime prefix", () => {
  expect(isImageDocument({ file_id: "f", mime_type: "image/webp" })).toBe(true);
  expect(isImageDocument({ file_id: "f", mime_type: "application/pdf" })).toBe(false);
  expect(isAudioDocument({ file_id: "f", mime_type: "audio/mpeg" })).toBe(true);
  expect(isAudioDocument({ file_id: "f", mime_type: "video/mp4" })).toBe(false);
});

// --- pickMediaAttachment: gallery media fields ---

const baseMessage = { message_id: 1, chat: { id: 1, type: "private" } };

test("picks video and derives extension from mime/filename", () => {
  expect(pickMediaAttachment({ ...baseMessage, video: { file_id: "v", mime_type: "video/mp4" } }))
    .toMatchObject({ file_id: "v", kind: "video", fileName: "video.mp4" });
  expect(pickMediaAttachment({ ...baseMessage, video: { file_id: "v", file_name: "clip.mov" } }))
    .toMatchObject({ kind: "video", fileName: "clip.mov" });
  expect(pickMediaAttachment({ ...baseMessage, video: { file_id: "v", mime_type: "video/webm" } }))
    .toMatchObject({ kind: "video", fileName: "video.webm" });
});

test("picks animation (GIF) as mp4 by default", () => {
  expect(pickMediaAttachment({ ...baseMessage, animation: { file_id: "a" } }))
    .toMatchObject({ kind: "animation", fileName: "animation.mp4" });
});

test("picks sticker with the right extension per variant", () => {
  expect(pickMediaAttachment({ ...baseMessage, sticker: { file_id: "s" } }))
    .toMatchObject({ kind: "sticker", fileName: "sticker.webp" });
  expect(pickMediaAttachment({ ...baseMessage, sticker: { file_id: "s", is_animated: true } }))
    .toMatchObject({ kind: "sticker", fileName: "sticker.tgs" });
  expect(pickMediaAttachment({ ...baseMessage, sticker: { file_id: "s", is_video: true } }))
    .toMatchObject({ kind: "sticker", fileName: "sticker.webm" });
});

test("picks video_note as mp4", () => {
  expect(pickMediaAttachment({ ...baseMessage, video_note: { file_id: "n" } }))
    .toMatchObject({ kind: "video_note", fileName: "video_note.mp4" });
});

test("returns null when no gallery media field is present", () => {
  expect(pickMediaAttachment(baseMessage)).toBeNull();
  expect(pickMediaAttachment({ ...baseMessage, document: { file_id: "d" } })).toBeNull();
});
