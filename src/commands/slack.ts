import { ensureProjectClaudeMd, runUserMessage, compactCurrentSession } from "../runner";
import { getSettings, loadSettings } from "../config";
import { resetSession, peekSession } from "../sessions";
import { listThreadSessions, peekThreadSession } from "../sessionManager";
import { transcribeAudioToText } from "../whisper";
import { resolveSkillPrompt } from "../skills";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";

// --- Slack API constants ---

const SLACK_API = "https://slack.com/api";

// --- Type interfaces ---

interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  filetype?: string;
}

interface SlackMessage {
  type: string;
  subtype?: string;
  text: string;
  user?: string;
  bot_id?: string;
  channel: string;
  ts: string;
  thread_ts?: string;     // set on thread replies; equals ts for the first reply
  files?: SlackFile[];
  channel_type?: string;  // "im" | "mpim" | "channel" | "group"
}

interface SlackSocketPayload {
  envelope_id: string;
  type: string;           // "events_api" | "slash_commands" | "interactive" | "disconnect"
  accepts_response_payload?: boolean;
  payload?: {
    // events_api
    type?: string;
    event?: SlackMessage;
    // slash_commands
    command?: string;
    text?: string;
    user_id?: string;
    channel_id?: string;
    // disconnect
    reason?: string;
  };
  // disconnect event fields
  reason?: string;
}

// --- Socket state ---

let ws: WebSocket | null = null;
let running = true;
let slackDebug = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Bot identity (populated from auth.test)
let botUserId: string | null = null;
let botUsername: string | null = null;

// --- Debug ---

function debugLog(message: string): void {
  if (!slackDebug) return;
  console.log(`[Slack][debug] ${message}`);
}

// --- Slack Web API helper ---

async function slackApi<T = Record<string, unknown>>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Slack API ${method}: HTTP ${res.status} ${text}`);
  }

  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) {
    throw new Error(`Slack API ${method} error: ${data.error ?? "unknown"}`);
  }
  return data;
}

// --- Message sending ---

async function sendMessage(
  token: string,
  channelId: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  // Strip [react:...] directives before sending
  const normalized = text.replace(/\[react:[^\]\r\n]+\]/gi, "").trim();
  if (!normalized) return;

  // Slack max message length is 40000 chars, chunk at 3800 for mrkdwn block limits
  const MAX_LEN = 3800;
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    const chunk = normalized.slice(i, i + MAX_LEN);
    const params: Record<string, unknown> = {
      channel: channelId,
      text: chunk,
    };
    if (threadTs) params.thread_ts = threadTs;
    await slackApi(token, "chat.postMessage", params);
  }
}

async function sendReaction(
  token: string,
  channelId: string,
  ts: string,
  emoji: string,
): Promise<void> {
  // Slack emoji names don't have colons and must be lowercase
  const name = emoji.replace(/:/g, "").toLowerCase();
  await slackApi(token, "reactions.add", {
    channel: channelId,
    timestamp: ts,
    name,
  }).catch((err) => {
    debugLog(`Reaction failed (${name}): ${err instanceof Error ? err.message : err}`);
  });
}

// --- Reaction directive extraction ---

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

// --- Thread session key ---
// Slack threads are (channel + thread_ts) rather than a distinct channel ID.
// We prefix with "slk:" to avoid collisions with Discord thread IDs in sessions.json.

function slackThreadId(channelId: string, threadTs: string): string {
  return `slk:${channelId}:${threadTs}`;
}

// --- File download ---

async function downloadSlackFile(
  token: string,
  file: SlackFile,
  type: "image" | "voice",
): Promise<string | null> {
  const url = file.url_private_download ?? file.url_private;
  if (!url) return null;

  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "slack");
  await mkdir(dir, { recursive: true });

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Slack file download failed: ${res.status}`);
  }

  const ext = extname(file.name ?? "") || (type === "voice" ? ".webm" : ".jpg");
  const filename = `${file.id}-${Date.now()}${ext}`;
  const localPath = join(dir, filename);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Bun.write(localPath, bytes);
  debugLog(`File downloaded: ${localPath} (${bytes.length} bytes)`);
  return localPath;
}

// --- Trigger check ---

function isImageFile(f: SlackFile): boolean {
  return Boolean(f.mimetype?.startsWith("image/"));
}

function isVoiceFile(f: SlackFile): boolean {
  return Boolean(
    f.mimetype?.startsWith("audio/") ||
    f.filetype === "webm" ||
    f.filetype === "mp4",
  );
}

function isBotMentioned(text: string): boolean {
  if (!botUserId) return false;
  return text.includes(`<@${botUserId}>`);
}

function isDM(event: SlackMessage): boolean {
  return event.channel_type === "im";
}

