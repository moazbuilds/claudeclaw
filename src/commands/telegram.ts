import { ensureProjectClaudeMd, run, runUserMessage, compactCurrentSession, compactCurrentThreadSession, isRateLimited, getRateLimitResetAt } from "../runner";
import { extractErrorDetail } from "../messaging";
import { getSettings, loadSettings } from "../config";
import { transcribeAudioToText } from "../whisper";
import { resetSession, resetFallbackSession, peekSession } from "../sessions";
import { peekThreadSession, removeThreadSession } from "../sessionManager";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolveSkillPrompt, listSkills } from "../skills";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { isWizardTrigger, hasActiveWizard, handleWizardInput } from "./plugin-wizard";

// --- Markdown → Telegram HTML conversion (ported from nanobot) ---

function markdownToTelegramHtml(text: string): string {
  if (!text) return "";

  // 1. Extract and protect code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract and protect inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Strip markdown headers
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // 4. Strip blockquotes
  text = text.replace(/^>\s*(.*)$/gm, "$1");

  // 5. Escape HTML special characters
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 6. Links [text](url) — before bold/italic to handle nested cases
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 7. Bold **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  // 8. Italic _text_ (avoid matching inside words like some_var_name)
  text = text.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "<i>$1</i>");

  // 9. Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 10. Bullet lists
  text = text.replace(/^[-*]\s+/gm, "• ");

  // 11. Restore inline code with HTML tags
  for (let i = 0; i < inlineCodes.length; i++) {
    const escaped = inlineCodes[i].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(`\x00IC${i}\x00`, `<code>${escaped}</code>`);
  }

  // 12. Restore code blocks with HTML tags
  for (let i = 0; i < codeBlocks.length; i++) {
    const escaped = codeBlocks[i].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(`\x00CB${i}\x00`, `<pre><code>${escaped}</code></pre>`);
  }

  return text;
}

// --- Telegram Bot API (raw fetch, zero deps) ---

const API_BASE = "https://api.telegram.org/bot";
const FILE_API_BASE = "https://api.telegram.org/file/bot";

interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  reply_to_message?: { message_id?: number; from?: TelegramUser };
  chat: { id: number; type: string };
  message_thread_id?: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  entities?: Array<{
    type: "mention" | "bot_command" | string;
    offset: number;
    length: number;
  }>;
  caption_entities?: Array<{
    type: "mention" | "bot_command" | string;
    offset: number;
    length: number;
  }>;
}

interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  mime_type?: string;
  duration?: number;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  mime_type?: string;
  duration?: number;
  file_name?: string;
  file_size?: number;
}

interface TelegramChatMember {
  user: TelegramUser;
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
}

interface TelegramMyChatMemberUpdate {
  chat: { id: number; type: string; title?: string };
  from: TelegramUser;
  old_chat_member: TelegramChatMember;
  new_chat_member: TelegramChatMember;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  my_chat_member?: TelegramMyChatMemberUpdate;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMe {
  id: number;
  username?: string;
  can_read_all_group_messages?: boolean;
}

interface TelegramFile {
  file_path?: string;
}

let telegramDebug = false;

function debugLog(message: string): void {
  if (!telegramDebug) return;
  console.log(`[Telegram][debug] ${message}`);
}

function normalizeTelegramText(text: string): string {
  return text.replace(/[\u2010-\u2015\u2212]/g, "-");
}

function getMessageTextAndEntities(message: TelegramMessage): {
  text: string;
  entities: TelegramMessage["entities"];
} {
  if (message.text) {
    return {
      text: normalizeTelegramText(message.text),
      entities: message.entities,
    };
  }

  if (message.caption) {
    return {
      text: normalizeTelegramText(message.caption),
      entities: message.caption_entities,
    };
  }

  return { text: "", entities: [] };
}

function isImageDocument(document?: TelegramDocument): boolean {
  return Boolean(document?.mime_type?.startsWith("image/"));
}

function isAudioDocument(document?: TelegramDocument): boolean {
  return Boolean(document?.mime_type?.startsWith("audio/"));
}

const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "text/plain",
  "text/csv",
  "text/markdown",
]);

function isDocumentAttachment(document?: TelegramDocument): boolean {
  if (!document?.mime_type) return false;
  if (isImageDocument(document) || isAudioDocument(document)) return false;
  return DOCUMENT_MIME_TYPES.has(document.mime_type);
}

function pickLargestPhoto(photo: TelegramPhotoSize[]): TelegramPhotoSize {
  return [...photo].sort((a, b) => {
    const sizeA = a.file_size ?? a.width * a.height;
    const sizeB = b.file_size ?? b.width * b.height;
    return sizeB - sizeA;
  })[0];
}

function extensionFromMimeType(mimeType?: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/bmp":
      return ".bmp";
    default:
      return "";
  }
}

function extensionFromAudioMimeType(mimeType?: string): string {
  switch (mimeType) {
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/ogg":
      return ".ogg";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/webm":
      return ".webm";
    default:
      return "";
  }
}

