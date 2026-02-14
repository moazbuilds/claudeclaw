import { run } from "../runner";
import { getSettings, loadSettings } from "../config";
import { resetSession } from "../sessions";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";

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
  reply_to_message?: { from?: TelegramUser };
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
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

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  my_chat_member?: TelegramMyChatMemberUpdate;
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
  return text.replace(/\u2014/g, "-");
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

function extractTelegramCommand(text: string): string | null {
  const firstToken = text.trim().split(/\s+/, 1)[0];
  if (!firstToken.startsWith("/")) return null;
  return firstToken.split("@", 1)[0].toLowerCase();
}

async function callApi<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Telegram API ${method}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  const html = markdownToTelegramHtml(text);
  const MAX_LEN = 4096;
  for (let i = 0; i < html.length; i += MAX_LEN) {
    try {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: html.slice(i, i + MAX_LEN),
        parse_mode: "HTML",
      });
    } catch {
      // Fallback to plain text if HTML parsing fails
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: text.slice(i, i + MAX_LEN),
      });
    }
  }
}

async function sendTyping(token: string, chatId: number): Promise<void> {
  await callApi(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
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

// --- Message handler ---

async function handleMessage(message: TelegramMessage): Promise<void> {
  const config = getSettings().telegram;
  const userId = message.from?.id;
  const chatId = message.chat.id;
  const { text } = getMessageTextAndEntities(message);
  const chatType = message.chat.type;
  const isPrivate = chatType === "private";
  const isGroup = chatType === "group" || chatType === "supergroup";
  const hasImage = Boolean((message.photo && message.photo.length > 0) || isImageDocument(message.document));

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

  if (!text.trim() && !hasImage) {
    debugLog(`Skip message chat=${chatId} from=${userId ?? "unknown"} reason=empty_text`);
    return;
  }

  const command = text ? extractTelegramCommand(text) : null;
  if (command === "/start") {
    await sendMessage(
      config.token,
      chatId,
      "Hello! Send me a message and I'll respond using Claude.\nUse /reset to start a fresh session."
    );
    return;
  }

  if (command === "/reset") {
    await resetSession();
    await sendMessage(config.token, chatId, "Global session reset. Next message starts fresh.");
    return;
  }

  const label = message.from?.username ?? String(userId ?? "unknown");
  const mediaSuffix = hasImage ? " [image]" : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Telegram ${label}${mediaSuffix}: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`
  );

  // Keep typing indicator alive while queued/running
  const typingInterval = setInterval(() => sendTyping(config.token, chatId), 4000);

  try {
    await sendTyping(config.token, chatId);
    let imagePath: string | null = null;
    if (hasImage) {
      try {
        imagePath = await downloadImageFromMessage(config.token, message);
      } catch (err) {
        console.error(`[Telegram] Failed to download image for ${label}: ${err instanceof Error ? err.message : err}`);
      }
    }

    const promptParts = [`[Telegram from ${label}]`];
    if (text.trim()) promptParts.push(`Message: ${text}`);
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    } else if (hasImage) {
      promptParts.push("The user attached an image, but downloading it failed. Respond and ask them to resend.");
    }
    const prefixedPrompt = promptParts.join("\n");
    const result = await run("telegram", prefixedPrompt);

    if (result.exitCode !== 0) {
      await sendMessage(config.token, chatId, `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`);
    } else {
      await sendMessage(config.token, chatId, result.stdout || "(empty response)");
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Telegram] Error for ${label}: ${errMsg}`);
    await sendMessage(config.token, chatId, `Error: ${errMsg}`);
  } finally {
    clearInterval(typingInterval);
  }
}

// --- Polling loop ---

let running = true;

async function poll(): Promise<void> {
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

  while (running) {
    try {
      const data = await callApi<{ ok: boolean; result: TelegramUpdate[] }>(
        config.token,
        "getUpdates",
        { offset, timeout: 30, allowed_updates: ["message", "my_chat_member"] }
      );

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
      }
    } catch (err) {
      if (!running) break;
      console.error(`[Telegram] Poll error: ${err instanceof Error ? err.message : err}`);
      await Bun.sleep(5000);
    }
  }
}

// --- Exports ---

/** Send a message to a specific chat (used by heartbeat forwarding) */
export { sendMessage };

process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; });

/** Start polling in-process (called by start.ts when token is configured) */
export function startPolling(debug = false): void {
  telegramDebug = debug;
  poll().catch((err) => {
    console.error(`[Telegram] Fatal: ${err}`);
  });
}

/** Standalone entry point (bun run src/index.ts telegram) */
export async function telegram() {
  await loadSettings();
  await poll();
}
