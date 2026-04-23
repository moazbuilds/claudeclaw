/**
 * Gateway Normalizer — transforms platform-specific events into a unified schema.
 *
 * Design principles:
 * - `id` is always local (assigned by event log, not by normalizer)
 * - `sourceEventId` captures the upstream message/event ID when available
 * - No `seq` field — sequence numbers belong to the event log, not normalization
 * - Normalization preserves provenance needed for dedupe and replay
 * - Adapters only need to normalize and submit events
 *
 * Supported channels: telegram, discord, cron, webhook
 */

// --- Core types ---

export type Channel = "telegram" | "discord" | "cron" | "webhook";

export interface Attachment {
  type: "image" | "voice" | "document";
  url?: string;
  localPath?: string;
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
}

export interface NormalizedEvent {
  id: string; // local event UUID (assigned by event log, not here)
  channel: Channel;
  sourceEventId?: string; // upstream message/event ID if available
  channelId: string;
  threadId: string;
  userId: string;
  text: string;
  attachments: Attachment[];
  timestamp: number; // source timestamp if available, else now
  metadata: {
    replyTo?: string;
    command?: string;
    entities?: unknown[];
    rawType?: string | number;
    [key: string]: unknown;
  };
}

// --- Source platform types (minimal, for normalization only) ---

// Telegram types (from telegram.ts)
export interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name: string; username?: string };
  reply_to_message?: { message_id?: number; from?: { id: number } };
  chat: { id: number; type: string };
  message_thread_id?: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  mime_type?: string;
  duration?: number;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  mime_type?: string;
  duration?: number;
  file_name?: string;
  file_size?: number;
}

export interface TelegramEntity {
  type: "mention" | "bot_command" | string;
  offset: number;
  length: number;
}

// Discord types (from discord.ts)
export interface DiscordMessage {
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

export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  bot?: boolean;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  url: string;
  proxy_url: string;
  size: number;
  flags?: number;
}

// Cron/Webhook types
export interface CronEvent {
  timestamp?: number;
  payload?: Record<string, unknown>;
}

export interface WebhookEvent {
  headers?: Record<string, string>;
  body?: unknown;
  path?: string;
  timestamp?: number;
}

// --- Type guards ---

/**
 * Check if a value is a valid Channel string
 */
export function isValidChannel(value: unknown): value is Channel {
  return typeof value === "string" && ["telegram", "discord", "cron", "webhook"].includes(value);
}

/**
 * Check if an object conforms to the NormalizedEvent schema
 */
export function isNormalizedEvent(obj: unknown): obj is NormalizedEvent {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;

  // Check required primitive fields
  if (typeof o.id !== "string") return false;
  if (!isValidChannel(o.channel)) return false;
  if (typeof o.channelId !== "string") return false;
  if (typeof o.threadId !== "string") return false;
  if (typeof o.userId !== "string") return false;
  if (typeof o.text !== "string") return false;
  if (typeof o.timestamp !== "number") return false;

  // Check optional sourceEventId
  if (o.sourceEventId !== undefined && typeof o.sourceEventId !== "string") return false;

  // Check attachments is an array
  if (!Array.isArray(o.attachments)) return false;
  for (const att of o.attachments) {
    if (!isAttachment(att)) return false;
  }

  // Check metadata is a plain object
  if (!o.metadata || typeof o.metadata !== "object" || Array.isArray(o.metadata)) return false;

  return true;
}

function isAttachment(obj: unknown): obj is Attachment {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (!["image", "voice", "document"].includes(o.type as string)) return false;
  return true;
}

// --- Telegram normalizer ---

/**
 * Normalize a Telegram message into the unified schema.
 * Preserves source provenance (message_id, chat.id, user.id) for dedupe/replay.
 */