function buildProgressBar(current: number, max: number, width: number = 20): string {
  const ratio = Math.min(current / max, 1);
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function extractTelegramCommand(text: string): string | null {
  const firstToken = text.trim().split(/\s+/, 1)[0];
  if (!firstToken.startsWith("/")) return null;
  return firstToken.split("@", 1)[0].toLowerCase();
}

async function callApi<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  // Add 15s buffer on top of Telegram's own long-poll timeout (default 30s)
  const telegramTimeout = (body?.timeout as number | undefined) ?? 0;
  const httpTimeout = Math.max(30_000, (telegramTimeout + 15) * 1000);
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(httpTimeout),
  });
  if (!res.ok) {
    throw new Error(`Telegram API ${method}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function sendMessage(token: string, chatId: number, text: string, threadId?: number): Promise<void> {
  const normalized = normalizeTelegramText(text).replace(/\[react:[^\]\r\n]+\]/gi, "");
  const html = markdownToTelegramHtml(normalized);
  const MAX_LEN = 4096;
  for (let i = 0; i < html.length; i += MAX_LEN) {
    try {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: html.slice(i, i + MAX_LEN),
        parse_mode: "HTML",
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    } catch {
      // Fallback to plain text if HTML parsing fails
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: normalized.slice(i, i + MAX_LEN),
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    }
  }
}

async function sendTyping(token: string, chatId: number, threadId?: number): Promise<void> {
  await callApi(token, "sendChatAction", {
    chat_id: chatId,
    action: "typing",
    ...(threadId ? { message_thread_id: threadId } : {}),
  }).catch(() => {});
}

async function sendDocumentToChat(
  token: string,
  chatId: number,
  filePath: string,
  threadId?: number
): Promise<void> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    console.error(`[Telegram] sendDocument: file not found: ${filePath}`);
    return;
  }

  const fileName = filePath.split("/").pop() ?? "document";
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  formData.append("document", file, fileName);
  if (threadId) formData.append("message_thread_id", String(threadId));

  const res = await fetch(`${API_BASE}${token}/sendDocument`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendDocument failed: ${res.status} ${body}`);
  }
}

function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}

function extractSendFileDirectives(text: string): {
  cleanedText: string;
  filePaths: string[];
} {
  const filePaths: string[] = [];
  const cleanedText = text
    .replace(/\[send-file:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (candidate) filePaths.push(candidate);
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, filePaths };
}

const VOICE_DIRECTIVE_RE = /\[voice:(\/[^\]\r\n]+)\]/gi;