// --- Message handler ---

async function handleMessage(event: SlackMessage): Promise<void> {
  const config = getSettings().slack;

  // Ignore bot's own messages and other bot messages
  if (event.bot_id || !event.user) return;
  // Skip subtype messages (edits, joins, etc.) unless they are file_share
  if (event.subtype && event.subtype !== "file_share") return;

  const userId = event.user;
  const channelId = event.channel;
  const isDirectMessage = isDM(event);
  const isListenChannel = config.listenChannels.includes(channelId);
  const mentioned = isBotMentioned(event.text);

  // Determine if we should respond
  if (!isDirectMessage && !mentioned && !isListenChannel) {
    debugLog(`Skip channel=${channelId} user=${userId} text="${event.text.slice(0, 40)}"`);
    return;
  }

  // Authorization check
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    if (isDirectMessage) {
      await sendMessage(config.botToken, channelId, "Unauthorized.");
    }
    return;
  }

  // Strip mention from text
  let cleanText = event.text;
  if (botUserId) {
    cleanText = cleanText.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
  }

  const files = event.files ?? [];
  const imageFiles = files.filter(isImageFile);
  const voiceFiles = files.filter(isVoiceFile);
  const hasImage = imageFiles.length > 0;
  const hasVoice = voiceFiles.length > 0;

  if (!cleanText.trim() && !hasImage && !hasVoice) return;

  const label = userId;
  const mediaParts = [hasImage ? "image" : "", hasVoice ? "voice" : ""].filter(Boolean);
  const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join("+")}]` : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Slack ${label}${mediaSuffix}: "${cleanText.slice(0, 60)}${cleanText.length > 60 ? "..." : ""}"`,
  );

  try {
    // Determine thread context for multi-session support.
    // event.thread_ts is set when the message is inside a thread.
    // For the root message of a thread it equals event.ts.
    // We use it to key per-thread sessions; non-thread messages go to global session.
    const inThread = !!event.thread_ts;
    const replyThreadTs = event.thread_ts ?? event.ts; // reply in same thread
    const sessionThreadId = inThread ? slackThreadId(channelId, event.thread_ts!) : undefined;

    // Recover lost thread from sessions.json if needed
    if (inThread && sessionThreadId) {
      const persisted = await peekThreadSession(sessionThreadId);
      if (persisted) {
        debugLog(`Thread session recovered: ${sessionThreadId}`);
      }
    }

    let imagePath: string | null = null;
    let voicePath: string | null = null;
    let voiceTranscript: string | null = null;

    if (hasImage) {
      try {
        imagePath = await downloadSlackFile(config.botToken, imageFiles[0], "image");
      } catch (err) {
        console.error(`[Slack] Failed to download image: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (hasVoice) {
      try {
        voicePath = await downloadSlackFile(config.botToken, voiceFiles[0], "voice");
      } catch (err) {
        console.error(`[Slack] Failed to download voice: ${err instanceof Error ? err.message : err}`);
      }

      if (voicePath) {
        try {
          voiceTranscript = await transcribeAudioToText(voicePath, {
            debug: slackDebug,
            log: (msg) => debugLog(msg),
          });
        } catch (err) {
          console.error(`[Slack] Failed to transcribe voice: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Skill routing
    const command = cleanText.startsWith("/") ? cleanText.trim().split(/\s+/, 1)[0].toLowerCase() : null;
    let skillContext: string | null = null;
    if (command) {
      try {
        skillContext = await resolveSkillPrompt(command);
      } catch (err) {
        debugLog(`Skill resolution failed for ${command}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Build prompt
    const promptParts = [`[Slack from ${label}]`];
    if (skillContext) {
      const args = cleanText.trim().slice(command!.length).trim();
      promptParts.push(`<command-name>${command}</command-name>`);
      promptParts.push(skillContext);
      if (args) promptParts.push(`User arguments: ${args}`);
    } else if (cleanText.trim()) {
      promptParts.push(`Message: ${cleanText}`);
    }
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    } else if (hasImage) {
      promptParts.push("The user attached an image, but downloading it failed. Respond and ask them to resend.");
    }
    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
      promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
    } else if (hasVoice) {
      promptParts.push("The user attached voice audio, but it could not be transcribed. Ask them to resend a clearer clip.");
    }

    const prefixedPrompt = promptParts.join("\n");
    const result = await runUserMessage("slack", prefixedPrompt, sessionThreadId);

    if (result.exitCode !== 0) {
      await sendMessage(
        config.botToken,
        channelId,
        `Error (exit ${result.exitCode}): ${result.stderr || result.stdout || "Unknown error"}`,
        replyThreadTs,
      );
    } else {
      const { cleanedText, reactionEmoji } = extractReactionDirective(result.stdout || "");
      if (reactionEmoji) {
        await sendReaction(config.botToken, channelId, event.ts, reactionEmoji);
      }
      await sendMessage(config.botToken, channelId, cleanedText || "(empty response)", replyThreadTs);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Slack] Error for ${label}: ${errMsg}`);
    await sendMessage(
      config.botToken,
      event.channel,
      `Error: ${errMsg}`,
      event.thread_ts ?? event.ts,
    );
  }
}

// --- Slash command handler ---

async function handleSlashCommand(
  _token: string,
  command: string,
  _channelId: string,
  userId: string,
): Promise<string> {
  const config = getSettings().slack;

  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    return "Unauthorized.";
  }

  switch (command) {
    case "/reset": {
      await resetSession();
      return "Session reset. Fresh start!";
    }

    case "/compact": {
      const result = await compactCurrentSession();
      if (!result.success) {
        return `Compact failed: ${result.message}`;
      }
      return result.message || "Session compacted.";
    }

    case "/status": {
      const session = await peekSession();
      const threadSessions = await listThreadSessions();
      const lines: string[] = [];

      if (session) {
        lines.push(`*Global session*`);
        lines.push(`  ID: \`${session.sessionId.slice(0, 8)}...\``);
        lines.push(`  Turns: ${session.turnCount}`);
        lines.push(`  Last used: ${new Date(session.lastUsedAt).toLocaleString()}`);
      } else {
        lines.push("No active global session.");
      }

      const slackThreads = threadSessions.filter((ts) => ts.threadId.startsWith("slk:"));
      if (slackThreads.length > 0) {
        lines.push("");
        lines.push(`*Thread sessions* (${slackThreads.length})`);
        const shown = slackThreads.slice(0, 5);
        for (const ts of shown) {
          const parts = ts.threadId.split(":");
          const label = parts.length === 3 ? `#${parts[1]}:${parts[2]}` : ts.threadId;
          lines.push(`  ${label} — ${ts.turnCount} turns`);
        }
        if (slackThreads.length > 5) {
          lines.push(`  ... and ${slackThreads.length - 5} more`);
        }
      }

      lines.push("");
      lines.push(`Security: \`${config.allowedUserIds.length === 0 ? "open" : "restricted"}\``);

      return lines.join("\n");
    }

    default:
      return `Unknown command: ${command}`;
  }
}

// --- Socket payload handler ---

async function handleSocketPayload(
  raw: string,
  sendAck: (envelopeId: string, responsePayload?: unknown) => void,
): Promise<void> {
  let data: SlackSocketPayload;
  try {
    data = JSON.parse(raw) as SlackSocketPayload;
  } catch (err) {
    debugLog(`Failed to parse socket payload: ${err}`);
    return;
  }

  // Slack always expects an ACK within 3 seconds to prevent retry
  if (data.envelope_id) {
    // ACK immediately (before async processing) unless we return a response
    if (!data.accepts_response_payload) {
      sendAck(data.envelope_id);
    }
  }

  const type = data.type;

  if (type === "hello") {
    console.log("[Slack] Socket connected");
    return;
  }

  if (type === "disconnect") {
    debugLog(`Disconnect requested: ${data.reason ?? data.payload?.reason}`);
    ws?.close(1000, "Disconnect requested");
    return;
  }

  if (type === "events_api" && data.payload?.event) {
    const event = data.payload.event;
    if (event.type === "message" || event.type === "app_mention") {
      await handleMessage(event).catch((err) => {
        console.error(`[Slack] handleMessage error: ${err instanceof Error ? err.message : err}`);
      });
    }
    return;
  }

  if (type === "slash_commands" && data.payload) {
    const p = data.payload;
    const command = p.command ?? "";
    const channelId = p.channel_id ?? "";
    const userId = p.user_id ?? "";
    const config = getSettings().slack;

    const responseText = await handleSlashCommand(config.botToken, command, channelId, userId).catch(
      (err) => `Error: ${err instanceof Error ? err.message : String(err)}`,
    );

    // For slash commands, Slack expects the response in the ACK itself
    if (data.accepts_response_payload) {
      sendAck(data.envelope_id!, { text: responseText });
    } else {
      sendAck(data.envelope_id!);
      // Fallback: post as message
      await sendMessage(config.botToken, channelId, responseText).catch(() => {});
    }
    return;
  }

  debugLog(`Unhandled socket event type: ${type}`);
}

// --- Socket connection ---

function connectSocket(appToken: string): void {
  if (!running) return;

  debugLog("Fetching Socket Mode URL...");

  fetch(`${SLACK_API}/apps.connections.open`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  })
    .then((r) => r.json())
    .then((data: any) => {
      if (!data.ok || !data.url) {
        throw new Error(`apps.connections.open failed: ${data.error ?? "no URL returned"}`);
      }
      openSocket(data.url as string, appToken);
    })
    .catch((err) => {
      console.error(`[Slack] Failed to open socket connection: ${err instanceof Error ? err.message : err}`);
      scheduleReconnect(appToken);
    });
}

function openSocket(url: string, appToken: string): void {
  debugLog(`Opening WebSocket: ${url.slice(0, 60)}...`);

  ws = new WebSocket(url);

  ws.onopen = () => {
    debugLog("WebSocket opened");
  };

  ws.onmessage = (event) => {
    const raw = String(event.data);
    const sendAck = (envelopeId: string, payload?: unknown) => {
      if (ws?.readyState === WebSocket.OPEN) {
        const msg: Record<string, unknown> = { envelope_id: envelopeId };
        if (payload !== undefined) msg.payload = payload;
        ws.send(JSON.stringify(msg));
      }
    };
    handleSocketPayload(raw, sendAck).catch((err) => {
      console.error(`[Slack] Socket payload error: ${err instanceof Error ? err.message : err}`);
    });
  };

  ws.onclose = (event) => {
    debugLog(`WebSocket closed: code=${event.code} reason=${event.reason}`);
    ws = null;
    if (!running) return;
    console.log("[Slack] Connection closed, reconnecting...");
    scheduleReconnect(appToken);
  };

  ws.onerror = () => {
    // onclose fires after onerror, handled there
  };

  // Slack Socket Mode connections rotate every ~30 minutes.
  // We reconnect proactively at ~29 minutes to avoid forced disconnects.
  const RECONNECT_MS = 29 * 60 * 1000;
  setTimeout(() => {
    if (!running) return;
    debugLog("Proactive reconnect (30-min rotation)");
    ws?.close(1000, "Proactive reconnect");
  }, RECONNECT_MS);

}

function scheduleReconnect(appToken: string): void {
  if (!running) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = 3000 + Math.random() * 4000;
  reconnectTimer = setTimeout(() => {
    if (running) connectSocket(appToken);
  }, delay);
}

// --- Exports ---

export { sendMessage };

export async function sendMessageToUser(
  token: string,
  userId: string,
  text: string,
): Promise<void> {
  const data = await slackApi<{ channel: { id: string } }>(token, "conversations.open", {
    users: userId,
  });
  await sendMessage(token, data.channel.id, text);
}

export function stopSlack(): void {
  running = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close(1000, "Stop requested");
    } catch {
      // best-effort
    }
    ws = null;
  }
}

