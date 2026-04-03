import {
  isNormalizedEvent,
  isValidChannel,
  normalizeTelegramMessage,
  normalizeDiscordMessage,
  normalizeCronEvent,
  normalizeWebhookEvent,
  Channel,
  NormalizedEvent,
} from "../../gateway/normalizer";

// --- Type guard tests ---

const validNormalizedEvent: NormalizedEvent = {
  id: "local-123",
  channel: "telegram",
  sourceEventId: "456",
  channelId: "telegram:123",
  threadId: "default",
  userId: "789",
  text: "Hello world",
  attachments: [],
  timestamp: 1700000000000,
  metadata: {},
};

describe("isValidChannel", () => {
  test("accepts valid channels", () => {
    expect(isValidChannel("telegram")).toBe(true);
    expect(isValidChannel("discord")).toBe(true);
    expect(isValidChannel("cron")).toBe(true);
    expect(isValidChannel("webhook")).toBe(true);
  });

  test("rejects invalid channels", () => {
    expect(isValidChannel("slack")).toBe(false);
    expect(isValidChannel("email")).toBe(false);
    expect(isValidChannel("")).toBe(false);
    expect(isValidChannel("TELEGRAM")).toBe(false);
    expect(isValidChannel(123 as any)).toBe(false);
    expect(isValidChannel(null)).toBe(false);
    expect(isValidChannel(undefined)).toBe(false);
  });
});

describe("isNormalizedEvent", () => {
  test("accepts valid normalized event", () => {
    expect(isNormalizedEvent(validNormalizedEvent)).toBe(true);
  });

  test("accepts minimal valid event", () => {
    const minimal: NormalizedEvent = {
      id: "abc",
      channel: "cron",
      channelId: "cron:system",
      threadId: "default",
      userId: "system",
      text: "",
      attachments: [],
      timestamp: 1700000000000,
      metadata: {},
    };
    expect(isNormalizedEvent(minimal)).toBe(true);
  });

  test("rejects null/undefined", () => {
    expect(isNormalizedEvent(null)).toBe(false);
    expect(isNormalizedEvent(undefined)).toBe(false);
  });

  test("rejects non-object", () => {
    expect(isNormalizedEvent("string")).toBe(false);
    expect(isNormalizedEvent(123)).toBe(false);
    expect(isNormalizedEvent(true)).toBe(false);
  });

  test("rejects missing required fields", () => {
    const missingId = { ...validNormalizedEvent, id: undefined };
    expect(isNormalizedEvent(missingId as any)).toBe(false);

    const missingChannel = { ...validNormalizedEvent, channel: "invalid" };
    expect(isNormalizedEvent(missingChannel as any)).toBe(false);

    const missingText = { ...validNormalizedEvent, text: 123 as any };
    expect(isNormalizedEvent(missingText as any)).toBe(false);
  });

  test("rejects invalid attachments", () => {
    const badAttachments = { ...validNormalizedEvent, attachments: ["not an array"] };
    expect(isNormalizedEvent(badAttachments as any)).toBe(false);

    const badAttachmentItem = { ...validNormalizedEvent, attachments: [{ type: "video" }] };
    expect(isNormalizedEvent(badAttachmentItem as any)).toBe(false);
  });

  test("rejects invalid metadata", () => {
    const arrayMetadata = { ...validNormalizedEvent, metadata: [] };
    expect(isNormalizedEvent(arrayMetadata as any)).toBe(false);

    const stringMetadata = { ...validNormalizedEvent, metadata: "bad" };
    expect(isNormalizedEvent(stringMetadata as any)).toBe(false);
  });

  test("rejects invalid timestamp", () => {
    const badTimestamp = { ...validNormalizedEvent, timestamp: "not a number" };
    expect(isNormalizedEvent(badTimestamp as any)).toBe(false);
  });
});

// --- Telegram normalization tests ---