function extractVoiceDirectives(text: string): { cleanedText: string; voicePaths: string[] } {
  const voicePaths: string[] = [];
  const cleanedText = text
    .replace(VOICE_DIRECTIVE_RE, (_match, path) => {
      const p = String(path).trim();
      if (p && existsSync(p)) voicePaths.push(p);
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, voicePaths };
}

async function sendVoiceMessage(token: string, chatId: number, voicePath: string, threadId?: number): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (threadId) form.append("message_thread_id", String(threadId));

  const file = Bun.file(voicePath);
  form.append("voice", file, voicePath.split("/").pop() ?? "voice.ogg");

  const res = await fetch(`${API_BASE}${token}/sendVoice`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendVoice: ${res.status} ${res.statusText} — ${body}`);
  }
}

async function sendReaction(token: string, chatId: number, messageId: number, emoji: string): Promise<void> {
  await callApi(token, "setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
  });
}

// --- Inline buttons support ---

/**
 * Parse [buttons: Label A | Label B \n Label C | Label D] directives from Claude output.
 * Each line of the directive becomes a row; pipes split buttons within a row.
 * Returns button rows and the cleaned text with the directive removed.
 */
function extractButtonsDirective(text: string): { cleanedText: string; buttonRows: string[][] | null } {
  let buttonRows: string[][] | null = null;
  const cleanedText = text
    .replace(/\[buttons:([^\]]+)\]/gi, (_match, raw) => {
      const rows = String(raw)
        .trim()
        .split(/\r?\n/)
        .map((row) => row.split("|").map((label) => label.trim()).filter(Boolean))
        .filter((row) => row.length > 0);
      if (rows.length > 0) buttonRows = rows;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, buttonRows };
}

// Map short button IDs to labels for callback routing (in-memory, per-process).
// IDs are never recycled within a process lifetime — the counter is strictly monotonic.
// Entries carry a creation timestamp so we can evict stale ones; otherwise a long-running
// daemon would accumulate every button label ever generated and leak memory unbounded.
type ButtonEntry = { label: string; createdAt: number };
const buttonLabelMap = new Map<string, ButtonEntry>();
let _buttonCounter = 0;
const BUTTON_TTL_MS = 24 * 60 * 60 * 1000; // 24h is well past any reasonable user dwell
const BUTTON_MAX_ENTRIES = 5000; // hard cap as a safety net for flood scenarios

function pruneExpiredButtons(now: number = Date.now()): void {
  for (const [id, entry] of buttonLabelMap) {
    if (now - entry.createdAt > BUTTON_TTL_MS) {
      buttonLabelMap.delete(id);
    }
  }
  // Hard cap defense: if a flood fills the map within TTL, drop oldest insertions
  // (Map preserves insertion order) until back under the cap.
  if (buttonLabelMap.size > BUTTON_MAX_ENTRIES) {
    const overflow = buttonLabelMap.size - BUTTON_MAX_ENTRIES;
    let dropped = 0;
    for (const id of buttonLabelMap.keys()) {
      if (dropped >= overflow) break;
      buttonLabelMap.delete(id);
      dropped++;
    }
  }
}

function getButtonLabel(btnId: string): string | undefined {
  const entry = buttonLabelMap.get(btnId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > BUTTON_TTL_MS) {
    buttonLabelMap.delete(btnId);
    return undefined;
  }
  return entry.label;
}

function makeButtonId(label: string): string {
  // Per-button counter guarantees uniqueness within a process lifetime.
  const id = `b${_buttonCounter++}`;
  buttonLabelMap.set(id, { label, createdAt: Date.now() });
  // Opportunistic eviction every 100 buttons — cheap O(n) sweep without a separate timer.
  if (_buttonCounter % 100 === 0) pruneExpiredButtons();
  return `btn:${id}`;
}

async function sendMessageWithButtons(
  token: string,
  chatId: number,
  text: string,
  buttonRows: string[][],
  threadId?: number
): Promise<void> {
  const body = text.trim() || "\u200B"; // zero-width space when text is empty (buttons-only)
  const normalized = normalizeTelegramText(body).replace(/\[react:[^\]\r\n]+\]/gi, "");
  const html = markdownToTelegramHtml(normalized);
  const inline_keyboard = buttonRows.map((row) =>
    row.map((label) => ({ text: label, callback_data: makeButtonId(label) }))
  );
  const MAX_LEN = 4096;
  // Send all chunks except the last without buttons; attach buttons only to the final chunk.
  for (let i = 0; i < html.length; i += MAX_LEN) {
    const isLast = i + MAX_LEN >= html.length;
    const replyMarkup = isLast ? { inline_keyboard } : undefined;
    try {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: html.slice(i, i + MAX_LEN),
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    } catch {
      // Fallback to plain text if HTML parse fails
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: normalized.slice(i, i + MAX_LEN),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    }
  }
}

let botUsername: string | null = null;
let botId: number | null = null;

function groupTriggerReason(message: TelegramMessage): string | null {
  if (botId && message.reply_to_message?.from?.id === botId) return "reply_to_bot";
  const { text, entities } = getMessageTextAndEntities(message);
  if (!text) return null;
  const lowerText = text.toLowerCase();
  if (botUsername && lowerText.includes(`@${botUsername.toLowerCase()}`)) return "text_contains_mention";

  for (const entity of entities ?? []) {
    const value = text.slice(entity.offset, entity.offset + entity.length);
    if (entity.type === "mention" && botUsername && value.toLowerCase() === `@${botUsername.toLowerCase()}`) {
      return "mention_entity_matches_bot";
    }
    if (entity.type === "mention" && !botUsername) return "mention_entity_before_botname_loaded";
    if (entity.type === "bot_command") {
      if (!value.includes("@")) return "bare_bot_command";
      if (!botUsername) return "scoped_command_before_botname_loaded";
      if (botUsername && value.toLowerCase().endsWith(`@${botUsername.toLowerCase()}`)) return "scoped_command_matches_bot";
    }
  }

  const { telegram } = getSettings();
  if (telegram.listenChats?.includes(message.chat.id)) return "listen_chat";

  return null;
}

async function downloadImageFromMessage(token: string, message: TelegramMessage): Promise<string | null> {
  const photo = message.photo && message.photo.length > 0 ? pickLargestPhoto(message.photo) : null;
  const imageDocument = isImageDocument(message.document) ? message.document : null;
  const fileId = photo?.file_id ?? imageDocument?.file_id;
  if (!fileId) return null;

  const fileMeta = await callApi<{ ok: boolean; result: TelegramFile }>(token, "getFile", { file_id: fileId });
  if (!fileMeta.ok || !fileMeta.result.file_path) return null;

  const remotePath = fileMeta.result.file_path;
  const downloadUrl = `${FILE_API_BASE}${token}/${remotePath}`;
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`);

  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "telegram");
  await mkdir(dir, { recursive: true });

  const remoteExt = extname(remotePath);
  const docExt = extname(imageDocument?.file_name ?? "");
  const mimeExt = extensionFromMimeType(imageDocument?.mime_type);
  const ext = remoteExt || docExt || mimeExt || ".jpg";
  const filename = `${message.chat.id}-${message.message_id}-${Date.now()}${ext}`;
  const localPath = join(dir, filename);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await Bun.write(localPath, bytes);
  return localPath;
}

async function downloadVoiceFromMessage(token: string, message: TelegramMessage): Promise<string | null> {
  const audioDocument = isAudioDocument(message.document) ? message.document : null;
  const audioLike = message.voice ?? message.audio ?? audioDocument;
  const fileId = audioLike?.file_id;
  if (!fileId) return null;

  const fileMeta = await callApi<{ ok: boolean; result: TelegramFile }>(token, "getFile", { file_id: fileId });
  if (!fileMeta.ok || !fileMeta.result.file_path) return null;

  const remotePath = fileMeta.result.file_path;
  const downloadUrl = `${FILE_API_BASE}${token}/${remotePath}`;
  debugLog(
    `Voice download: fileId=${fileId} remotePath=${remotePath} mime=${audioLike.mime_type ?? "unknown"} expectedSize=${audioLike.file_size ?? "unknown"}`
  );
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`);

  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "telegram");
  await mkdir(dir, { recursive: true });

  const remoteExt = extname(remotePath);
  const docExt = extname(message.document?.file_name ?? "");
  const audioExt = extname(message.audio?.file_name ?? "");
  const mimeExt = extensionFromAudioMimeType(audioLike.mime_type);
  const ext = remoteExt || docExt || audioExt || mimeExt || ".ogg";
  const filename = `${message.chat.id}-${message.message_id}-${Date.now()}${ext}`;
  const localPath = join(dir, filename);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await Bun.write(localPath, bytes);
  const header = Array.from(bytes.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  const oggMagic =
    bytes.length >= 4 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53;
  debugLog(
    `Voice download: wrote ${bytes.length} bytes to ${localPath} ext=${ext} header=${header || "empty"} oggMagic=${oggMagic}`
  );
  return localPath;
}

async function downloadDocumentFromMessage(
  token: string,
  message: TelegramMessage
): Promise<{ localPath: string; originalName: string } | null> {
  const doc = message.document;
  if (!doc || !isDocumentAttachment(doc)) return null;

  const fileMeta = await callApi<{ ok: boolean; result: TelegramFile }>(
    token,
    "getFile",
    { file_id: doc.file_id }
  );
  if (!fileMeta.ok || !fileMeta.result.file_path) return null;

  const remotePath = fileMeta.result.file_path;
  const downloadUrl = `${FILE_API_BASE}${token}/${remotePath}`;
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`);
  }

  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "telegram");
  await mkdir(dir, { recursive: true });

  const originalName = doc.file_name ?? `document${extname(remotePath) || ""}`;
  const ext = extname(originalName) || extname(remotePath) || "";
  const filename = `${message.chat.id}-${message.message_id}-${Date.now()}${ext}`;
  const localPath = join(dir, filename);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await Bun.write(localPath, bytes);
  return { localPath, originalName };
}