export function startSlack(debug = false): void {
  slackDebug = debug;
  const config = getSettings().slack;

  if (ws) stopSlack();
  running = true;

  console.log("Slack bot started (Socket Mode)");
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
  if (config.listenChannels.length > 0) {
    console.log(`  Listen channels: ${config.listenChannels.join(", ")}`);
  }
  if (slackDebug) console.log("  Debug: enabled");

  (async () => {
    await ensureProjectClaudeMd();

    // Resolve bot identity
    try {
      const authData = await slackApi<{ user_id: string; user: string }>(
        config.botToken,
        "auth.test",
        {},
      );
      botUserId = authData.user_id;
      botUsername = authData.user;
      console.log(`  Bot: @${botUsername} (${botUserId})`);
    } catch (err) {
      console.error(`[Slack] auth.test failed: ${err instanceof Error ? err.message : err}`);
    }

    connectSocket(config.appToken);
  })().catch((err) => {
    console.error(`[Slack] Fatal: ${err}`);
  });
}

process.on("SIGTERM", () => stopSlack());
process.on("SIGINT", () => stopSlack());

/** Standalone entry point (bun run src/index.ts slack) */
export async function slack(): Promise<void> {
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().slack;

  if (!config.botToken) {
    console.error("Slack bot token not configured. Set slack.botToken in .claude/claudeclaw/settings.json");
    process.exit(1);
  }
  if (!config.appToken) {
    console.error("Slack app token not configured. Set slack.appToken in .claude/claudeclaw/settings.json");
    process.exit(1);
  }

  console.log("Slack bot started (Socket Mode, standalone)");

  try {
    const authData = await slackApi<{ user_id: string; user: string }>(config.botToken, "auth.test", {});
    botUserId = authData.user_id;
    botUsername = authData.user;
    console.log(`  Bot: @${botUsername} (${botUserId})`);
  } catch (err) {
    console.error(`[Slack] auth.test failed: ${err instanceof Error ? err.message : err}`);
  }

  connectSocket(config.appToken);
  // Keep process alive
  await new Promise(() => {});
}