export function normalizeTelegramMessage(message: TelegramMessage): NormalizedEvent {
  // Extract text from either text or caption field
  const text = message.text ?? message.caption ?? "";

  // Build attachments from photo, voice, audio, document
  const attachments: Attachment[] = [];

  // Photo attachments
  if (message.photo && message.photo.length > 0) {
    // Pick largest photo (best quality)
    const largest = [...message.photo].sort((a, b) => {
      const sizeA = a.file_size ?? a.width * a.height;
      const sizeB = b.file_size ?? b.width * b.height;
      return sizeB - sizeA;
    })[0];
    attachments.push({
      type: "image",
      url: undefined, // URL requires file_id → getFile → download (deferred to fetcher)
      filename: undefined,
      sizeBytes: largest.file_size,
      metadata: { file_id: largest.file_id, width: largest.width, height: largest.height },
    });
  }

  // Voice/audio attachments
  if (message.voice) {
    attachments.push({
      type: "voice",
      mimeType: message.voice.mime_type,
      sizeBytes: message.voice.file_size,
      metadata: { file_id: message.voice.file_id, duration: message.voice.duration },
    });
  }

  if (message.audio) {
    attachments.push({
      type: "voice", // audio files treated as voice (speech/audio content)
      mimeType: message.audio.mime_type,
      filename: message.audio.file_name,
      sizeBytes: message.audio.file_size,
      metadata: { file_id: message.audio.file_id, duration: message.audio.duration },
    });
  }

  // Document attachments (images via document are handled separately)
  if (message.document) {
    const isImage = message.document.mime_type?.startsWith("image/");
    const isAudio = message.document.mime_type?.startsWith("audio/");
    let attachmentType: "image" | "voice" | "document" = "document";
    if (isImage) {
      attachmentType = "image";
    } else if (isAudio) {
      attachmentType = "voice";
    }
    attachments.push({
      type: attachmentType,
      mimeType: message.document.mime_type,
      filename: message.document.file_name,
      sizeBytes: message.document.file_size,
      metadata: { file_id: message.document.file_id },
    });
  }

  // Build metadata
  const metadata: NormalizedEvent["metadata"] = {};

  // Reply metadata
  if (message.reply_to_message?.message_id) {
    metadata.replyTo = String(message.reply_to_message.message_id);
  }

  // Entity metadata (mentions, bot commands, etc.)
  const entities = message.entities ?? message.caption_entities;
  if (entities && entities.length > 0) {
    metadata.entities = entities;

    // Extract bot command if present
    const cmd = entities.find((e) => e.type === "bot_command");
    if (cmd) {
      const rawCmd = text.slice(cmd.offset, cmd.offset + cmd.length);
      metadata.command = rawCmd.split("@")[0].toLowerCase(); // strip @botname
    }
  }

  // Raw type preservation (e.g., "message", "edited_message", "channel_post")
  if (message.entities) {
    metadata.rawType = "message";
  } else if (message.caption_entities) {
    metadata.rawType = "caption";
  }

  return {
    id: "", // assigned by event log
    channel: "telegram",
    sourceEventId: message.message_id ? String(message.message_id) : undefined,
    channelId: `telegram:${message.chat.id}`,
    threadId: message.message_thread_id ? String(message.message_thread_id) : "default",
    userId: message.from?.id ? String(message.from.id) : "unknown",
    text,
    attachments,
    timestamp: Date.now(), // Telegram doesn't provide source timestamp, use arrival time
    metadata,
  };
}

// --- Discord normalizer ---

/**
 * Normalize a Discord message into the unified schema.
 * Preserves source provenance (id, channel_id, author.id) for dedupe/replay.
 */
