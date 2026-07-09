import { ensureProjectClaudeMd, run, runOnce, runUserMessage, compactCurrentSession, CLAUDE_CMD } from "../runner";
import { getSettings, loadSettings } from "../config";
import { resetSession, peekSession } from "../sessions";
import { listThreadSessions, removeThreadSession, peekThreadSession } from "../sessionManager";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { transcribeAudioToText } from "../whisper";
import { resolveSkillPrompt } from "../skills";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { classifyEmoji, recordResponse, recordReaction } from "../training";

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
  // Discord populates `thread` on a message when the message has a thread
  // started off it. We use this on `referenced_message` to detect replies
  // that should be routed into an existing thread instead of spawning a
  // duplicate one in the parent channel.
  thread?: { id: string; parent_id?: string } | null;
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

// --- Gateway watchdog ---
// The heartbeat-ack check (above) only fires on its scheduled interval. If
// the OS sleeps the process or the WebSocket goes silent in a way that
// doesn't trip onclose/onerror, the heartbeat timer can stop firing
// entirely — leaving the daemon in an "open but dead" gateway state for
// hours. The watchdog independently tracks the wall-clock time since the
// last received gateway frame and forces a reconnect if the gap exceeds
// 2× heartbeat interval (floor 90s). Updated on every onmessage.
let lastGatewayActivityAt = Date.now();
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

// Bot identity (populated from READY)
let botUserId: string | null = null;
let botUsername: string | null = null;
let applicationId: string | null = null;

// Track guilds we were already in before this session to avoid duplicate welcome messages
let readyGuildIds: Set<string> | null = null;

// Track known thread channel IDs and their parent channel IDs for multi-session support
const knownThreads = new Map<string, { parentId: string }>();

// Threads we've successfully PUT ourselves into as a member. Thread MEMBERSHIP
// is what makes the gateway deliver MESSAGE_CREATE for a thread in real time —
// threads we merely track in knownThreads (catchup discovery, message-time
// recovery) but never joined only ever reach us via the 90s catchup sweep,
// which is why factory-created threads felt sluggish (observed 2026-07-09:
// every message in unjoined threads arrived via "Catchup: re-delivering",
// while rejoinThreads-joined session threads got instant [GW] MESSAGE_CREATE).
// Membership persists server-side, so this set only saves redundant PUTs
// within one process lifetime.
const joinedThreads = new Set<string>();

async function joinThreadIfNeeded(token: string, threadId: string): Promise<void> {
  if (joinedThreads.has(threadId)) return;
  try {
    await discordApi(token, "PUT", `/channels/${threadId}/thread-members/@me`);
    joinedThreads.add(threadId);
    debugLog(`Joined thread ${threadId} for real-time gateway delivery`);
  } catch (err) {
    // Archived threads 4xx here — they auto-unarchive on the next message and
    // the catchup sweep still covers them, so this is best-effort by design.
    debugLog(`Thread join failed for ${threadId}: ${err}`);
  }
}

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
  // Hard timeout so a hung Discord request can't stall callers (notably the
  // catchup sweep — a single slow GET would otherwise block the whole pass).
  const ctrl = new AbortController();
  const tHandle = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${DISCORD_API}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tHandle);
  }

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
): Promise<string | null> {
  const normalized = text
    .replace(/\[react:[^\]\r\n]+\]/gi, "")
    .replace(/\[image:[^\]\r\n]+\]/gi, "")
    .trim();
  if (!normalized) return null;
  const MAX_LEN = 2000;
  let lastId: string | null = null;
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    const chunk = normalized.slice(i, i + MAX_LEN);
    const body: Record<string, unknown> = { content: chunk };
    // Attach components only to the last chunk
    if (components && i + MAX_LEN >= normalized.length) {
      body.components = components;
    }
    const sent = await discordApi<{ id?: string }>(token, "POST", `/channels/${channelId}/messages`, body);
    if (sent && typeof sent.id === "string") lastId = sent.id;
  }
  return lastId;
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

