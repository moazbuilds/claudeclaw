// Reaction-as-training-data capture for ClaudeClaw.
//
// Two append-only logs:
//   training/responses.jsonl — every bot reply (so reactions can be joined by id)
//   training/reactions.jsonl — every classifiable reaction event
//
// The /claudeclaw:learn skill joins them and proposes feedback-memory entries
// that the human approves before they get written.

import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

const TRAINING_DIR = join(process.cwd(), ".claude", "claudeclaw", "training");
const RESPONSES_LOG = join(TRAINING_DIR, "responses.jsonl");
const REACTIONS_LOG = join(TRAINING_DIR, "reactions.jsonl");

export type Sentiment = "positive" | "negative" | "neutral";

// Default emoji classifier. Strips Unicode variation selectors (U+FE0F) so
// "❤️" and "❤" both match. Custom Discord emoji (`<:name:id>` form) are
// classified by name keywords.
const POSITIVE = new Set([
  "❤", "🧡", "💛", "💚", "💙", "💜", "🤎", "🖤", "🤍",
  "🔥", "👍", "✅", "🎯", "⚡", "💯", "🙌", "👏", "🎉", "🤩",
  "😍", "😻", "💖", "💗", "💕", "✨", "🚀", "👌", "🫡", "🏆",
]);

const NEGATIVE = new Set([
  "👎", "💩", "😬", "🤦", "🤦‍♂️", "🤦‍♀️", "❌", "🚫", "😞", "😟",
  "😡", "🤬", "🙄", "😒", "🥱", "😴", "🫠", "💀", "🤮", "❎",
]);

const POSITIVE_KEYWORDS = ["yes", "good", "love", "fire", "perfect", "great", "nice", "approve", "thumbs", "up"];
const NEGATIVE_KEYWORDS = ["no", "bad", "facepalm", "boring", "wrong", "hate", "down", "ugh", "cringe"];

function stripVS(s: string): string {
  return s.replace(/\uFE0F/g, "");
}

export function classifyEmoji(emojiName: string | null, isCustom: boolean): Sentiment {
  if (!emojiName) return "neutral";
  if (isCustom) {
    const lower = emojiName.toLowerCase();
    if (NEGATIVE_KEYWORDS.some((k) => lower.includes(k))) return "negative";
    if (POSITIVE_KEYWORDS.some((k) => lower.includes(k))) return "positive";
    return "neutral";
  }
  const stripped = stripVS(emojiName);
  if (POSITIVE.has(stripped)) return "positive";
  if (NEGATIVE.has(stripped)) return "negative";
  return "neutral";
}

async function ensureDir(): Promise<void> {
  await mkdir(TRAINING_DIR, { recursive: true });
}

export interface ResponseRecord {
  type: "response";
  messageId: string;
  channelId: string;
  userId: string;        // user who triggered the reply
  prompt: string;
  response: string;
  timestamp: string;
}

export interface ReactionRecord {
  type: "reaction";
  messageId: string;
  channelId: string;
  reactorId: string;
  emoji: string;          // raw emoji (unicode) or name (custom)
  isCustom: boolean;
  sentiment: Sentiment;
  timestamp: string;
}

// Cap stored prompt/response so a giant reply doesn't blow up the log.
const MAX_TEXT = 4000;

function truncate(s: string): string {
  if (s.length <= MAX_TEXT) return s;
  return s.slice(0, MAX_TEXT) + "…[truncated]";
}

export async function recordResponse(rec: Omit<ResponseRecord, "type" | "timestamp">): Promise<void> {
  await ensureDir();
  const full: ResponseRecord = {
    type: "response",
    ...rec,
    prompt: truncate(rec.prompt),
    response: truncate(rec.response),
    timestamp: new Date().toISOString(),
  };
  await appendFile(RESPONSES_LOG, JSON.stringify(full) + "\n", "utf8");
}

export async function recordReaction(rec: Omit<ReactionRecord, "type" | "timestamp">): Promise<void> {
  await ensureDir();
  const full: ReactionRecord = {
    type: "reaction",
    ...rec,
    timestamp: new Date().toISOString(),
  };
  await appendFile(REACTIONS_LOG, JSON.stringify(full) + "\n", "utf8");
}

export const TRAINING_PATHS = {
  dir: TRAINING_DIR,
  responses: RESPONSES_LOG,
  reactions: REACTIONS_LOG,
} as const;