describe("normalizeTelegramMessage", () => {
  test("normalizes basic text message", () => {
    const input: any = {
      message_id: 123,
      from: { id: 456, first_name: "Alice", username: "alice" },
      chat: { id: 789, type: "private" },
      text: "Hello bot!",
    };

    const result = normalizeTelegramMessage(input);

    expect(result.channel).toBe("telegram");
    expect(result.sourceEventId).toBe("123");
    expect(result.channelId).toBe("telegram:789");
    expect(result.threadId).toBe("default");
    expect(result.userId).toBe("456");
    expect(result.text).toBe("Hello bot!");
    expect(result.attachments).toEqual([]);
  });

  test("normalizes caption-only message", () => {
    const input: any = {
      message_id: 456,
      from: { id: 111, first_name: "Bob" },
      chat: { id: 222, type: "group" },
      caption: "Look at this!",
    };

    const result = normalizeTelegramMessage(input);

    expect(result.text).toBe("Look at this!");
    expect(result.sourceEventId).toBe("456");
  });

  test("normalizes photo attachment", () => {
    const input: any = {
      message_id: 789,
      from: { id: 333, first_name: "Carol" },
      chat: { id: 444, type: "private" },
      text: "Check this photo",
      photo: [
        { file_id: "small_photo", width: 100, height: 100 },
        { file_id: "big_photo", width: 1920, height: 1080, file_size: 1500000 },
        { file_id: "medium_photo", width: 800, height: 600 },
      ],
    };

    const result = normalizeTelegramMessage(input);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].type).toBe("image");
    expect(result.attachments[0].metadata).toEqual({
      file_id: "big_photo",
      width: 1920,
      height: 1080,
    });
  });

  test("normalizes voice attachment", () => {
    const input: any = {
      message_id: 101,
      from: { id: 222, first_name: "Dave" },
      chat: { id: 333, type: "private" },
      voice: {
        file_id: "voice_file_123",
        mime_type: "audio/ogg",
        duration: 45,
        file_size: 50000,
      },
    };

    const result = normalizeTelegramMessage(input);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].type).toBe("voice");
    expect(result.attachments[0].mimeType).toBe("audio/ogg");
    expect(result.attachments[0].metadata).toEqual({
      file_id: "voice_file_123",
      duration: 45,
    });
  });

  test("normalizes document attachment", () => {
    const input: any = {
      message_id: 202,
      from: { id: 444, first_name: "Eve" },
      chat: { id: 555, type: "private" },
      text: "Here's the PDF",
      document: {
        file_id: "doc_file_456",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 250000,
      },
    };

    const result = normalizeTelegramMessage(input);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].type).toBe("document");
    expect(result.attachments[0].filename).toBe("report.pdf");
    expect(result.attachments[0].mimeType).toBe("application/pdf");
  });

  test("preserves reply metadata", () => {
    const input: any = {
      message_id: 303,
      from: { id: 666, first_name: "Frank" },
      chat: { id: 777, type: "group" },
      text: "Reply to you!",
      reply_to_message: {
        message_id: 302,
        from: { id: 555, first_name: "Eve" },
      },
    };

    const result = normalizeTelegramMessage(input);

    expect(result.metadata.replyTo).toBe("302");
  });

  test("normalizes thread/topic message", () => {
    const input: any = {
      message_id: 404,
      from: { id: 888, first_name: "Grace" },
      chat: { id: 999, type: "supergroup" },
      message_thread_id: 42,
      text: "Thread reply",
    };

    const result = normalizeTelegramMessage(input);

    expect(result.threadId).toBe("42");
  });

  test("extracts bot command from entities", () => {
    const input: any = {
      message_id: 505,
      from: { id: 111, first_name: "Henry" },
      chat: { id: 222, type: "private" },
      text: "/start hello",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    };

    const result = normalizeTelegramMessage(input);

    expect(result.metadata.command).toBe("/start");
  });

  test("handles message without from field", () => {
    const input: any = {
      message_id: 606,
      chat: { id: 333, type: "group" },
      text: "Anonymous message",
    };

    const result = normalizeTelegramMessage(input);

    expect(result.userId).toBe("unknown");
  });

  test("handles message without text or caption", () => {
    const input: any = {
      message_id: 707,
      from: { id: 444, first_name: "Ivy" },
      chat: { id: 555, type: "private" },
    };

    const result = normalizeTelegramMessage(input);

    expect(result.text).toBe("");
  });
});