export function normalizeDiscordMessage(message: DiscordMessage): NormalizedEvent {
  // Trim content
  const text = message.content.trim();

  // Build attachments
  const attachments: Attachment[] = message.attachments.map((att) => {
    const isImage = att.content_type?.startsWith("image/");
    const isVoice =
      (att.flags ?? 0) & (1 << 13) || att.content_type?.startsWith("audio/");

    let attachmentType: "image" | "voice" | "document" = "document";
    if (isImage) {
      attachmentType = "image";
    } else if (isVoice) {
      attachmentType = "voice";
    }
    return {
      type: attachmentType,
      url: att.url,
      filename: att.filename,
      sizeBytes: att.size,
      mimeType: att.content_type,
      metadata: { id: att.id, proxy_url: att.proxy_url },
    };
  });

  // Build metadata
  const metadata: NormalizedEvent["metadata"] = {};

  // Reply/reference metadata
  if (message.referenced_message) {
    metadata.replyTo = message.referenced_message.id;
  }

  // Channel and thread context
  // Discord exposes guild_id and channel_id separately
  // threadId: Discord uses parent channel_id + optional thread id in message
  // We preserve the full channel context by including guild_id in channelId
  const channelId = message.guild_id
    ? `discord:guild:${message.guild_id}:${message.channel_id}`
    : `discord:dm:${message.channel_id}`;

  // Discord message type (e.g., 0=DEFAULT, 19=REPLY, 20=CHANNEL_PINNED_MESSAGE)
  metadata.rawType = message.type;

  // Detect bot command from content (slash commands start with /)
  const trimmed = text.trimStart();
  if (trimmed.startsWith("/")) {
    const cmdPart = trimmed.slice(1).split(/\s+/)[0];
    if (cmdPart) metadata.command = cmdPart.toLowerCase();
  }

  // Mention entities for reference
  if (message.mentions && message.mentions.length > 0) {
    metadata.entities = message.mentions.map((m) => ({ id: m.id, username: m.username }));
  }

  return {
    id: "", // assigned by event log
    channel: "discord",
    sourceEventId: message.id,
    channelId,
    threadId: message.channel_id, // Discord thread id embedded in channel_id if needed
    userId: message.author.id,
    text,
    attachments,
    timestamp: Date.now(), // Discord doesn't provide source timestamp in message create
    metadata,
  };
}

// --- Cron normalizer ---

/**
 * Normalize a Cron event into the unified schema.
 * Uses "system" as a stable synthetic userId.
 */
export function normalizeCronEvent(event: CronEvent): NormalizedEvent {
  const metadata: NormalizedEvent["metadata"] = {};

  // Preserve payload data
  if (event.payload) {
    metadata.payload = event.payload;
  }

  return {
    id: "", // assigned by event log
    channel: "cron",
    channelId: "cron:system",
    threadId: "default",
    userId: "system", // stable synthetic actor
    text: "",
    attachments: [],
    timestamp: event.timestamp ?? Date.now(),
    metadata,
  };
}

// --- Webhook normalizer ---

/**
 * Normalize a Webhook event into the unified schema.
 * Preserves headers, body, and path for inspection/replay.
 * Uses "system" as a stable synthetic userId.
 */
export function normalizeWebhookEvent(event: WebhookEvent): NormalizedEvent {
  const metadata: NormalizedEvent["metadata"] = {};

  // Preserve headers (sans sensitive values)
  if (event.headers) {
    const safeHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(event.headers)) {
      const lower = k.toLowerCase();
      // Strip potentially sensitive headers
      if (!["authorization", "cookie", "x-api-key", "x-auth"].includes(lower)) {
        safeHeaders[k] = v;
      }
    }
    metadata.headers = safeHeaders;
  }

  // Preserve body
  if (event.body !== undefined) {
    metadata.body = event.body;
  }

  // Preserve path
  if (event.path) {
    metadata.path = event.path;
  }

  return {
    id: "", // assigned by event log
    channel: "webhook",
    channelId: "webhook:receiver",
    threadId: "default",
    userId: "system", // stable synthetic actor
    text: "", // webhook events may not have text content
    attachments: [],
    timestamp: event.timestamp ?? Date.now(),
    metadata,
  };
}