async function handleMyChatMember(update: TelegramMyChatMemberUpdate): Promise<void> {
  const config = getSettings().telegram;
  const chat = update.chat;
  if (!botUsername && update.new_chat_member.user.username) botUsername = update.new_chat_member.user.username;
  if (!botId) botId = update.new_chat_member.user.id;
  const oldStatus = update.old_chat_member.status;
  const newStatus = update.new_chat_member.status;
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const wasOut = oldStatus === "left" || oldStatus === "kicked";
  const isIn = newStatus === "member" || newStatus === "administrator";

  if (!isGroup || !wasOut || !isIn) return;

  const chatName = chat.title ?? String(chat.id);
  console.log(`[Telegram] Added to ${chat.type}: ${chatName} (${chat.id}) by ${update.from.id}`);

  const addedBy = update.from.username ?? `${update.from.first_name} (${update.from.id})`;
  const eventPrompt =
    `[Telegram system event] I was added to a ${chat.type}.\n` +
    `Group title: ${chatName}\n` +
    `Group id: ${chat.id}\n` +
    `Added by: ${addedBy}\n` +
    "Write a short first message for the group. It should confirm I was added and explain how to trigger me.";

  try {
    const result = await run("telegram", eventPrompt);
    if (result.exitCode !== 0) {
      await sendMessage(config.token, chat.id, "I was added to this group. Mention me with a command to start.");
      return;
    }
    await sendMessage(config.token, chat.id, result.stdout || "I was added to this group.");
  } catch (err) {
    console.error(`[Telegram] group-added event error: ${err instanceof Error ? err.message : err}`);
    await sendMessage(config.token, chat.id, "I was added to this group. Mention me with a command to start.");
  }
}

function getTelegramSessionKey(
  chatId: number,
  threadId: number | undefined,
  userId: number | undefined,
  isPrivate: boolean,
  dmIsolation: "shared" | "perUser",
): string | undefined {
  if (isPrivate) {
    if (dmIsolation === "perUser" && userId !== undefined) return `tg:dm:${userId}`;
    return undefined;
  }
  if (threadId !== undefined) return `tg:${chatId}:${threadId}`;
  return `tg:${chatId}`;
}

// --- Message handler ---