// Upload one or more files to a channel via multipart/form-data.
// Discord rejects application/json bodies for file uploads, so this is a
// parallel send path to sendMessage() — use it whenever there are attachments.
async function sendMessageWithFiles(
  token: string,
  channelId: string,
  text: string,
  filePaths: string[],
): Promise<string | null> {
  const normalized = text
    .replace(/\[react:[^\]\r\n]+\]/gi, "")
    .replace(/\[image:[^\]\r\n]+\]/gi, "")
    .trim();

  const form = new FormData();
  const attachmentsMeta: Array<{ id: number; filename: string }> = [];
  let idx = 0;
  for (const raw of filePaths) {
    const filePath = raw.startsWith("~")
      ? join(homedir(), raw.slice(1).replace(/^[\\/]/, ""))
      : raw;
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      console.error(`[Discord] sendMessageWithFiles: file not found: ${filePath}`);
      continue;
    }
    const filename = filePath.split(/[\\/]/).pop() ?? `file-${idx}`;
    form.append(`files[${idx}]`, file, filename);
    attachmentsMeta.push({ id: idx, filename });
    idx++;
  }

  if (attachmentsMeta.length === 0) {
    // Nothing actually attached — fall back to a plain text send so the user
    // still gets *something* instead of a silent drop.
    return sendMessage(token, channelId, normalized || "(image attachment failed)");
  }

  const payload: Record<string, unknown> = { attachments: attachmentsMeta };
  if (normalized) payload.content = normalized.slice(0, 2000);
  form.append("payload_json", JSON.stringify(payload));

  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Discord upload failed: ${res.status} ${res.statusText} ${errText}`);
  }
  const sent = (await res.json()) as { id?: string };
  return sent.id ?? null;
}

// --- Reaction directive extraction (same as telegram.ts) ---

export function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
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

// Pull out [image:/path/to/file.png] directives so the bot can upload them
// alongside the reply text. Same shape as the [react:] convention.
function extractImageDirectives(text: string): { cleanedText: string; imagePaths: string[] } {
  const imagePaths: string[] = [];
  const cleanedText = text
    .replace(/\[image:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (candidate) imagePaths.push(candidate);
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, imagePaths };
}

// --- Thread history fetcher ---
// When claudeclaw starts a fresh Claude session in a thread that already
// has Discord messages (recovered thread, lost session, or first reply
// after the bot was offline), the agent walks in blind. Pull the recent
// thread messages AND the thread's starter message from the parent
// channel, then format them as a history block to prepend to the first
// prompt so context isn't lost.
export type HistoryMsg = {
  id: string;
  author: { id?: string; username: string; bot?: boolean };
  content: string;
  timestamp?: string;
  attachments?: Array<{ filename: string }>;
};

// Hard caps on seeded thread history. Keeps a single thread-resume from
// dumping a huge transcript into a fresh Claude session's context window.
// Defaults sized for ~5k tokens of seed context.
export const THREAD_HISTORY_DEFAULT_MAX_MESSAGES = 20;
export const THREAD_HISTORY_DEFAULT_MAX_CHARS = 20_000;

/**
 * Pure formatter for the thread-history seed block. Exported for testing.
 * - Keeps the starter when present, plus the newest N-1 messages.
 * - Drops any item whose body is empty after trimming.
 * - Hard-caps the rendered length; over the cap, oldest non-starter lines
 *   are dropped first and a truncation marker is prepended.
 */
export function formatThreadHistory(
  starter: HistoryMsg | null,
  messagesOldestFirst: HistoryMsg[],
  opts: { maxMessages?: number; maxChars?: number } = {},
): string | null {
  const maxMessages = opts.maxMessages ?? THREAD_HISTORY_DEFAULT_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? THREAD_HISTORY_DEFAULT_MAX_CHARS;

  let ordered: HistoryMsg[] = [];
  if (starter) ordered.push(starter);
  ordered.push(...messagesOldestFirst);

  if (ordered.length > maxMessages) {
    ordered = starter
      ? [starter, ...ordered.slice(1).slice(-(maxMessages - 1))]
      : ordered.slice(-maxMessages);
  }

  const lines: string[] = [];
  for (const m of ordered) {
    const speaker = m.author.bot ? "claudeclaw" : m.author.username;
    const ts = m.timestamp ? m.timestamp.slice(0, 19).replace("T", " ") : "";
    let body = (m.content || "").trim();
    if (m.attachments?.length) {
      const files = m.attachments.map((a) => a.filename).join(", ");
      body = body ? `${body} [attachments: ${files}]` : `[attachments: ${files}]`;
    }
    if (!body) continue;
    const marker = starter && m.id === starter.id ? " [thread starter]" : "";
    lines.push(`${speaker} (${ts})${marker}: ${body}`);
  }
  if (lines.length === 0) return null;

  const header = "[Discord thread history — prior turns in this thread, included because no resumable Claude session was found. Starter message is the original parent-channel message the thread was created from.]";
  const footer = "[End of thread history]";
  let working = [...lines];

  const render = () => [header, ...working, footer].join("\n");

  while (working.length > 1 && render().length > maxChars) {
    // Drop the second line (oldest non-starter); starter (if present) is at index 0.
    const dropIdx = starter && working.length > 0 && working[0]?.includes("[thread starter]") ? 1 : 0;
    working.splice(dropIdx, 1);
  }

  let result = render();
  if (result.length > maxChars) {
    const truncMarker = "[... thread history truncated to stay under context cap ...]\n";
    result = truncMarker + result.slice(-(maxChars - truncMarker.length));
  }
  return result;
}

async function fetchThreadHistoryContext(
  token: string,
  threadId: string,
  parentId: string,
  beforeMessageId: string,
  limit = THREAD_HISTORY_DEFAULT_MAX_MESSAGES,
): Promise<string | null> {
  // Threads created off a parent channel message (auto-thread flow + the
  // "hire X" intent) have thread.id === starterMessage.id, and the starter
  // lives in the PARENT channel, not the thread's messages endpoint.
  // Fetching it from the thread directly returns 404. Standalone threads
  // (POST /channels/{id}/threads with no starter) also 404 here — that's
  // fine, debugLog and move on.
  let starter: HistoryMsg | null = null;
  try {
    starter = await discordApi<HistoryMsg>(token, "GET", `/channels/${parentId}/messages/${threadId}`);
  } catch (err) {
    debugLog(`Thread starter fetch skipped for ${threadId}: ${err}`);
  }

  let messages: HistoryMsg[] = [];
  try {
    messages = await discordApi<HistoryMsg[]>(
      token,
      "GET",
      `/channels/${threadId}/messages?limit=${limit}&before=${beforeMessageId}`,
    );
  } catch (err) {
    debugLog(`Thread history fetch failed for ${threadId}: ${err}`);
  }

  // Discord returns newest first — reverse to chronological.
  return formatThreadHistory(starter, [...messages].reverse());
}

// --- Thread rejoin helper ---
// Populates `knownThreads` from sessions.json on startup/resume so the bot
// recognizes every thread it has ever had a conversation in — even archived
// ones it can no longer join. The PUT join is best-effort: Discord rejects
// thread-member PUTs on archived threads, but the bot still receives
// MESSAGE_CREATE for them (auto-unarchive on first reply). Decoupling the two
// ensures a failed join never causes us to forget a thread.
async function rejoinThreads(token: string): Promise<void> {
  const threadSessions = await listThreadSessions();
  let tracked = 0;
  let joined = 0;
  for (const ts of threadSessions) {
    if (!knownThreads.has(ts.threadId)) {
      try {
        const ch = await discordApi<{ parent_id?: string }>(token, "GET", `/channels/${ts.threadId}`);
        if (ch.parent_id) {
          knownThreads.set(ts.threadId, { parentId: ch.parent_id });
          tracked++;
        }
      } catch (err) {
        debugLog(`Failed to fetch parent for thread ${ts.threadId}: ${err}`);
      }
    }
    try {
      await discordApi(token, "PUT", `/channels/${ts.threadId}/thread-members/@me`);
      joinedThreads.add(ts.threadId);
      joined++;
    } catch (err) {
      // Archived threads return 4xx here — expected, not an error.
      debugLog(`Thread join skipped for ${ts.threadId} (likely archived): ${err}`);
    }
  }
  if (threadSessions.length > 0) {
    console.log(`[Discord] Threads from sessions.json: ${threadSessions.length} known, ${tracked} newly tracked, ${joined} joined`);
  }
}

// --- Thread catchup ---
// Gateway events get dropped occasionally — daemon offline windows, silent
// WebSocket pauses, missed THREAD_CREATE deliveries. The watchdog fixes
// gateway death but can't replay events Discord already discarded. So we
// poll: every CATCHUP_INTERVAL_MS we scan known thread sessions, look at
// the newest message via REST, and re-deliver any user message that the
// bot hasn't replied to yet. This makes followup messages eventually
// reliable across every thread regardless of which channel the parent is
// in.
const CATCHUP_INTERVAL_MS = 90 * 1000; // 90s — short enough that gateway drops feel real-time
const CATCHUP_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h — don't auto-reply to stale messages the user has moved on from
const CATCHUP_STARTUP_DELAY_MS = 15 * 1000;
const CATCHUP_FETCH_TIMEOUT_MS = 15 * 1000; // per-request cap so one slow thread can't stall the whole sweep
let catchupTimer: ReturnType<typeof setInterval> | null = null;
let catchupStartupTimer: ReturnType<typeof setTimeout> | null = null;
// Dedicated liveness ping: writes health.txt every 60s independent of catchup.
// A long Claude session inside catchupThreads can block the sweep for many
// minutes, leaving the sweep-start/sweep-end writes stale long enough that
// restart.sh thinks the daemon is frozen and bounces it (5+ false-positive
// bounces observed since 2026-05-26). This timer keeps health.txt fresh
// whenever the event loop is alive, which is the real liveness signal —
// "catchup is currently running a Claude session" is a healthy state, not a
// frozen one. If the event loop genuinely dies, the ping stops too. Named
// `livenessTimer` to avoid clashing with `heartbeatTimer` (Discord gateway
// websocket ping) declared near the top of the file.
let livenessTimer: ReturnType<typeof setInterval> | null = null;
const inFlightThreads = new Set<string>();
const recentlyProcessedMessageIds = new Set<string>();

// Single-flight guard: if a sweep is still running when the timer fires
// again, skip — accumulating parallel sweeps just makes things worse.
let catchupSweeping = false;

// REST message objects don't include guild_id — it's a gateway-only field.
// handleMessageCreate branches guild-vs-DM on guild_id, so catchup
// re-deliveries (REST-fetched) must stamp it back on before delivery or
// they take the DM path: no thread routing, top-level channel replies,
// and a message that never looks answered (the 2026-07-08 reply loop).
// Guild membership per channel is stable, so cache it.
const channelGuildCache = new Map<string, string>();

// Incremental-sweep cursors: channel/thread id → the last_message_id we
// already made a decision about. When the bulk guild endpoints report the
// same last_message_id, the per-channel messages fetch is skipped entirely.
const sweepCursors = new Map<string, string>();

async function resolveChannelGuildId(token: string, channelId: string): Promise<string | undefined> {
  const cached = channelGuildCache.get(channelId);
  if (cached) return cached;
  try {
    const ch = await discordApi<{ guild_id?: string }>(token, "GET", `/channels/${channelId}`);
    if (ch.guild_id) {
      channelGuildCache.set(channelId, ch.guild_id);
      return ch.guild_id;
    }
  } catch (err) {
    debugLog(`Guild resolve failed for ${channelId}: ${err}`);
  }
  return undefined; // genuinely a DM channel (or lookup failed) — DM handling is correct
}

// The processed-message dedup set only lived in memory, so every daemon
// restart wiped it — that's what turned one unthreaded reply into an
// hours-long duplicate-reply loop on 2026-07-08 (crash-restarts every
// 5-9 min, each one re-delivering the same "unreplied" channel messages).
// Persist to disk so restarts don't re-deliver.
const processedIdsFile = () => join(process.cwd(), ".claude/claudeclaw/processed-messages.json");
let processedIdsLoaded = false;

async function loadProcessedIds(): Promise<void> {
  if (processedIdsLoaded) return;
  processedIdsLoaded = true;
  try {
    const ids = JSON.parse(await readFile(processedIdsFile(), "utf8"));
    if (Array.isArray(ids)) for (const id of ids) recentlyProcessedMessageIds.add(String(id));
    debugLog(`Loaded ${recentlyProcessedMessageIds.size} processed message ids from disk`);
  } catch { /* first run — start empty */ }
}

let persistProcessedTimer: ReturnType<typeof setTimeout> | null = null;
function persistProcessedIds(): void {
  if (persistProcessedTimer) return; // debounce bursts
  persistProcessedTimer = setTimeout(() => {
    persistProcessedTimer = null;
    writeFile(processedIdsFile(), JSON.stringify([...recentlyProcessedMessageIds].slice(-500)), "utf8").catch(() => {});
  }, 2000);
}

async function catchupThreads(token: string): Promise<void> {
  const me = botUserId;
  if (!me) return;
  if (catchupSweeping) {
    debugLog("Catchup sweep skipped — previous sweep still running");
    return;
  }
  catchupSweeping = true;
  const sweepStart = Date.now();
  try {
    // Liveness: write health.txt at sweep START, not just end. handleMessageCreate
    // awaits the entire Claude session run, so a long Claude job inside the
    // per-thread loop can block the sweep for many minutes. Without an early
    // write, restart.sh sees health.txt stale and force-bounces the daemon
    // mid-Claude, killing the in-flight session and starting a new daemon that
    // hits the same unreplied message — infinite cascade. The end-of-sweep
    // write below still happens with real scanned/processed counts.
    try {
      await writeFile(
        join(process.cwd(), ".claude/claudeclaw/health.txt"),
        `${new Date().toISOString()} sweep=start processed=0\n`,
        "utf8",
      );
    } catch {}
    const config = getSettings().discord;
    // Build the candidate set: union of (a) every thread we have a session
    // for, (b) every active thread under a listen channel parent. (b) is
    // critical — if the user starts a brand new thread and posts the first
    // message themselves (no bot reply yet), there's no session entry, so
    // (a) alone would never see it. Fetching active threads per listen
    // channel costs one extra REST call per channel per sweep.
    const candidateIds = new Set<string>();
    // Incremental sweep: last_message_id per channel/thread from the bulk
    // guild endpoints (1 REST call each per guild). The scan loops below
    // skip the per-channel messages fetch when nothing changed since the
    // last decision.
    const lastMsgIds = new Map<string, string>();
    // Open-mic mode: every active thread in every guild we're in is a
    // candidate, regardless of parent. Archived threads are deliberately NOT
    // candidates: an archived thread can't receive messages — posting to one
    // auto-unarchives it, which puts it back in this active list. Scanning
    // all 460+ session threads (mostly archived) every sweep is what made a
    // full sweep take ~44 minutes on 2026-07-09.
    let activesFetched = false;
    for (const guildId of readyGuildIds ?? new Set<string>()) {
      try {
        const active = await discordApi<{ threads?: Array<{ id: string; parent_id?: string; last_message_id?: string | null }> }>(
          token, "GET", `/guilds/${guildId}/threads/active`,
        );
        activesFetched = true;
        for (const t of active.threads ?? []) {
          candidateIds.add(t.id);
          if (t.parent_id) knownThreads.set(t.id, { parentId: t.parent_id });
          channelGuildCache.set(t.id, guildId);
          if (t.last_message_id) lastMsgIds.set(t.id, t.last_message_id);
          // Join any active thread we aren't a member of yet so its future
          // messages arrive via the gateway instantly instead of waiting for
          // the next sweep. Awaited serially — self-pacing against the REST
          // rate limit; the joinedThreads guard makes this a no-op for all
          // but newly-discovered threads.
          await joinThreadIfNeeded(token, t.id);
        }
      } catch (err) {
        debugLog(`Catchup: active-threads fetch failed for guild ${guildId}: ${err}`);
      }
    }
    // Fallback: gateway not ready / active lists unavailable — scan session
    // threads like the pre-1.7.7 sweep so offline recovery still works.
    if (!activesFetched) {
      for (const ts of await listThreadSessions()) candidateIds.add(ts.threadId);
    }

    // Open-mic mode: scan every text channel in every guild, not just the
    // configured listenChannels. The thread scan above catches messages
    // inside threads; this catches messages posted directly in a parent
    // channel that haven't been auto-threaded yet. The previous version
    // only scanned listenChannels, so any new channel the user created
    // (skull-style-logo, etc.) silently dropped unreplied messages.
    let scanned = 0;
    let processed = 0;
    const channelsToScan = new Set<string>(config.listenChannels);
    for (const guildId of readyGuildIds ?? new Set<string>()) {
      try {
        const chs = await discordApi<Array<{ id: string; type: number; last_message_id?: string | null }>>(
          token, "GET", `/guilds/${guildId}/channels`,
        );
        for (const c of chs) {
          if (c.type === 0 || c.type === 5) channelsToScan.add(c.id); // text + announcement
          channelGuildCache.set(c.id, guildId);
          if (c.last_message_id) lastMsgIds.set(c.id, c.last_message_id);
        }
      } catch (err) {
        debugLog(`Catchup: guild channels fetch failed for ${guildId}: ${err}`);
      }
    }
    for (const chId of channelsToScan) {
      // Incremental: nothing posted since this channel's last decision —
      // skip the messages fetch (and the pacing sleep) entirely.
      const chLastId = lastMsgIds.get(chId);
      if (chLastId && sweepCursors.get(chId) === chLastId) continue;
      try {
        const msgs = await discordApi<DiscordMessage[]>(
          token, "GET", `/channels/${chId}/messages?limit=20`,
        );
        // Commit the cursor now that we have the messages; the catch below
        // rolls it back so a failed fetch/delivery is retried next sweep.
        if (chLastId && !inFlightThreads.has(chId)) sweepCursors.set(chId, chLastId);
        for (let mi = 0; mi < msgs.length; mi++) {
          const m = msgs[mi];
          if (!m.author || m.author.bot || m.author.id === me) continue;
          if (m.type === 18 || m.type === 21) continue; // Discord system pointers
          if (m.thread?.id) continue; // already replied (bot auto-threaded)
          // Also skip if bot already replied in-channel without threading.
          // msgs is newest-first; entries at indices < mi are newer. If any
          // are from the bot, the message was answered — thread check alone
          // misses unthreaded top-level replies and triggers infinite re-delivery.
          if (msgs.slice(0, mi).some((r) => r.author?.id === me)) continue;
          if (recentlyProcessedMessageIds.has(m.id)) continue;
          if (inFlightThreads.has(chId)) continue;
          const t0 = (m as DiscordMessage & { timestamp?: string }).timestamp;
          const age = t0 ? Date.now() - new Date(t0).getTime() : Infinity;
          if (age > CATCHUP_MAX_AGE_MS) continue;
          if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(m.author.id)) continue;
          console.log(
            `[Discord] Catchup: re-delivering channel message ${m.id} in ${chId.slice(0, 8)} ` +
            `(${Math.round(age / 60000)}m old): "${(m.content || "").slice(0, 60).replace(/\n/g, " ")}"`,
          );
          // Stamp guild_id back on (REST omits it) so the handler routes this
          // as a guild message — threads the reply instead of top-level spam.
          if (!m.guild_id) m.guild_id = await resolveChannelGuildId(token, chId);
          await handleMessageCreate(token, m);
          processed++;
        }
      } catch (err) {
        sweepCursors.delete(chId); // retry this channel next sweep
        debugLog(`Catchup: channel ${chId} scan failed: ${err}`);
      }
      await Bun.sleep(150);
    }

    for (const threadId of candidateIds) {
      if (inFlightThreads.has(threadId)) continue;
      // Incremental: nothing posted since this thread's last decision.
      const thLastId = lastMsgIds.get(threadId);
      if (thLastId && sweepCursors.get(threadId) === thLastId) continue;
      try {
        const msgs = await discordApi<DiscordMessage[]>(
          token, "GET", `/channels/${threadId}/messages?limit=5`,
        );
        scanned++;
        // Commit the cursor; the catch below rolls it back so a failed
        // fetch/delivery is retried next sweep.
        if (thLastId) sweepCursors.set(threadId, thLastId);
        if (!msgs || msgs.length === 0) continue;
        const newest = msgs[0]; // Discord returns newest first
        if (!newest || newest.author?.id === me) continue; // bot replied last, nothing to do
        if (recentlyProcessedMessageIds.has(newest.id)) continue;
        const ts0 = (newest as DiscordMessage & { timestamp?: string }).timestamp;
        const age = ts0 ? Date.now() - new Date(ts0).getTime() : Infinity;
        if (age > CATCHUP_MAX_AGE_MS) continue;
        if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(newest.author.id)) continue;

        console.log(
          `[Discord] Catchup: re-delivering unreplied message ${newest.id} in thread ${threadId.slice(0, 8)} ` +
          `(${Math.round(age / 60000)}m old): "${(newest.content || "").slice(0, 60).replace(/\n/g, " ")}"`,
        );
        // Stamp guild_id back on (REST omits it) so the handler routes this
        // as a guild message rather than a DM.
        if (!newest.guild_id) newest.guild_id = await resolveChannelGuildId(token, threadId);
        // Let handleMessageCreate own recentlyProcessedMessageIds — pre-adding
        // here makes the handler think the message is already processed and exit.
        await handleMessageCreate(token, newest);
        processed++;
      } catch (err) {
        sweepCursors.delete(threadId); // retry this thread next sweep
        debugLog(`Catchup failed for ${threadId}: ${err}`);
      }
      await Bun.sleep(150); // pace REST calls
    }
    // Bound the dedup set so it doesn't grow forever
    if (recentlyProcessedMessageIds.size > 500) {
      const arr = [...recentlyProcessedMessageIds];
      recentlyProcessedMessageIds.clear();
      for (const id of arr.slice(-250)) recentlyProcessedMessageIds.add(id);
    }
    if (processed > 0) {
      console.log(`[Discord] Catchup: scanned ${scanned}, re-delivered ${processed} (took ${Date.now() - sweepStart}ms)`);
    }
    // Liveness signal for external watchers (claudeclaw-restart.sh checks this
    // on SessionStart to detect a frozen daemon and force-bounce it).
    try {
      await writeFile(
        join(process.cwd(), ".claude/claudeclaw/health.txt"),
        `${new Date().toISOString()} sweep=${scanned} processed=${processed}\n`,
        "utf8",
      );
    } catch {}
  } finally {
    catchupSweeping = false;
  }
}

function startCatchupTimer(token: string): void {
  stopCatchupTimer();
  // Restore the processed-ids dedup set from disk before the first sweep —
  // an empty set after a restart is what re-delivered already-answered
  // messages on every daemon bounce during the 2026-07-08 incident.
  loadProcessedIds().catch(() => {});
  catchupStartupTimer = setTimeout(() => {
    catchupStartupTimer = null;
    catchupThreads(token).catch((err) => console.error(`[Discord] Catchup error: ${err}`));
  }, CATCHUP_STARTUP_DELAY_MS);
  catchupTimer = setInterval(() => {
    catchupThreads(token).catch((err) => console.error(`[Discord] Catchup error: ${err}`));
  }, CATCHUP_INTERVAL_MS);
  // Dedicated liveness ping: writes every 60s independent of catchup work.
  // Catchup sweep-start/sweep-end writes go stale during long Claude sessions;
  // this one doesn't care what catchup is doing as long as the event loop is
  // alive.
  livenessTimer = setInterval(() => {
    const state = catchupSweeping ? "sweep" : "idle";
    writeFile(
      join(process.cwd(), ".claude/claudeclaw/health.txt"),
      `${new Date().toISOString()} liveness=${state}\n`,
      "utf8",
    ).catch(() => {});
  }, 60 * 1000);
}

function stopCatchupTimer(): void {
  if (catchupTimer) clearInterval(catchupTimer);
  catchupTimer = null;
  if (catchupStartupTimer) clearTimeout(catchupStartupTimer);
  catchupStartupTimer = null;
  if (livenessTimer) clearInterval(livenessTimer);
  livenessTimer = null;
}

// --- Guild trigger logic ---

function guildTriggerReason(message: DiscordMessage): string | null {
  // Open-mic mode: reply to any guild message. The downstream `allowedUserIds`
  // gate is the real defense against random users; the explicit listenChannels
  // allow-list kept producing regressions every time the user spun up a new
  // channel (skull-style-logo, etc.) without updating the config. The
  // reason-strings below are kept only for diagnostic logging.
  if (botUserId && message.referenced_message?.author?.id === botUserId) return "reply_to_bot";
  if (botUserId && message.mentions.some((m) => m.id === botUserId)) return "mention";
  if (botUserId && message.content.includes(`<@${botUserId}>`)) return "mention_in_content";
  const config = getSettings().discord;
  if (config.listenChannels.includes(message.channel_id)) return "listen_channel";
  const threadInfo = knownThreads.get(message.channel_id);
  if (threadInfo && config.listenChannels.includes(threadInfo.parentId)) return "listen_channel_thread";
  if (threadInfo) return "known_thread";
  return "open_mic";
}

// --- Attachment handling ---

// --- AI-powered thread intent classifier (uses Sonnet via Claude OAuth) ---
interface ThreadIntent {
  action: "hire" | "fire";
  names: string[];
}

async function classifyThreadIntent(text: string): Promise<ThreadIntent | null> {
  const systemPrompt = `You classify user messages into thread management intents.