// --- Discord normalization tests ---

describe("normalizeDiscordMessage", () => {
  test("normalizes basic guild message", () => {
    const input: any = {
      id: "discord_msg_123",
      channel_id: "channel_456",
      guild_id: "guild_789",
      author: { id: "user_111", username: "alice", discriminator: "0001" },
      content: "Hello from Discord!",
      attachments: [],
      mentions: [],
      type: 0,
    };

    const result = normalizeDiscordMessage(input);

    expect(result.channel).toBe("discord");
    expect(result.sourceEventId).toBe("discord_msg_123");
    expect(result.channelId).toBe("discord:guild:guild_789:channel_456");
    expect(result.threadId).toBe("channel_456");
    expect(result.userId).toBe("user_111");
    expect(result.text).toBe("Hello from Discord!");
    expect(result.attachments).toEqual([]);
  });

  test("normalizes DM message", () => {
    const input: any = {
      id: "dm_msg_999",
      channel_id: "dm_channel_888",
      author: { id: "user_222", username: "bob", discriminator: "0001" },
      content: "Direct message",
      attachments: [],
      mentions: [],
      type: 1, // 1 = DM
    };

    const result = normalizeDiscordMessage(input);

    expect(result.channelId).toBe("discord:dm:dm_channel_888");
  });

  test("normalizes image attachment", () => {
    const input: any = {
      id: "img_msg_111",
      channel_id: "ch_222",
      guild_id: "guild_333",
      author: { id: "user_444", username: "carol", discriminator: "0001" },
      content: "Check this image",
      attachments: [
        {
          id: "att_555",
          filename: "photo.png",
          content_type: "image/png",
          url: "https://cdn.discordapp.com/attachments/photo.png",
          proxy_url: "https://media.discordapp.net/photo.png",
          size: 120000,
        },
      ],
      mentions: [],
      type: 0,
    };

    const result = normalizeDiscordMessage(input);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].type).toBe("image");
    expect(result.attachments[0].url).toBe("https://cdn.discordapp.com/attachments/photo.png");
    expect(result.attachments[0].filename).toBe("photo.png");
  });

  test("normalizes voice attachment", () => {
    const input: any = {
      id: "voice_msg_777",
      channel_id: "ch_888",
      guild_id: "guild_999",
      author: { id: "user_aaa", username: "dave", discriminator: "0001" },
      content: "",
      attachments: [
        {
          id: "voice_att",
          filename: "voice_message.ogg",
          content_type: "audio/ogg",
          url: "https://cdn.discordapp.com/attachments/voice.ogg",
          proxy_url: "https://media.discordapp.net/voice.ogg",
          size: 80000,
          flags: 8192, // VOICE_MESSAGE flag
        },
      ],
      mentions: [],
      type: 0,
    };

    const result = normalizeDiscordMessage(input);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].type).toBe("voice");
  });

  test("preserves reply/reference metadata", () => {
    const input: any = {
      id: "reply_msg_222",
      channel_id: "ch_333",
      guild_id: "guild_444",
      author: { id: "user_555", username: "eve", discriminator: "0001" },
      content: "Replying to you!",
      attachments: [],
      mentions: [],
      referenced_message: {
        id: "original_msg_111",
        author: { id: "user_666", username: "frank", discriminator: "0001" },
        content: "Original message",
      },
      type: 19, // REPLY type
    };

    const result = normalizeDiscordMessage(input);

    expect(result.metadata.replyTo).toBe("original_msg_111");
  });

  test("extracts slash command", () => {
    const input: any = {
      id: "cmd_msg_333",
      channel_id: "ch_444",
      author: { id: "user_777", username: "grace", discriminator: "0001" },
      content: "/status check this",
      attachments: [],
      mentions: [],
      type: 0,
    };

    const result = normalizeDiscordMessage(input);

    expect(result.metadata.command).toBe("status");
  });

  test("trims content whitespace", () => {
    const input: any = {
      id: "trim_msg_444",
      channel_id: "ch_555",
      author: { id: "user_888", username: "henry", discriminator: "0001" },
      content: "   \n  Hello world  \n  ",
      attachments: [],
      mentions: [],
      type: 0,
    };

    const result = normalizeDiscordMessage(input);

    expect(result.text).toBe("Hello world");
  });
});