async function handleMessage(message: TelegramMessage): Promise<void> {
  const config = getSettings().telegram;
  const userId = message.from?.id;
  const chatId = message.chat.id;
  const threadId = message.message_thread_id;
  const { text } = getMessageTextAndEntities(message);
  const chatType = message.chat.type;
  const isPrivate = chatType === "private";
  const isGroup = chatType === "group" || chatType === "supergroup";
  const hasImage = Boolean((message.photo && message.photo.length > 0) || isImageDocument(message.document));
  const hasVoice = Boolean(message.voice || message.audio || isAudioDocument(message.document));
  const hasDocument = Boolean(message.document && isDocumentAttachment(message.document));
  const sessionKey = getTelegramSessionKey(chatId, threadId, userId, isPrivate, config.dmIsolation);

  if (!isPrivate && !isGroup) return;

  const triggerReason = isGroup ? groupTriggerReason(message) : "private_chat";
  if (isGroup && !triggerReason) {
    debugLog(
      `Skip group message chat=${chatId} from=${userId ?? "unknown"} reason=no_trigger text="${(text ?? "").slice(0, 80)}"`
    );
    return;
  }
  debugLog(
    `Handle message chat=${chatId} type=${chatType} from=${userId ?? "unknown"} reason=${triggerReason} text="${(text ?? "").slice(0, 80)}"`
  );

  if (userId && config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    if (isPrivate) {
      await sendMessage(config.token, chatId, "Unauthorized.");
    } else {
      console.log(`[Telegram] Ignored group message from unauthorized user ${userId} in chat ${chatId}`);
      debugLog(`Skip group message chat=${chatId} from=${userId} reason=unauthorized_user`);
    }
    return;
  }

  if (!text.trim() && !hasImage && !hasVoice && !hasDocument) {
    debugLog(`Skip message chat=${chatId} from=${userId ?? "unknown"} reason=empty_text`);
    return;
  }

  const command = text ? extractTelegramCommand(text) : null;
  if (command === "/start") {
    await sendMessage(
      config.token,
      chatId,
      "Hello! Send me a message and I'll respond using Claude.\nUse /reset to start a fresh session.",
      threadId
    );
    return;
  }

  if (command === "/reset") {
    if (sessionKey) {
      await removeThreadSession(sessionKey);
      await resetFallbackSession(undefined, sessionKey);
      await sendMessage(config.token, chatId, "Session reset. Next message starts fresh.", threadId);
    } else {
      await resetSession();
      await resetFallbackSession();
      await sendMessage(config.token, chatId, "Global session reset. Next message starts fresh.", threadId);
    }
    return;
  }

  if (command === "/compact") {
    await sendMessage(config.token, chatId, "⏳ Compacting session...", threadId);
    const result = sessionKey
      ? await compactCurrentThreadSession(sessionKey)
      : await compactCurrentSession();
    await sendMessage(config.token, chatId, result.message, threadId);
    return;
  }

  if (command === "/status") {
    const session = sessionKey ? await peekThreadSession(sessionKey) : await peekSession();
    const settings = getSettings();
    if (!session) {
      await sendMessage(config.token, chatId, "📊 No active session.", threadId);
      return;
    }
    const lines = [
      "📊 **Session Status**",
      `Session: \`${session.sessionId.slice(0, 8)}\``,
      `Turns: ${session.turnCount ?? 0}`,
      `Model: ${settings.model || "default"}`,
      `Security: ${settings.security.level}`,
      `Created: ${session.createdAt}`,
      `Last used: ${session.lastUsedAt}`,
      `Compact warned: ${(session as any).compactWarned ? "yes" : "no"}`,
    ];
    await sendMessage(config.token, chatId, lines.join("\n"), threadId);
    return;
  }

  if (command === "/context") {
    const session = sessionKey ? await peekThreadSession(sessionKey) : await peekSession();
    if (!session) {
      await sendMessage(config.token, chatId, "No active session.", threadId);
      return;
    }
    const home = homedir();
    const projectSlug = process.cwd().replace(/\//g, "-");
    const jsonlPath = `${home}/.claude/projects/${projectSlug}/${session.sessionId}.jsonl`;
    if (!existsSync(jsonlPath)) {
      await sendMessage(config.token, chatId, "Conversation file not found.", threadId);
      return;
    }
    try {
      const raw = await readFile(jsonlPath, "utf8");
      const fileLines = raw.trim().split("\n");
      let lastUsage: any = null;
      let totalOutput = 0;
      for (const line of fileLines) {
        try {
          const obj = JSON.parse(line);
          if (obj.message?.usage) lastUsage = obj.message.usage;
          if (obj.message?.usage?.output_tokens) totalOutput += obj.message.usage.output_tokens;
        } catch {}
      }
      if (!lastUsage) {
        await sendMessage(config.token, chatId, "No usage data found.", threadId);
        return;
      }
      const input = lastUsage.input_tokens ?? 0;
      const cacheCreation = lastUsage.cache_creation_input_tokens ?? 0;
      const cacheRead = lastUsage.cache_read_input_tokens ?? 0;
      const totalContext = input + cacheCreation + cacheRead;
      const maxContext = 200000;
      const pct = ((totalContext / maxContext) * 100).toFixed(1);
      const bar = buildProgressBar(totalContext, maxContext);
      const msg = [
        `📐 **Context Window**`,
        `${bar} ${pct}%`,
        ``,
        `Total: \`${totalContext.toLocaleString()}\` / \`${maxContext.toLocaleString()}\` tokens`,
        `├ Input: \`${input.toLocaleString()}\``,
        `├ Cache creation: \`${cacheCreation.toLocaleString()}\``,
        `├ Cache read: \`${cacheRead.toLocaleString()}\``,
        `└ Output (cumulative): \`${totalOutput.toLocaleString()}\``,
        ``,
        `Turns: ${session.turnCount ?? 0}`,
      ];
      await sendMessage(config.token, chatId, msg.join("\n"), threadId);
    } catch (err) {
      await sendMessage(config.token, chatId, `Failed to read context: ${err instanceof Error ? err.message : err}`, threadId);
    }
    return;
  }

  // Secretary: detect reply to a bot alert message → treat as custom reply
  const replyToMsgId = message.reply_to_message?.message_id;
  if (replyToMsgId && text && botId && message.reply_to_message?.from?.id === botId) {
    try {
      const lookupResp = await fetch(`http://127.0.0.1:9999/pending/by-bot-msg/${replyToMsgId}`);
      if (lookupResp.ok) {
        const item = await lookupResp.json() as { id?: string } | null;
        if (item?.id) {
          await fetch(`http://127.0.0.1:9999/confirm/${item.id}/custom`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
          await sendMessage(config.token, chatId, `✅ Sent custom reply + pattern learned.`, threadId);
          return;
        }
      }
    } catch {
      // fall through to normal handling if secretary endpoint unreachable
    }
  }

  const label = message.from?.username ?? String(userId ?? "unknown");
  const mediaParts = [hasImage ? "image" : "", hasVoice ? "voice" : "", hasDocument ? "doc" : ""].filter(Boolean);
  const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join("+")}]` : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Telegram ${label}${mediaSuffix}: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`
  );

  // Plugin wizard: local control-plane logic — not subject to rate limiting
  const wizardCtx = { iface: "telegram" as const, scopeId: String(chatId) };
  if ((command && isWizardTrigger(command)) || hasActiveWizard(wizardCtx)) {
    const reply = await handleWizardInput(wizardCtx, text.trim());
    await sendMessage(config.token, chatId, reply, threadId);
    return;
  }

  // If rate-limited, reply immediately without calling Claude
  if (isRateLimited()) {
    const resetAt = new Date(getRateLimitResetAt());
    const resetStr = resetAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    await sendMessage(config.token, chatId, `Usage limit reached. Resets at ${resetStr} UTC. I'll be back after that.`, threadId);
    return;
  }

  // Keep typing indicator alive while queued/running
  const typingInterval = setInterval(() => sendTyping(config.token, chatId, threadId), 4000);

  try {
    await sendTyping(config.token, chatId, threadId);
    let imagePath: string | null = null;
    let voicePath: string | null = null;
    let voiceTranscript: string | null = null;
    if (hasImage) {
      try {
        imagePath = await downloadImageFromMessage(config.token, message);
      } catch (err) {
        console.error(`[Telegram] Failed to download image for ${label}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (hasVoice) {
      try {
        voicePath = await downloadVoiceFromMessage(config.token, message);
      } catch (err) {
        console.error(`[Telegram] Failed to download voice for ${label}: ${err instanceof Error ? err.message : err}`);
      }

      if (voicePath) {
        debugLog(`Voice file saved: path=${voicePath}`);
        const { delegateTool } = getSettings().stt;
        if (!delegateTool) {
          try {
            voiceTranscript = await transcribeAudioToText(voicePath);
          } catch (err) {
            console.error(`[Telegram] Failed to transcribe voice for ${label}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }

    // Skill routing: resolve slash commands to SKILL.md prompts
    let skillContext: string | null = null;
    if (command && command !== "/start" && command !== "/reset" && command !== "/compact" && command !== "/status" && command !== "/context") {
      try {
        skillContext = await resolveSkillPrompt(command);
        if (skillContext) {
          debugLog(`Skill resolved for ${command}: ${skillContext.length} chars`);
        }
      } catch (err) {
        debugLog(`Skill resolution failed for ${command}: ${err instanceof Error ? err.message : err}`);
      }
    }

    let documentInfo: { localPath: string; originalName: string } | null = null;
    if (hasDocument) {
      try {
        documentInfo = await downloadDocumentFromMessage(config.token, message);
      } catch (err) {
        console.error(
          `[Telegram] Failed to download document for ${label}: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    const promptParts = [`[Telegram from ${label}]`];
    if (threadId) promptParts.push(`[thread:${threadId}]`);
    if (skillContext) {
      // Strip the slash command from the message text and pass remaining args
      const args = text.trim().slice(command!.length).trim();
      promptParts.push(`<command-name>${command}</command-name>`);
      promptParts.push(skillContext);
      if (args) promptParts.push(`User arguments: ${args}`);
    } else if (text.trim()) {
      promptParts.push(`Message: ${text}`);
    }
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    } else if (hasImage) {
      promptParts.push("The user attached an image, but downloading it failed. Respond and ask them to resend.");
    }
    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
    } else if (voicePath) {
      const { delegateTool } = getSettings().stt;
      if (delegateTool) {
        promptParts.push(`Voice file path: ${voicePath}`);
        promptParts.push(`The user sent a voice message. Transcribe it by calling \`${delegateTool}\` with the file path above, then respond to the transcribed text as their spoken message.`);
      } else {
        promptParts.push(
          "The user attached voice audio, but it could not be transcribed. Respond and ask them to resend a clearer clip."
        );
      }
    } else if (hasVoice) {
      promptParts.push(
        "The user attached voice audio, but downloading it failed. Respond and ask them to resend."
      );
    }
    if (documentInfo) {
      promptParts.push(`Document path: ${documentInfo.localPath}`);
      promptParts.push(`Original filename: ${documentInfo.originalName}`);
      promptParts.push(
        "The user attached a document. Read and process this file directly."
      );
    } else if (hasDocument) {
      promptParts.push(
        "The user attached a document, but downloading it failed. Respond and ask them to resend."
      );
    }
    const prefixedPrompt = promptParts.join("\n");
    const result = await runUserMessage("telegram", prefixedPrompt, sessionKey);

    if (result.exitCode !== 0) {
      const isTimedOut = result.exitCode === 124;
      const errorMsg = isTimedOut
        ? `⏱ Request timed out — the subprocess took too long and was killed. Try again or split into smaller steps.`
        : `Error (exit ${result.exitCode}): ${extractErrorDetail(result) || "Unknown error"}`;
      await sendMessage(config.token, chatId, errorMsg, threadId);
    } else {
      const { cleanedText: afterReact, reactionEmoji } = extractReactionDirective(result.stdout || "");
      const hadVoiceDirective = /\[voice:\/[^\]\r\n]+\]/i.test(afterReact);
      const { cleanedText: afterVoice, voicePaths } = extractVoiceDirectives(afterReact);
      const { cleanedText: afterFile, filePaths } = extractSendFileDirectives(afterVoice);
      const { cleanedText, buttonRows } = extractButtonsDirective(afterFile);
      if (reactionEmoji) {
        await sendReaction(config.token, chatId, message.message_id, reactionEmoji).catch((err) => {
          console.error(`[Telegram] Failed to send reaction for ${label}: ${err instanceof Error ? err.message : err}`);
        });
      }
      for (const vp of voicePaths) {
        try {
          await sendVoiceMessage(config.token, chatId, vp, threadId);
          debugLog(`Voice sent: ${vp}`);
        } catch (err) {
          console.error(`[Telegram] Failed to send voice ${vp} for ${label}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (buttonRows) {
        // Route on buttonRows regardless of whether cleanedText is empty
        await sendMessageWithButtons(config.token, chatId, cleanedText, buttonRows, threadId);
      } else if (cleanedText) {
        await sendMessage(config.token, chatId, cleanedText, threadId);
      }
      for (const fp of filePaths) {
        try {
          await sendDocumentToChat(config.token, chatId, fp, threadId);
        } catch (err) {
          console.error(`[Telegram] Failed to send document for ${label}: ${err instanceof Error ? err.message : err}`);
          await sendMessage(config.token, chatId, `Failed to send file: ${fp.split("/").pop()}`, threadId);
        }
      }
      if (!cleanedText && !buttonRows && filePaths.length === 0 && voicePaths.length === 0 && !hadVoiceDirective) {
        await sendMessage(config.token, chatId, "(empty response)", threadId);
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Telegram] Error for ${label}: ${errMsg}`);
    await sendMessage(config.token, chatId, `Error: ${errMsg}`, threadId);
  } finally {
    clearInterval(typingInterval);
  }
}

// --- Callback query handler ---

async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const config = getSettings().telegram;
  const data = query.data ?? "";

  // Enforce allowlist on callback queries (same policy as regular messages)
  const callbackUserId = query.from.id;
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(callbackUserId)) {
    await callApi(config.token, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Unauthorized.",
    }).catch(() => {});
    return;
  }

  // Secretary pattern: "sec_yes_<8hex>" or "sec_no_<8hex>"
  const secMatch = data.match(/^sec_(yes|no)_([0-9a-f]{8})$/);
  if (secMatch) {
    const action = secMatch[1];
    const pendingId = secMatch[2];
    let answerText = "⚠️ Server error";
    try {
      const resp = await fetch(`http://127.0.0.1:9999/confirm/${pendingId}/${action}`);
      const result = await resp.json() as { ok: boolean };
      answerText = action === "yes" && result.ok ? "✅ Đã gửi!" : result.ok ? "❌ Dismissed" : "⚠️ Not found";
      if (query.message) {
        const statusLine = action === "yes" ? "\n\n✅ Sent" : "\n\n❌ Dismissed";
        const newText = (query.message.text ?? "").replace(/\n\nReply:.*$/s, statusLine);
        await callApi(config.token, "editMessageText", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          text: newText,
        }).catch(() => {});
      }
    } catch {
      // server not running or error
    }
    await callApi(config.token, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: answerText,
    }).catch(() => {});
    return;
  }

  // Generic inline button press (btn:<id> pattern from [buttons: ...] directive)
  if (data.startsWith("btn:")) {
    const btnId = data.slice(4);
    const label = getButtonLabel(btnId);

    // Reject unknown/expired IDs — don't fall back to treating the raw ID as a label.
    // IDs are process-local; after a daemon restart old buttons are always expired.
    if (!label) {
      await callApi(config.token, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "This button has expired. Please continue the conversation.",
        show_alert: true,
      }).catch(() => {});
      return;
    }

    // Ack immediately so Telegram stops showing the loading spinner
    await callApi(config.token, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: label,
    }).catch(() => {});

    // Free the entry as soon as it's been consumed; buttons are one-shot.
    buttonLabelMap.delete(btnId);

    // Edit original message to mark the selected button visually
    if (query.message) {
      const originalText = query.message.text ?? "";
      await callApi(config.token, "editMessageText", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text: `${originalText}\n\n› ${label}`,
      }).catch(() => {});
    }

    // Inject button press as a new user message to the running Claude session
    const chatId = query.message?.chat.id ?? query.from.id;
    const threadId = query.message?.message_thread_id;
    try {
      const result = await runUserMessage("telegram", `[Button pressed: ${label}]`);
      if (result.exitCode === 0 && result.stdout) {
        const { cleanedText: afterReact, reactionEmoji } = extractReactionDirective(result.stdout);
        const { cleanedText: afterVoice, voicePaths } = extractVoiceDirectives(afterReact);
        const { cleanedText: afterFile, filePaths } = extractSendFileDirectives(afterVoice);
        const { cleanedText, buttonRows } = extractButtonsDirective(afterFile);
        if (reactionEmoji && query.message) {
          await sendReaction(config.token, chatId, query.message.message_id, reactionEmoji).catch(() => {});
        }
        for (const vp of voicePaths) {
          await sendVoiceMessage(config.token, chatId, vp, threadId).catch(() => {});
        }
        if (buttonRows) {
          await sendMessageWithButtons(config.token, chatId, cleanedText, buttonRows, threadId);
        } else if (cleanedText) {
          await sendMessage(config.token, chatId, cleanedText, threadId);
        }
        for (const fp of filePaths) {
          await sendDocumentToChat(config.token, chatId, fp, threadId).catch(() => {});
        }
      } else if (result.exitCode !== 0) {
        await sendMessage(config.token, chatId, `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`, threadId);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await sendMessage(config.token, chatId, `Error: ${errMsg}`, threadId);
    }
    return;
  }

  // Default: ack with no text
  await callApi(config.token, "answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
}

