import { ensureProjectClaudeMd, run, runUserMessage, compactCurrentSession } from "../runner";
import { getSettings, loadSettings } from "../config";
import { resetSession, peekSession } from "../sessions";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { transcribeAudioToText } from "../whisper";
import { resolveSkillPrompt } from "../skills";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";

// --- Discord API constants ---

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

// Intents bitfield
const INTENTS =
  (1 << 0) |   // GUILDS
  (1 << 9) |   // GUILD_MESSAGES
  (1 << 10) |  // GUILD_MESSAGE_REACTIONS
  (1 << 12) |  // DIRECT_MESSAGES
  (1 << 15);   // MESSAGE_CONTENT (privileged)

// --- Type interfaces ---

interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  bot?: boolean;
}

interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  url: string;
  proxy_url: string;
  size: number;
  flags?: number;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  attachments: DiscordAttachment[];
  mentions: DiscordUser[];
  referenced_message?: DiscordMessage | null;
  flags?: number;
  type: number;
}

interface DiscordInteraction {
  id: string;
  type: number; // 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT
  data?: {
    name?: string;
    custom_id?: string;
  };
  channel_id?: string;
  guild_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  token: string;
  message?: DiscordMessage;
}

interface DiscordGuild {
  id: string;
  name: string;
  system_channel_id?: string | null;
  joined_at?: string;
}

interface GatewayPayload {
  op: number;
  d: any;
  s: number | null;
  t: string | null;
}

// --- Gateway state ---

let ws: WebSocket | null = null;
let heartbeatIntervalMs = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatJitterTimer: ReturnType<typeof setTimeout> | null = null;
let lastSequence: number | null = null;
let gatewaySessionId: string | null = null;
let resumeGatewayUrl: string | null = null;
let heartbeatAcked = true;
let running = true;
let discordDebug = false;

// Bot identity (populated from READY)
let botUserId: string | null = null;
let botUsername: string | null = null;
let applicationId: string | null = null;

// Track guilds we were already in before this session to avoid duplicate welcome messages
let readyGuildIds: Set<string> | null = null;

// --- Debug ---

function debugLog(message: string): void {
  if (!discordDebug) return;
  console.log(`[Discord][debug] ${message}`);
}

// --- REST API helper ---

async function discordApi<T>(
  token: string,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${DISCORD_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Rate limit handling
  if (res.status === 429) {
    const data = (await res.json()) as { retry_after: number };
    const retryMs = Math.ceil(data.retry_after * 1000);
    debugLog(`Rate limited on ${method} ${endpoint}, retrying in ${retryMs}ms`);
    await Bun.sleep(retryMs);
    return discordApi(token, method, endpoint, body);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API ${method} ${endpoint}: ${res.status} ${res.statusText} ${text}`);
  }

  // 204 No Content (reactions, etc.)
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// --- Message sending ---

async function sendMessage(
  token: string,
  channelId: string,
  text: string,
  components?: unknown[],
): Promise<void> {
  const normalized = text.replace(/\[react:[^\]\r\n]+\]/gi, "").trim();
  if (!normalized) return;
  const MAX_LEN = 2000;
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    const chunk = normalized.slice(i, i + MAX_LEN);
    const body: Record<string, unknown> = { content: chunk };
    // Attach components only to the last chunk
    if (components && i + MAX_LEN >= normalized.length) {
      body.components = components;
    }
    await discordApi(token, "POST", `/channels/${channelId}/messages`, body);
  }
}

async function sendMessageToUser(
  token: string,
  userId: string,
  text: string,
): Promise<void> {
  // Discord requires creating a DM channel before sending
  const channel = await discordApi<{ id: string }>(
    token,
    "POST",
    "/users/@me/channels",
    { recipient_id: userId },
  );
  await sendMessage(token, channel.id, text);
}

async function sendTyping(token: string, channelId: string): Promise<void> {
  await discordApi(token, "POST", `/channels/${channelId}/typing`).catch(() => {});
}

async function sendReaction(
  token: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  const encoded = encodeURIComponent(emoji);
  await fetch(
    `${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
    {
      method: "PUT",
      headers: { Authorization: `Bot ${token}` },
    },
  ).catch(() => {});
}

// --- Reaction directive extraction (same as telegram.ts) ---

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

// --- Guild trigger logic ---

function guildTriggerReason(message: DiscordMessage): string | null {
  // Reply to bot
  if (botUserId && message.referenced_message?.author?.id === botUserId) return "reply_to_bot";

  // Mention via mentions array
  if (botUserId && message.mentions.some((m) => m.id === botUserId)) return "mention";

  // Mention in content (fallback)
  if (botUserId && message.content.includes(`<@${botUserId}>`)) return "mention_in_content";

  // Listen channel (respond to all messages, no mention needed)
  const config = getSettings().discord;
  if (config.listenChannels.includes(message.channel_id)) return "listen_channel";

  return null;
}

// --- Attachment handling ---

function isImageAttachment(a: DiscordAttachment): boolean {
  return Boolean(a.content_type?.startsWith("image/"));
}

function isVoiceAttachment(a: DiscordAttachment): boolean {
  // IS_VOICE_MESSAGE flag
  if ((a.flags ?? 0) & (1 << 13)) return true;
  return Boolean(a.content_type?.startsWith("audio/"));
}

async function downloadDiscordAttachment(
  attachment: DiscordAttachment,
  type: "image" | "voice",
): Promise<string | null> {
  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "discord");
  await mkdir(dir, { recursive: true });

  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`Discord attachment download failed: ${response.status}`);

  const ext = extname(attachment.filename) || (type === "voice" ? ".ogg" : ".jpg");
  const filename = `${attachment.id}-${Date.now()}${ext}`;
  const localPath = join(dir, filename);

  const bytes = new Uint8Array(await response.arrayBuffer());
  await Bun.write(localPath, bytes);
  debugLog(`Attachment downloaded: ${localPath} (${bytes.length} bytes)`);
  return localPath;
}