// --- Cron normalization tests ---

describe("normalizeCronEvent", () => {
  test("normalizes cron event without payload", () => {
    const input: CronEvent = {};

    const result = normalizeCronEvent(input);

    expect(result.channel).toBe("cron");
    expect(result.channelId).toBe("cron:system");
    expect(result.threadId).toBe("default");
    expect(result.userId).toBe("system");
    expect(result.text).toBe("");
    expect(result.attachments).toEqual([]);
    expect(result.timestamp).toBeGreaterThan(0);
  });

  test("normalizes cron event with payload", () => {
    const input: CronEvent = {
      timestamp: 1700000000000,
      payload: { job_id: "nightly_backup", status: "success" },
    };

    const result = normalizeCronEvent(input);

    expect(result.timestamp).toBe(1700000000000);
    expect(result.metadata.payload).toEqual({ job_id: "nightly_backup", status: "success" });
  });

  test("uses provided timestamp over Date.now()", () => {
    const knownTimestamp = 1609459200000; // 2021-01-01
    const input: CronEvent = { timestamp: knownTimestamp };

    const result = normalizeCronEvent(input);

    expect(result.timestamp).toBe(knownTimestamp);
  });
});

// --- Webhook normalization tests ---

describe("normalizeWebhookEvent", () => {
  test("normalizes webhook with headers and body", () => {
    const input: WebhookEvent = {
      headers: {
        "content-type": "application/json",
        "x-custom": "value123",
      },
      body: { action: "create", item: "widget" },
      path: "/api/webhooks/myhook",
      timestamp: 1700000000000,
    };

    const result = normalizeWebhookEvent(input);

    expect(result.channel).toBe("webhook");
    expect(result.channelId).toBe("webhook:receiver");
    expect(result.userId).toBe("system");
    expect(result.metadata.headers).toEqual({
      "content-type": "application/json",
      "x-custom": "value123",
    });
    expect(result.metadata.body).toEqual({ action: "create", item: "widget" });
    expect(result.metadata.path).toBe("/api/webhooks/myhook");
  });

  test("strips sensitive headers", () => {
    const input: WebhookEvent = {
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret_token_abc123",
        "x-api-key": "sk_live_xyz789",
        cookie: "session=abc123; token=def456",
        "x-auth": "auth_token_456",
      },
      body: { data: "test" },
    };

    const result = normalizeWebhookEvent(input);

    // Only non-sensitive headers should remain
    expect(result.metadata.headers).toEqual({
      "content-type": "application/json",
    });
    // Sensitive ones should be stripped
    expect(result.metadata.headers).not.toHaveProperty("authorization");
    expect(result.metadata.headers).not.toHaveProperty("x-api-key");
    expect(result.metadata.headers).not.toHaveProperty("cookie");
    expect(result.metadata.headers).not.toHaveProperty("x-auth");
  });

  test("handles webhook without headers", () => {
    const input: WebhookEvent = {
      body: { ping: true },
    };

    const result = normalizeWebhookEvent(input);

    expect(result.metadata.body).toEqual({ ping: true });
    expect(result.metadata.headers).toBeUndefined();
  });

  test("handles webhook without body", () => {
    const input: WebhookEvent = {
      headers: { "user-agent": "GitHub-Hookshot" },
    };

    const result = normalizeWebhookEvent(input);

    expect(result.metadata.headers).toEqual({ "user-agent": "GitHub-Hookshot" });
    expect(result.metadata.body).toBeUndefined();
  });

  test("handles webhook without optional fields", () => {
    const input: WebhookEvent = {};

    const result = normalizeWebhookEvent(input);

    expect(result.channel).toBe("webhook");
    expect(result.metadata).toEqual({});
  });
});

// --- Edge cases ---