// --- Bot command menu registration ---

async function registerBotCommands(token: string): Promise<void> {
  try {
    const skills = await listSkills();
    const commands = [
      { command: "start", description: "Show welcome message" },
      { command: "reset", description: "Reset session and start fresh" },
      { command: "compact", description: "Compact session to reduce context size" },
      { command: "status", description: "Show current session status" },
      { command: "context", description: "Show context window usage" },
    ];
    for (const skill of skills) {
      // Telegram commands: 1-32 chars, lowercase a-z, 0-9, underscores only
      const cmd = skill.name
        .toLowerCase()
        .replace(/[-.:]/g, "_")
        .replace(/[^a-z0-9_]/g, "")
        .slice(0, 32);
      if (!cmd || cmd === "start" || cmd === "reset") continue;
      if (cmd.length > 30) continue;
      const desc = skill.description.length >= 3
        ? skill.description.slice(0, 256)
        : `Run ${skill.name} skill`;
      commands.push({ command: cmd, description: desc });
    }
    if (commands.length > 100) commands.length = 100;
    try {
      await callApi(token, "setMyCommands", { commands });
      console.log(`  Commands registered: ${commands.length} (${commands.map((c) => "/" + c.command).join(", ")})`);
    } catch (regErr) {
      // Skill-generated commands may violate Telegram constraints; retry with built-in commands only
      console.warn(`[Telegram] Full command registration failed, retrying with built-in commands only: ${regErr instanceof Error ? regErr.message : regErr}`);
      const builtinOnly = commands.filter((c) => ["start", "reset", "compact", "status", "context"].includes(c.command));
      await callApi(token, "setMyCommands", { commands: builtinOnly });
      console.log(`  Commands registered (built-in only): ${builtinOnly.length}`);
    }
  } catch (err) {
    console.error(`[Telegram] Failed to register commands: ${err instanceof Error ? err.message : err}`);
  }
}

