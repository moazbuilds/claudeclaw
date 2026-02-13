import { run } from "../runner";
import { getSettings, loadSettings } from "../config";
import { resetSession } from "../sessions";

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

interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
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

// --- Message handler ---

async function handleMessage(message: TelegramMessage): Promise<void> {
  const config = getSettings().telegram;
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text;

  if (message.chat.type !== "private") return;

  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    await sendMessage(config.token, chatId, "Unauthorized.");
    return;
  }

  if (!text?.trim()) return;

  if (text.trim() === "/start") {
    await sendMessage(
      config.token,
      chatId,
      "Hello! Send me a message and I'll respond using Claude.\nUse /reset to start a fresh session."
    );
    return;
  }

  if (text.trim() === "/reset") {
    await resetSession();
    await sendMessage(config.token, chatId, "Global session reset. Next message starts fresh.");
    return;
  }

  const label = message.from.username ?? String(userId);
  console.log(
    `[${new Date().toLocaleTimeString()}] Telegram ${label}: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`
  );

  // Keep typing indicator alive while queued/running
  const typingInterval = setInterval(() => sendTyping(config.token, chatId), 4000);

  try {
    await sendTyping(config.token, chatId);
    const prefixedPrompt = `[Telegram from ${label}]: ${text}`;
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

  console.log("Telegram bot started (long polling)");
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);

  while (running) {
    try {
      const data = await callApi<{ ok: boolean; result: TelegramUpdate[] }>(
        config.token,
        "getUpdates",
        { offset, timeout: 30, allowed_updates: ["message"] }
      );

      if (!data.ok || !data.result.length) continue;

      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.message) {
          handleMessage(update.message).catch((err) => {
            console.error(`[Telegram] Unhandled: ${err}`);
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
export function startPolling(): void {
  poll().catch((err) => {
    console.error(`[Telegram] Fatal: ${err}`);
  });
}

/** Standalone entry point (bun run src/index.ts telegram) */
export async function telegram() {
  await loadSettings();
  await poll();
}