describe("unicode handling", () => {
  test("handles unicode text in Telegram", () => {
    const input: any = {
      message_id: 999,
      from: { id: 111, first_name: "UnicodeUser" },
      chat: { id: 222, type: "private" },
      text: "Hello! 👋🎉 Привет! こんにちは！",
    };

    const result = normalizeTelegramMessage(input);

    expect(result.text).toBe("Hello! 👋🎉 Привет! こんにちは！");
  });

  test("handles unicode text in Discord", () => {
    const input: any = {
      id: "unicode_msg_888",
      channel_id: "ch_999",
      author: { id: "user_000", username: "unicodedave", discriminator: "0001" },
      content: "Unicode: 🎯 🔥 ✨ مرحبا שלום",
      attachments: [],
      mentions: [],
      type: 0,
    };

    const result = normalizeDiscordMessage(input);

    expect(result.text).toBe("Unicode: 🎯 🔥 ✨ مرحبا שלום");
  });
});

describe("large metadata payloads", () => {
  test("handles large metadata in Telegram", () => {
    const largeEntities = Array.from({ length: 100 }, (_, i) => ({
      type: "mention",
      offset: i * 10,
      length: 5,
    }));

    const input: any = {
      message_id: 111,
      from: { id: 222, first_name: "LargeMeta" },
      chat: { id: 333, type: "private" },
      text: "Test message with lots of entities",
      entities: largeEntities,
    };

    const result = normalizeTelegramMessage(input);

    expect(result.metadata.entities).toHaveLength(100);
  });

  test("handles large payload in Cron", () => {
    const largePayload = {
      items: Array.from({ length: 1000 }, (_, i) => ({ id: i, data: `item_${i}` })),
    };

    const input: CronEvent = { payload: largePayload };

    const result = normalizeCronEvent(input);

    expect((result.metadata.payload as any).items).toHaveLength(1000);
  });

  test("handles large body in Webhook", () => {
    const largeBody = {
      records: Array.from({ length: 500 }, (_, i) => ({
        id: `rec_${i}`,
        values: Array.from({ length: 50 }, (_, j) => j * i),
      })),
    };

    const input: WebhookEvent = { body: largeBody };

    const result = normalizeWebhookEvent(input);

    expect((result.metadata.body as any).records).toHaveLength(500);
  });
});

describe("empty content", () => {
  test("handles empty Telegram message with attachments only", () => {
    const input: any = {
      message_id: 222,
      from: { id: 333, first_name: "PhotoOnly" },
      chat: { id: 444, type: "private" },
      photo: [{ file_id: "photo_abc", width: 1920, height: 1080 }],
    };

    const result = normalizeTelegramMessage(input);

    expect(result.text).toBe("");
    expect(result.attachments).toHaveLength(1);
  });

  test("handles Discord message with only attachments", () => {
    const input: any = {
      id: "att_only_msg",
      channel_id: "ch_555",
      author: { id: "user_666", username: "附件", discriminator: "0001" },
      content: "",
      attachments: [
        {
          id: "att_777",
          filename: "file.pdf",
          content_type: "application/pdf",
          url: "https://example.com/file.pdf",
          proxy_url: "https://example.com/file.pdf",
          size: 50000,
        },
      ],
      mentions: [],
      type: 0,
    };

    const result = normalizeDiscordMessage(input);

    expect(result.text).toBe("");
    expect(result.attachments).toHaveLength(1);
  });
});

describe("missing optional fields", () => {
  test("handles Telegram message without optional fields", () => {
    const input: any = {
      message_id: 333,
      chat: { id: 444, type: "private" },
    };

    const result = normalizeTelegramMessage(input);

    expect(result.sourceEventId).toBe("333");
    expect(result.userId).toBe("unknown");
    expect(result.threadId).toBe("default");
    expect(result.metadata).toEqual({});
  });

  test("handles Discord message without guild_id", () => {
    const input: any = {
      id: "no_guild_msg",
      channel_id: "dm_123",
      author: { id: "user_456", username: "lonely", discriminator: "0001" },
      content: "Just me",
      attachments: [],
      mentions: [],
      type: 1,
    };

    const result = normalizeDiscordMessage(input);

    expect(result.channelId).toBe("discord:dm:dm_123");
  });
});