// --- Polling loop ---

let running = true;
let isPolling = false;
// Monotonically increasing counter. Each startPolling() call captures the
// value at the time it starts. The poll loop checks it after every await so
// a stale loop exits cleanly when stopPolling() or a subsequent startPolling()
// increments the counter, even if a long-poll request is still in flight.
let pollingGeneration = 0;

async function poll(generation: number): Promise<void> {
  const config = getSettings().telegram;
  let offset = 0;
  try {
    const me = await callApi<{ ok: boolean; result: TelegramMe }>(config.token, "getMe");
    if (me.ok) {
      botUsername = me.result.username ?? null;
      botId = me.result.id;
      console.log(`  Bot: ${botUsername ? `@${botUsername}` : botId}`);
      console.log(`  Group privacy: ${me.result.can_read_all_group_messages ? "disabled (reads all messages)" : "enabled (commands & mentions only)"}`);
    }
  } catch (err) {
    console.error(`[Telegram] getMe failed: ${err instanceof Error ? err.message : err}`);
  }

  console.log("Telegram bot started (long polling)");
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
  if (telegramDebug) console.log("  Debug: enabled");

  // Register available skills as bot command menu (non-blocking)
  registerBotCommands(config.token).catch(() => {});

  while (running && pollingGeneration === generation) {
    try {
      const data = await callApi<{ ok: boolean; result: TelegramUpdate[] }>(
        config.token,
        "getUpdates",
        { offset, timeout: 30, allowed_updates: ["message", "my_chat_member", "callback_query"] }
      );

      // Check generation after the in-flight long-poll request returns.
      if (pollingGeneration !== generation) break;

      if (!data.ok || !data.result.length) continue;

      for (const update of data.result) {
        debugLog(
          `Update ${update.update_id} keys=${Object.keys(update).join(",")}`
        );
        offset = update.update_id + 1;
        const incomingMessages = [
          update.message,
          update.edited_message,
          update.channel_post,
          update.edited_channel_post,
        ].filter((m): m is TelegramMessage => Boolean(m));
        for (const incoming of incomingMessages) {
          handleMessage(incoming).catch((err) => {
            console.error(`[Telegram] Unhandled: ${err}`);
          });
        }
        if (update.my_chat_member) {
          handleMyChatMember(update.my_chat_member).catch((err) => {
            console.error(`[Telegram] my_chat_member unhandled: ${err}`);
          });
        }
        if (update.callback_query) {
          handleCallbackQuery(update.callback_query).catch((err) => {
            console.error(`[Telegram] callback_query unhandled: ${err}`);
          });
        }
      }
    } catch (err) {
      if (pollingGeneration !== generation) break;
      if (!running) break;
      console.error(`[Telegram] Poll error: ${err instanceof Error ? err.message : err}`);
      await Bun.sleep(5000);
    }
  }

  if (pollingGeneration === generation) isPolling = false;
}

// --- Exports ---

/** Send a message to a specific chat (used by heartbeat forwarding) */
export { sendMessage };

process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; });

/** Start polling in-process (called by start.ts when token is configured) */
export function startPolling(debug = false): void {
  if (isPolling) return;
  running = true;
  isPolling = true;
  telegramDebug = debug;
  const gen = ++pollingGeneration;
  (async () => {
    await ensureProjectClaudeMd();
    await poll(gen);
  })().catch((err) => {
    if (pollingGeneration === gen) {
      console.error(`[Telegram] Fatal: ${err}`);
      isPolling = false;
    }
  });
}

/** Stop polling in-process (called by start.ts when receiveEnabled is toggled off).
 *  Increments the generation token so the in-flight long-poll loop exits as soon
 *  as its current getUpdates call returns, even if running is briefly reset to true
 *  by a concurrent startPolling() call. */
export function stopPolling(): void {
  pollingGeneration++;
  running = false;
  isPolling = false;
}

/** Standalone entry point (bun run src/index.ts telegram) */
export async function telegram() {
  await loadSettings();
  await ensureProjectClaudeMd();
  await poll(++pollingGeneration);
}