If the user wants to CREATE/SPAWN/DEPLOY threads (e.g. "hire X", "派出 X", "叫 X 出來", "派 X 去打", "開 X", "建立 X"):
Return: {"action":"hire","names":["name1","name2"]}

If the user wants to DELETE/REMOVE threads (e.g. "fire X", "撤回 X", "把 X 叫回來", "刪 X", "關 X"):
Return: {"action":"fire","names":["name1","name2"]}

If the message is NOT about thread management, return: null

Rules:
- Extract individual names. "桃園三結義" = ["劉備","關羽","張飛"]. "五虎將" = ["關羽","張飛","趙雲","馬超","黃忠"].
- Common patterns: 派/派出/出征/上陣/迎戰/出戰 = hire. 撤/撤回/收回/叫回來/滾 = fire.
- Return ONLY valid JSON or the word null. No explanation.`;

  try {
    const input = `${systemPrompt}\n\n---\nUser message: ${text}`;
    const proc = Bun.spawn(
      [...CLAUDE_CMD, "-p", input, "--output-format", "text", "--model", "claude-haiku-4-5-20251001", "--dangerously-skip-permissions"],
      { stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, HOME: homedir() } as Record<string, string> },
    );
    const timeoutId = setTimeout(() => { try { proc.kill(); } catch {} }, 10000);
    // Drain stderr alongside stdout — an undrained pipe can fill and block
    // the child, which would then only exit via the kill timer.
    const [rawResult] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timeoutId);
    const result = rawResult.trim();

    if (!result || result === "null") return null;
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as ThreadIntent;
  } catch (err) {
    console.error(`[Discord] Intent classifier error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// --- Attachment handling (original) ---

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

  // Skip Discord system-generated messages. Type 18 (THREAD_STARTER_MESSAGE)
  // is a UI pointer Discord posts in the parent channel referencing a thread
  // starter — it has the original author but no real intent. Type 21
  // (THREAD_CREATED) is the "X started a thread" notification. Processing
  // either causes a duplicate, contextless reply alongside the real thread
  // conversation. Type 0 = default, type 19 = reply — both real and kept.
  if (message.type === 18 || message.type === 21) {
    debugLog(`Skip system message type=${message.type} id=${message.id}`);
    return;
  }

  // Dedup gateway echo vs catchup re-delivery for the same message ID.
  if (recentlyProcessedMessageIds.has(message.id)) return;
  recentlyProcessedMessageIds.add(message.id);
  persistProcessedIds(); // persist so a restart can't wipe the dedup set (2026-07-08 loop)

  const userId = message.author.id;
  const channelId = message.channel_id;
  // REST-fetched messages (catchup re-delivery) don't carry guild_id — it's
  // a gateway-only field. Deriving guild-ness from it alone sent every
  // re-delivered guild message down the DM path: no thread routing,
  // top-level channel replies, and a message that never looked answered —
  // the 2026-07-08 reply loop. knownThreads membership is guild evidence
  // even when guild_id is absent (catchup also stamps guild_id upstream;
  // this is the belt-and-braces for any other REST-sourced delivery path).
  const isGuild = !!message.guild_id || knownThreads.has(message.channel_id);
  const isDM = !isGuild;
  const content = message.content;

  // Recover unknown thread channels at message time. Covers every case where
  // knownThreads doesn't have the channel yet: missed THREAD_CREATE,
  // post-restart memory loss, archived threads the bot lost membership of,
  // sessions.json gaps where a Claude session was never persisted.
  //
  // Any guild thread channel (type 10/11/12) is registered unconditionally
  // here — the previous `persisted || isListenThread` gate caused recurring
  // silent drops on long-tail threads (skull.style work in non-listen-channel
  // parents that auto-archived between sessions). The `allowedUserIds` check
  // a few lines below is the real defense against random-user spam, so this
  // recovery doesn't need to second-guess intent.
  if (isGuild && !knownThreads.has(channelId)) {
    try {
      const ch = await discordApi<{ parent_id?: string; type?: number }>(
        config.token, "GET", `/channels/${channelId}`,
      );
      const isThreadChannel = ch.type === 10 || ch.type === 11 || ch.type === 12;
      if (isThreadChannel && ch.parent_id) {
        const persisted = await peekThreadSession(channelId);
        const isListenThread = config.listenChannels.includes(ch.parent_id);
        knownThreads.set(channelId, { parentId: ch.parent_id });
        await joinThreadIfNeeded(config.token, channelId);
        const source = persisted ? "session" : isListenThread ? "listen" : "thread_fallback";
        console.log(
          `[Discord] Thread recovered at message time: ${channelId} ` +
          `(parent: ${ch.parent_id}, source: ${source}, knownSize=${knownThreads.size})`,
        );
      } else {
        debugLog(
          `[Discord] Recovery skipped for ${channelId}: not a thread channel ` +
          `(type=${ch.type ?? "?"}, parent=${ch.parent_id ?? "none"})`,
        );
      }
    } catch (err) {
      console.warn(`[Discord] Thread recovery lookup failed for ${channelId}: ${err}`);
    }
  }

  // Guild trigger check
  const triggerReason = isGuild ? guildTriggerReason(message) : "direct_message";
  if (isGuild && !triggerReason) {
    const threadInfo = knownThreads.get(channelId);
    console.log(`[Discord][DIAG] SKIP channel=${channelId} guild=${message.guild_id} inKnown=${knownThreads.has(channelId)} threadInfo=${JSON.stringify(threadInfo)} knownSize=${knownThreads.size} listenCh=${JSON.stringify(config.listenChannels)} text="${content.slice(0, 40)}"`);
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
  inFlightThreads.add(channelId);

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

    // --- Thread management: AI-powered intent classification ---
    // Skip when the message is already inside a thread — thread management
    // is a parent-channel feature, and running it on every in-thread reply
    // adds latency and risks mis-classifying a normal reply as "hire X".
    const inThread = knownThreads.has(channelId);
    if (isGuild && !inThread && cleanContent.length < 200) {
      const intent = await classifyThreadIntent(cleanContent);
      if (intent && intent.action === "hire" && intent.names.length > 0) {
        const results: string[] = [];
        for (const threadName of intent.names) {
          try {
            const thread = await discordApi<{ id: string; name: string }>(
              config.token,
              "POST",
              `/channels/${channelId}/threads`,
              {
                name: threadName,
                type: 11, // PUBLIC_THREAD
                auto_archive_duration: 4320, // 3 days
              },
            );
            knownThreads.set(thread.id, { parentId: channelId });
            // Don't pre-create session — let Claude CLI create it on first message
            // The real UUID will be captured and saved by runner.ts
            await sendMessage(config.token, thread.id, `🧵 Thread **${threadName}** created with independent session. Start chatting!`);
            results.push(`✅ **${threadName}** → <#${thread.id}>`);
            console.log(`[Discord] Thread created: ${thread.id} name="${threadName}" parent=${channelId} knownSize=${knownThreads.size}`);
          } catch (err) {
            results.push(`❌ **${threadName}** — ${err instanceof Error ? err.message : err}`);
          }
        }
        await sendMessage(config.token, channelId, results.join("\n"));
        return;
      }

      if (intent && intent.action === "fire" && intent.names.length > 0) {
        const results: string[] = [];
        for (const targetName of intent.names) {
          const targetLower = targetName.toLowerCase();
          let foundId: string | null = null;
          for (const [tid, info] of knownThreads.entries()) {
            if (info.parentId === channelId) {
              try {
                const ch = await discordApi<{ id: string; name: string }>(config.token, "GET", `/channels/${tid}`);
                if (ch.name.toLowerCase() === targetLower) {
                  foundId = tid;
                  break;
                }
              } catch { /* thread might be gone */ }
            }
          }
          if (foundId) {
            try {
              await removeThreadSession(foundId);
              await discordApi(config.token, "DELETE", `/channels/${foundId}`);
              knownThreads.delete(foundId);
              results.push(`🗑️ **${targetName}** — deleted`);
            } catch (err) {
              results.push(`❌ **${targetName}** — ${err instanceof Error ? err.message : err}`);
            }
          } else {
            results.push(`❌ **${targetName}** — not found`);
          }
        }
        await sendMessage(config.token, channelId, results.join("\n"));
        return;
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

    // For guild messages not already in a thread, route the bot's reply into
    // a thread BEFORE running Claude so the reply (and follow-ups) live in
    // the thread instead of cluttering the channel. Two-step routing:
    //   1. If the user's message is a reply-to a message that already has a
    //      thread, reuse that thread. This is the common art-channel case:
    //      bot posts art → auto-creates thread A → user uses Discord's reply
    //      UI on the art post → we'd otherwise create thread B and reply
    //      there with no context. Routing into A keeps the conversation in
    //      one place and lets the thread session provide context.
    //   2. Otherwise, auto-create a fresh thread off the user's message.
    let replyChannelId = channelId;
    const inKnownThread = knownThreads.has(channelId);
    if (isGuild && !inKnownThread) {
      const refThreadId = message.referenced_message?.thread?.id;
      if (refThreadId) {
        knownThreads.set(refThreadId, { parentId: channelId });
        await joinThreadIfNeeded(config.token, refThreadId);
        replyChannelId = refThreadId;
        console.log(
          `[Discord] Routed parent-channel reply into existing thread ${refThreadId.slice(0, 8)} ` +
          `(referenced message ${message.referenced_message!.id.slice(0, 8)} already has thread)`,
        );
      } else {
        try {
          const threadName = (cleanContent || "Thread").slice(0, 100);
          const thread = await discordApi<{ id: string }>(
            config.token, "POST",
            `/channels/${channelId}/messages/${message.id}/threads`,
            { name: threadName, auto_archive_duration: 4320 },
          );
          knownThreads.set(thread.id, { parentId: channelId });
          // Creating a thread does not reliably add the bot as a member —
          // join explicitly so follow-ups in it arrive via the gateway.
          await joinThreadIfNeeded(config.token, thread.id);
          replyChannelId = thread.id;
          debugLog(`Auto-created reply thread: ${thread.id} for message ${message.id}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // 160004: Discord already auto-created a thread for this message
          // (channel-level auto-thread setting). Fetch the message and route
          // into the existing thread instead of falling back to parent channel.
          if (errMsg.includes("160004")) {
            try {
              const msg = await discordApi<{ thread?: { id: string } }>(
                config.token, "GET",
                `/channels/${channelId}/messages/${message.id}`,
              );
              if (msg.thread?.id) {
                knownThreads.set(msg.thread.id, { parentId: channelId });
                await joinThreadIfNeeded(config.token, msg.thread.id);
                replyChannelId = msg.thread.id;
                debugLog(`Routed into pre-existing thread ${msg.thread.id} for message ${message.id}`);
              }
            } catch (lookupErr) {
              debugLog(`Could not fetch pre-existing thread for ${message.id}: ${lookupErr instanceof Error ? lookupErr.message : lookupErr}`);
            }
          } else {
            console.warn(`[Discord] Failed to auto-create reply thread for message ${message.id} in ${channelId}: ${errMsg}`);
          }
        }
      }
    }

    // Thread messages (including auto-created ones) get their own persistent session.
    // Only messages that couldn't get a thread run ephemerally via runOnce.
    const threadTarget = knownThreads.has(replyChannelId) ? replyChannelId : undefined;

    // Diagnostic for the "fell to quick session" path. If we got here through
    // a thread-shaped channel (type 10/11/12) but threadTarget is undefined,
    // the agent will reply without thread context — that's the bug we keep
    // chasing. Log enough state to root-cause it from the daemon log.
    console.log(
      `[Discord][DIAG] route channel=${channelId} replyChannel=${replyChannelId} ` +
      `threadTarget=${threadTarget ?? "none"} knownThread=${knownThreads.has(channelId)} ` +
      `triggerReason=${triggerReason} contentLen=${cleanContent.length}`,
    );

    // When starting a fresh Claude session for an EXISTING thread (channel
    // is already a thread, but we have no resumable session for it), pull
    // prior Discord messages from the thread and prepend them so the agent
    // doesn't walk in blind. Skip auto-created threads (replyChannelId
    // !== channelId): those have no prior turns to recover.
    let threadPrompt = prefixedPrompt;
    if (threadTarget && threadTarget === channelId) {
      const existingSession = await peekThreadSession(threadTarget);
      if (!existingSession) {
        const parentId = knownThreads.get(threadTarget)?.parentId;
        if (parentId) {
          const history = await fetchThreadHistoryContext(config.token, threadTarget, parentId, message.id);
          if (history) {
            threadPrompt = `${history}\n\n${prefixedPrompt}`;
            console.log(`[Discord] Seeded new thread session with prior history (${threadTarget.slice(0, 8)}, ${history.length} chars)`);
          }
        }
      }
    }

    const result = threadTarget
      ? await runUserMessage("discord", threadPrompt, threadTarget)
      : await runOnce("discord", prefixedPrompt);

    if (result.exitCode !== 0) {
      await sendMessage(config.token, replyChannelId, `Error (exit ${result.exitCode}): ${result.stderr || result.stdout || "Unknown error"}`);
    } else {
      const { cleanedText, reactionEmoji } = extractReactionDirective(result.stdout || "");
      const { cleanedText: textWithoutImages, imagePaths } = extractImageDirectives(cleanedText);
      if (reactionEmoji) {
        await sendReaction(config.token, channelId, message.id, reactionEmoji).catch((err) => {
          console.error(`[Discord] Failed to send reaction for ${label}: ${err instanceof Error ? err.message : err}`);
        });
      }
      const finalText = textWithoutImages || (imagePaths.length > 0 ? "" : "(empty response)");
      const sentId = imagePaths.length > 0
        ? await sendMessageWithFiles(config.token, replyChannelId, finalText, imagePaths).catch((err) => {
            console.error(`[Discord] Image upload failed for ${label}: ${err instanceof Error ? err.message : err}`);
            return sendMessage(config.token, replyChannelId, finalText || "(image upload failed)");
          })
        : await sendMessage(config.token, replyChannelId, finalText);
      if (sentId) {
        recordResponse({
          messageId: sentId,
          channelId: replyChannelId,
          userId,
          prompt: cleanContent || (voiceTranscript ? `(voice) ${voiceTranscript}` : "(no text)"),
          response: finalText,
        }).catch((err) => debugLog(`Failed to record response: ${err}`));
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Discord] Error for ${label}: ${errMsg}`);
    // replyChannelId is scoped to the try block, so error reports go to the
    // original channel — acceptable, since the thread may not exist yet.
    await sendMessage(config.token, channelId, `Error: ${errMsg}`);
  } finally {
    clearInterval(typingInterval);
    inFlightThreads.delete(channelId);
  }
}

// --- Reaction handler (training-data capture) ---

interface ReactionAddPayload {
  user_id: string;
  channel_id: string;
  message_id: string;
  guild_id?: string;
  emoji: { id: string | null; name: string | null; animated?: boolean };
  message_author_id?: string;
}

// Ack any allowlisted reaction with a ⚡ on the same message, regardless of
// who authored it. The bot's own ⚡ won't loop back because gateway events
// from botUserId are filtered above.
const REACTION_ACK_EMOJI = "⚡";

async function handleReactionAdd(token: string, data: ReactionAddPayload): Promise<void> {
  // Ignore reactions added by the bot itself.
  if (botUserId && data.user_id === botUserId) return;

  // Only act on reactions from authorized users (same allowlist as messages).
  const config = getSettings().discord;
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(data.user_id)) return;

  const isCustom = !!data.emoji.id;
  const emojiName = data.emoji.name; // unicode char or custom name
  if (!emojiName) return;

  // Don't ack our own ack — if someone else also reacts ⚡, we'd otherwise
  // pile on. Cheap dedupe: skip when the incoming emoji already matches.
  if (!isCustom && emojiName === REACTION_ACK_EMOJI) {
    debugLog(`Reaction ack skipped (already ⚡): msg ${data.message_id}`);
  } else {
    await sendReaction(token, data.channel_id, data.message_id, REACTION_ACK_EMOJI).catch((err) => {
      console.error(`[Discord] Failed to ack reaction on ${data.message_id}: ${err instanceof Error ? err.message : err}`);
    });
  }

  // Training-data capture is still scoped to bot-authored messages. The ack
  // above runs for any message; the log below only when we have a clean
  // signal about one of our own replies.
  if (data.message_author_id && botUserId && data.message_author_id !== botUserId) return;

  const sentiment = classifyEmoji(emojiName, isCustom);
  if (sentiment === "neutral") {
    debugLog(`Reaction skipped (neutral): ${emojiName} on ${data.message_id}`);
    return;
  }

  await recordReaction({
    messageId: data.message_id,
    channelId: data.channel_id,
    reactorId: data.user_id,
    emoji: emojiName,
    isCustom,
    sentiment,
  });
  console.log(`[Discord][train] ${sentiment} reaction ${emojiName} on msg ${data.message_id}`);
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
      const threadSessions = await listThreadSessions();
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
      if (threadSessions.length > 0) {
        lines.push("", `**Thread Sessions:** ${threadSessions.length}`);
        for (const ts of threadSessions.slice(0, 5)) {
          lines.push(`  Thread \`${ts.threadId.slice(0, 8)}\` → Session \`${ts.sessionId.slice(0, 8)}\` (${ts.turnCount} turns)`);
        }
        if (threadSessions.length > 5) {
          lines.push(`  ... and ${threadSessions.length - 5} more`);
        }
      }
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
  startWatchdog();
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (heartbeatJitterTimer) clearTimeout(heartbeatJitterTimer);
  heartbeatJitterTimer = null;
  stopWatchdog();
}

function startWatchdog(): void {
  stopWatchdog();
  lastGatewayActivityAt = Date.now();
  watchdogTimer = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const gap = Date.now() - lastGatewayActivityAt;
    const limit = Math.max(heartbeatIntervalMs * 2, 90_000);
    if (gap > limit) {
      console.warn(
        `[Discord] Watchdog: no gateway activity for ${Math.round(gap / 1000)}s ` +
        `(limit ${Math.round(limit / 1000)}s) — forcing reconnect`,
      );
      try { ws?.close(4000, "Watchdog timeout"); } catch {}
    }
  }, 30_000);
}

function stopWatchdog(): void {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
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
  knownThreads.clear();
  stopCatchupTimer();
  inFlightThreads.clear();
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
      startCatchupTimer(token);
      break;

    case "RESUMED":
      console.log("[Discord] Session resumed — rejoining threads + running catchup sweep");
      rejoinThreads(token).catch((err) =>
        console.error(`[Discord] Failed to rejoin threads on RESUMED: ${err}`),
      );
      catchupThreads(token).catch((err) =>
        console.error(`[Discord] Catchup on RESUMED failed: ${err}`),
      );
      break;

    case "MESSAGE_CREATE":
      console.log(`[Discord][GW] MESSAGE_CREATE ch=${data.channel_id} author=${data.author?.username} guild=${data.guild_id || 'DM'}`);
      handleMessageCreate(token, data).catch((err) =>
        console.error(`[Discord] MESSAGE_CREATE unhandled:`, err),
      );
      break;

    case "MESSAGE_REACTION_ADD":
      handleReactionAdd(token, data).catch((err) =>
        console.error(`[Discord] MESSAGE_REACTION_ADD unhandled:`, err),
      );
      break;

    case "INTERACTION_CREATE":
      handleInteractionCreate(token, data).catch((err) =>
        console.error(`[Discord] INTERACTION_CREATE unhandled: ${err}`),
      );
      break;

    case "GUILD_CREATE":
      // Cache active threads for multi-session support
      if (data.threads) {
        console.log(`[Discord] GUILD_CREATE: ${data.threads.length} active threads in guild ${data.id}`);
        for (const thread of data.threads) {
          knownThreads.set(thread.id, { parentId: thread.parent_id });
          console.log(`[Discord]   thread: ${thread.id} name="${thread.name}" parent=${thread.parent_id}`);
        }
      } else {
        console.log(`[Discord] GUILD_CREATE: no active threads in guild ${data.id}`);
      }
      // Rejoin all known threads from sessions.json so gateway sends MESSAGE_CREATE
      rejoinThreads(token).catch((err) =>
        console.error(`[Discord] Failed to rejoin threads: ${err}`),
      );
      handleGuildCreate(token, data).catch((err) =>
        console.error(`[Discord] GUILD_CREATE unhandled: ${err}`),
      );
      break;

    case "THREAD_CREATE":
      if (data.id && data.parent_id) {
        knownThreads.set(data.id, { parentId: data.parent_id });
        // Membership, not just tracking, is what keeps MESSAGE_CREATE flowing
        // for this thread across reconnects — join as soon as we see it.
        joinThreadIfNeeded(token, data.id).catch(() => {});
        debugLog(`Thread tracked: ${data.id} (parent: ${data.parent_id})`);
      }
      break;

    case "THREAD_DELETE":
      if (data.id) {
        knownThreads.delete(data.id);
        removeThreadSession(data.id).catch((err) =>
          console.error(`[Discord] Failed to cleanup thread session: ${err}`),
        );
        debugLog(`Thread removed: ${data.id}`);
      }
      break;

    case "THREAD_UPDATE":
      // Archive is reversible — Discord auto-unarchives on the next message.
      // Keep both knownThreads and the persistent Claude session intact across
      // archive cycles so a user can return hours later and continue talking.
      // Only THREAD_DELETE is destructive.
      if (data.id && data.parent_id) {
        knownThreads.set(data.id, { parentId: data.parent_id });
        if (data.thread_metadata?.archived) {
          debugLog(`Thread archived (session preserved): ${data.id}`);
        }
      }
      break;

    case "THREAD_LIST_SYNC":
      if (data.threads) {
        for (const thread of data.threads) {
          knownThreads.set(thread.id, { parentId: thread.parent_id });
        }
      }
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
    lastGatewayActivityAt = Date.now();
    try {
      const payload = JSON.parse(String(event.data)) as GatewayPayload;
      handleGatewayPayload(token, payload);
    } catch (err) {
      console.error(`[Discord] Failed to parse gateway payload: ${err}`);
    }
  };

  ws.onclose = (event) => {
    // Console-level (not debugLog): the gateway flapping silently is exactly
    // the failure mode that made 2026-07-09 message delivery degrade to the
    // catchup sweep with nothing in the daemon log to explain why.
    console.log(`[Discord] Gateway closed: code=${event.code} reason=${event.reason || "(none)"}`);
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