// --- Slash command registration ---

async function registerSlashCommands(token: string): Promise<void> {
  if (!applicationId) return;

  const commands = [
    {
      name: "start",
      description: "Show welcome message and usage instructions",
      type: 1,
    },
    {
      name: "reset",
      description: "Reset the global session for a fresh start",
      type: 1,
    },
    {
      name: "compact",
      description: "Compact session to reduce context size",
      type: 1,
    },
    {
      name: "status",
      description: "Show current session status",
      type: 1,
    },
    {
      name: "context",
      description: "Show context window usage",
      type: 1,
    },
  ];

  await discordApi(
    token,
    "PUT",
    `/applications/${applicationId}/commands`,
    commands,
  );
  debugLog("Slash commands registered");
}

// --- Interaction response helper ---

async function respondToInteraction(
  interaction: DiscordInteraction,
  data: { content: string; flags?: number; components?: unknown[] },
): Promise<void> {
  await fetch(
    `${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
        data,
      }),
    },
  );
}

// --- Message handler ---

async function handleMessageCreate(token: string, message: DiscordMessage): Promise<void> {
  const config = getSettings().discord;

  // Ignore bot messages
  if (message.author.bot) return;

  const userId = message.author.id;
  const channelId = message.channel_id;
  const isDM = !message.guild_id;
  const isGuild = !!message.guild_id;
  const content = message.content;

  // Guild trigger check
  const triggerReason = isGuild ? guildTriggerReason(message) : "direct_message";
  if (isGuild && !triggerReason) {
    debugLog(`Skip guild message channel=${channelId} from=${userId} reason=no_trigger`);
    return;
  }
  debugLog(
    `Handle message channel=${channelId} from=${userId} reason=${triggerReason} text="${content.slice(0, 80)}"`,
  );

  // Authorization check
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    if (isDM) {
      await sendMessage(config.token, channelId, "Unauthorized.");
    } else {
      debugLog(`Skip guild message channel=${channelId} from=${userId} reason=unauthorized_user`);
    }
    return;
  }

  // Detect attachments
  const imageAttachments = message.attachments.filter(isImageAttachment);
  const voiceAttachments = message.attachments.filter(isVoiceAttachment);
  const hasImage = imageAttachments.length > 0;
  const hasVoice = voiceAttachments.length > 0;

  if (!content.trim() && !hasImage && !hasVoice) return;

  // Strip bot mention from content for cleaner prompt
  let cleanContent = content;
  if (botUserId) {
    cleanContent = cleanContent.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
  }

  const label = message.author.username;
  const mediaParts = [hasImage ? "image" : "", hasVoice ? "voice" : ""].filter(Boolean);
  const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join("+")}]` : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Discord ${label}${mediaSuffix}: "${cleanContent.slice(0, 60)}${cleanContent.length > 60 ? "..." : ""}"`,
  );

  // Typing indicator loop (Discord typing lasts 10s, fire every 8s)
  const typingInterval = setInterval(() => sendTyping(config.token, channelId), 8000);

  try {
    await sendTyping(config.token, channelId);

    let imagePath: string | null = null;
    let voicePath: string | null = null;
    let voiceTranscript: string | null = null;

    if (hasImage) {
      try {
        imagePath = await downloadDiscordAttachment(imageAttachments[0], "image");
      } catch (err) {
        console.error(`[Discord] Failed to download image for ${label}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (hasVoice) {
      try {
        voicePath = await downloadDiscordAttachment(voiceAttachments[0], "voice");
      } catch (err) {
        console.error(`[Discord] Failed to download voice for ${label}: ${err instanceof Error ? err.message : err}`);
      }

      if (voicePath) {
        try {
          debugLog(`Voice file saved: path=${voicePath}`);
          voiceTranscript = await transcribeAudioToText(voicePath, {
            debug: discordDebug,
            log: (msg) => debugLog(msg),
          });
        } catch (err) {
          console.error(`[Discord] Failed to transcribe voice for ${label}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Skill routing: detect slash commands and resolve to SKILL.md prompts
    const command = cleanContent.startsWith("/") ? cleanContent.trim().split(/\s+/, 1)[0].toLowerCase() : null;
    let skillContext: string | null = null;
    if (command) {
      try {
        skillContext = await resolveSkillPrompt(command);
        if (skillContext) {
          debugLog(`Skill resolved for ${command}: ${skillContext.length} chars`);
        }
      } catch (err) {
        debugLog(`Skill resolution failed for ${command}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Build prompt (same pattern as Telegram)
    const promptParts = [`[Discord from ${label}]`];
    if (skillContext) {
      const args = cleanContent.trim().slice(command!.length).trim();
      promptParts.push(`<command-name>${command}</command-name>`);
      promptParts.push(skillContext);
      if (args) promptParts.push(`User arguments: ${args}`);
    } else if (cleanContent.trim()) {
      promptParts.push(`Message: ${cleanContent}`);
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
      promptParts.push(
        "The user attached voice audio, but it could not be transcribed. Respond and ask them to resend a clearer clip.",
      );
    }

    const prefixedPrompt = promptParts.join("\n");
    const result = await runUserMessage("discord", prefixedPrompt);

    if (result.exitCode !== 0) {
      await sendMessage(config.token, channelId, `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`);
    } else {
      const { cleanedText, reactionEmoji } = extractReactionDirective(result.stdout || "");
      if (reactionEmoji) {
        await sendReaction(config.token, channelId, message.id, reactionEmoji).catch((err) => {
          console.error(`[Discord] Failed to send reaction for ${label}: ${err instanceof Error ? err.message : err}`);
        });
      }
      await sendMessage(config.token, channelId, cleanedText || "(empty response)");
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Discord] Error for ${label}: ${errMsg}`);
    await sendMessage(config.token, channelId, `Error: ${errMsg}`);
  } finally {
    clearInterval(typingInterval);
  }
}

// --- Interaction handler (slash commands + secretary buttons) ---

async function handleInteractionCreate(token: string, interaction: DiscordInteraction): Promise<void> {
  const config = getSettings().discord;
  const actorId = interaction.member?.user?.id ?? interaction.user?.id;

  if (config.allowedUserIds.length > 0 && (!actorId || !config.allowedUserIds.includes(actorId))) {
    await respondToInteraction(interaction, { content: "Unauthorized.", flags: 64 });
    return;
  }

  // Slash commands (type 2)
  if (interaction.type === 2 && interaction.data?.name) {
    if (interaction.data.name === "start") {
      await respondToInteraction(interaction, {
        content: "Hello! Send me a message and I'll respond using Claude.\nUse `/reset` to start a fresh session.",
      });
      return;
    }

    if (interaction.data.name === "reset") {
      await resetSession();
      await respondToInteraction(interaction, {
        content: "Global session reset. Next message starts fresh.",
      });
      return;
    }

    if (interaction.data.name === "compact") {
      await respondToInteraction(interaction, { content: "⏳ Compacting session..." });
      const result = await compactCurrentSession();
      await fetch(
        `${DISCORD_API}/webhooks/${applicationId}/${interaction.token}/messages/@original`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: result.message }),
        },
      );
      return;
    }

    if (interaction.data.name === "status") {
      const session = await peekSession();
      const settings = getSettings();
      if (!session) {
        await respondToInteraction(interaction, { content: "📊 No active session." });
        return;
      }
      const lines = [
        "📊 **Session Status**",
        `Session: \`${session.sessionId.slice(0, 8)}\``,
        `Turns: ${(session as any).turnCount ?? 0}`,
        `Model: ${settings.model || "default"}`,
        `Security: ${settings.security.level}`,
        `Created: ${session.createdAt}`,
        `Last used: ${session.lastUsedAt}`,
        `Compact warned: ${(session as any).compactWarned ? "yes" : "no"}`,
      ];
      await respondToInteraction(interaction, { content: lines.join("\n") });
      return;
    }

    if (interaction.data.name === "context") {
      const session = await peekSession();
      if (!session) {
        await respondToInteraction(interaction, { content: "No active session." });
        return;
      }
      const home = homedir();
      const projectSlug = process.cwd().replace(/\//g, "-");
      const jsonlPath = `${home}/.claude/projects/${projectSlug}/${session.sessionId}.jsonl`;
      if (!existsSync(jsonlPath)) {
        await respondToInteraction(interaction, { content: "Conversation file not found." });
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
          await respondToInteraction(interaction, { content: "No usage data found." });
          return;
        }
        const input = lastUsage.input_tokens ?? 0;
        const cacheCreation = lastUsage.cache_creation_input_tokens ?? 0;
        const cacheRead = lastUsage.cache_read_input_tokens ?? 0;
        const totalContext = input + cacheCreation + cacheRead;
        const maxContext = 200000;
        const pct = ((totalContext / maxContext) * 100).toFixed(1);
        const filled = Math.round((Math.min(totalContext / maxContext, 1)) * 20);
        const bar = "█".repeat(filled) + "░".repeat(20 - filled);
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
          `Turns: ${(session as any).turnCount ?? 0}`,
        ];
        await respondToInteraction(interaction, { content: msg.join("\n") });
      } catch (err) {
        await respondToInteraction(interaction, {
          content: `Failed to read context: ${err instanceof Error ? err.message : err}`,
        });
      }
      return;
    }

    // Unknown command
    await respondToInteraction(interaction, { content: "Unknown command." });
    return;
  }

  // Button interactions (type 3) — secretary workflow
  if (interaction.type === 3 && interaction.data?.custom_id) {
    const customId = interaction.data.custom_id;

    // Secretary pattern: "sec_yes_<8hex>" or "sec_no_<8hex>"
    const secMatch = customId.match(/^sec_(yes|no)_([0-9a-f]{8})$/);
    if (secMatch) {
      const action = secMatch[1];
      const pendingId = secMatch[2];
      let responseText = "Server error";

      try {
        const resp = await fetch(`http://127.0.0.1:9999/confirm/${pendingId}/${action}`);
        const result = (await resp.json()) as { ok: boolean };
        responseText =
          action === "yes" && result.ok
            ? "Sent!"
            : result.ok
              ? "Dismissed"
              : "Not found";
      } catch {
        // server not running
      }

      await respondToInteraction(interaction, {
        content: responseText,
        flags: 64, // EPHEMERAL
      });
      return;
    }

    // Default button ack
    await respondToInteraction(interaction, { content: "OK", flags: 64 });
    return;
  }

  // Default ack for any other interaction type
  await respondToInteraction(interaction, { content: "OK", flags: 64 });
}

// --- Guild join handler ---

async function handleGuildCreate(token: string, guild: DiscordGuild): Promise<void> {
  const config = getSettings().discord;

  // Skip guilds we were already in at READY time
  if (readyGuildIds?.has(guild.id)) return;

  const channelId = guild.system_channel_id;
  if (!channelId) return;

  console.log(`[Discord] Joined guild: ${guild.name} (${guild.id})`);

  const eventPrompt =
    `[Discord system event] I was added to a guild.\n` +
    `Guild name: ${guild.name}\n` +
    `Guild id: ${guild.id}\n` +
    "Write a short first message for the server. Confirm I was added and explain how to trigger me (mention or reply).";

  try {
    const result = await run("discord", eventPrompt);
    if (result.exitCode !== 0) {
      await sendMessage(config.token, channelId, "I was added to this server. Mention me to start.");
      return;
    }
    await sendMessage(config.token, channelId, result.stdout || "I was added to this server.");
  } catch {
    await sendMessage(config.token, channelId, "I was added to this server. Mention me to start.");
  }
}

// --- Gateway WebSocket ---

function sendWs(data: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendHeartbeat(): void {
  sendWs({ op: GatewayOp.HEARTBEAT, d: lastSequence });
  heartbeatAcked = false;
}

function startHeartbeat(): void {
  stopHeartbeat();
  // First heartbeat with jitter per Discord spec
  heartbeatJitterTimer = setTimeout(() => {
    heartbeatJitterTimer = null;
    sendHeartbeat();
  }, Math.random() * heartbeatIntervalMs);
  heartbeatTimer = setInterval(() => {
    if (!heartbeatAcked) {
      debugLog("Heartbeat not acked, reconnecting");
      ws?.close(4000, "Heartbeat timeout");
      return;
    }
    sendHeartbeat();
  }, heartbeatIntervalMs);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (heartbeatJitterTimer) clearTimeout(heartbeatJitterTimer);
  heartbeatJitterTimer = null;
}

function resetGatewayState(): void {
  heartbeatIntervalMs = 0;
  heartbeatAcked = true;
  lastSequence = null;
  gatewaySessionId = null;
  resumeGatewayUrl = null;
  readyGuildIds = null;
  botUserId = null;
  botUsername = null;
  applicationId = null;
}

function sendIdentify(token: string): void {
  sendWs({
    op: GatewayOp.IDENTIFY,
    d: {
      token,
      intents: INTENTS,
      properties: {
        os: process.platform,
        browser: "claudeclaw",
        device: "claudeclaw",
      },
    },
  });
}

function sendResume(token: string): void {
  sendWs({
    op: GatewayOp.RESUME,
    d: {
      token,
      session_id: gatewaySessionId,
      seq: lastSequence,
    },
  });
}

// Non-recoverable close codes that should not trigger reconnection
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

function handleDispatch(token: string, eventName: string, data: any): void {
  debugLog(`Dispatch: ${eventName}`);

  switch (eventName) {
    case "READY":
      gatewaySessionId = data.session_id;
      resumeGatewayUrl = data.resume_gateway_url;
      botUserId = data.user.id;
      botUsername = data.user.username;
      applicationId = data.application.id;
      // Track existing guilds so we don't send welcome messages on reconnect
      readyGuildIds = new Set((data.guilds ?? []).map((g: { id: string }) => g.id));
      console.log(`[Discord] Ready as ${data.user.username} (${data.user.id})`);
      registerSlashCommands(token).catch((err) =>
        console.error(`[Discord] Failed to register slash commands: ${err}`),
      );
      break;

    case "RESUMED":
      debugLog("Session resumed successfully");
      break;

    case "MESSAGE_CREATE":
      handleMessageCreate(token, data).catch((err) =>
        console.error(`[Discord] MESSAGE_CREATE unhandled: ${err}`),
      );
      break;

    case "INTERACTION_CREATE":
      handleInteractionCreate(token, data).catch((err) =>
        console.error(`[Discord] INTERACTION_CREATE unhandled: ${err}`),
      );
      break;

    case "GUILD_CREATE":
      handleGuildCreate(token, data).catch((err) =>
        console.error(`[Discord] GUILD_CREATE unhandled: ${err}`),
      );
      break;
  }
}

function handleGatewayPayload(token: string, payload: GatewayPayload): void {
  if (payload.s !== null) lastSequence = payload.s;

  switch (payload.op) {
    case GatewayOp.HELLO:
      heartbeatIntervalMs = payload.d.heartbeat_interval;
      startHeartbeat();
      if (gatewaySessionId && lastSequence !== null) {
        sendResume(token);
      } else {
        sendIdentify(token);
      }
      break;

    case GatewayOp.HEARTBEAT_ACK:
      heartbeatAcked = true;
      break;

    case GatewayOp.HEARTBEAT:
      // Server-requested heartbeat
      sendHeartbeat();
      break;

    case GatewayOp.RECONNECT:
      debugLog("Gateway requested reconnect");
      ws?.close(4000, "Reconnect requested");
      break;

    case GatewayOp.INVALID_SESSION: {
      const resumable = payload.d;
      debugLog(`Invalid session, resumable=${resumable}`);
      if (!resumable) {
        gatewaySessionId = null;
        lastSequence = null;
      }
      setTimeout(() => {
        if (resumable && gatewaySessionId) {
          sendResume(token);
        } else {
          sendIdentify(token);
        }
      }, 1000 + Math.random() * 4000);
      break;
    }

    case GatewayOp.DISPATCH:
      handleDispatch(token, payload.t!, payload.d);
      break;
  }
}

function connectGateway(token: string, url?: string): void {
  const gatewayUrl = url || GATEWAY_URL;
  debugLog(`Connecting to gateway: ${gatewayUrl}`);

  ws = new WebSocket(gatewayUrl);

  ws.onopen = () => {
    debugLog("Gateway WebSocket opened");
  };

  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as GatewayPayload;
      handleGatewayPayload(token, payload);
    } catch (err) {
      console.error(`[Discord] Failed to parse gateway payload: ${err}`);
    }
  };

  ws.onclose = (event) => {
    debugLog(`Gateway closed: code=${event.code} reason=${event.reason}`);
    stopHeartbeat();
    if (!running) return;

    // Fatal close codes — do not reconnect
    if (FATAL_CLOSE_CODES.has(event.code)) {
      console.error(`[Discord] Fatal close code ${event.code}: ${event.reason}. Not reconnecting.`);
      return;
    }

    // Attempt resume if we have session state
    const canResume = gatewaySessionId && lastSequence !== null;
    if (canResume) {
      debugLog("Attempting resume...");
      setTimeout(() => connectGateway(token, resumeGatewayUrl || undefined), 1000 + Math.random() * 2000);
    } else {
      // Full reconnect
      gatewaySessionId = null;
      lastSequence = null;
      resumeGatewayUrl = null;
      setTimeout(() => connectGateway(token), 3000 + Math.random() * 4000);
    }
  };

  ws.onerror = () => {
    // onclose will fire after onerror, reconnection handled there
  };
}

// --- Exports ---

/** Send a message to a specific channel (used by heartbeat forwarding) */
export { sendMessage, sendMessageToUser };

/** Stop gateway connection and clear runtime state (used for token rotation/hot reload). */
export function stopGateway(): void {
  running = false;
  stopHeartbeat();
  if (ws) {
    try {
      ws.close(1000, "Gateway stop requested");
    } catch {
      // best-effort
    }
    ws = null;
  }
  resetGatewayState();
}

process.on("SIGTERM", () => {
  stopGateway();
});
process.on("SIGINT", () => {
  stopGateway();
});

/** Start gateway connection in-process (called by start.ts when token is configured) */
export function startGateway(debug = false): void {
  discordDebug = debug;
  const config = getSettings().discord;
  if (ws) stopGateway();
  running = true;
  console.log("Discord bot started (gateway)");
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
  if (config.listenChannels.length > 0) {
    console.log(`  Listen channels: ${config.listenChannels.join(", ")}`);
  }
  if (discordDebug) console.log("  Debug: enabled");

  (async () => {
    await ensureProjectClaudeMd();
    connectGateway(config.token);
  })().catch((err) => {
    console.error(`[Discord] Fatal: ${err}`);
  });
}

/** Standalone entry point (bun run src/index.ts discord) */
export async function discord() {
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().discord;

  if (!config.token) {
    console.error("Discord token not configured. Set discord.token in .claude/claudeclaw/settings.json");
    process.exit(1);
  }

  console.log("Discord bot started (gateway, standalone)");
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
  if (discordDebug) console.log("  Debug: enabled");

  connectGateway(config.token);
  // Keep process alive
  await new Promise(() => {});
}
