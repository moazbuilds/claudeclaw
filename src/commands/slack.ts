import { App } from "@slack/bolt";
import { ensureProjectClaudeMd, runUserMessage, streamUserMessage, compactCurrentSession } from "../runner";
import { getSettings, loadSettings } from "../config";
import { resetSession } from "../sessions";
import { getThreadSession, removeThreadSession, peekThreadSession } from "../sessionManager";
import { transcribeAudioToText } from "../whisper";
import { resolveSkillPrompt } from "../skills";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const INBOX_DIR = join(process.cwd(), ".claude", "claudeclaw", "inbox", "slack");

export async function slack() {
  await loadSettings();
  const settings = getSettings();

  const slackConfig = (settings as any).slack;
  if (!slackConfig?.appToken || !slackConfig?.botToken) {
    console.error("Slack is not configured. Add slack.appToken and slack.botToken to settings.json");
    process.exit(1);
  }

  await ensureProjectClaudeMd();
  await mkdir(INBOX_DIR, { recursive: true });

  const app = new App({
    token: slackConfig.botToken,
    appToken: slackConfig.appToken,
    socketMode: true,
  });

  let botUserId: string | null = null;
  let teamId: string | null = null;

  // Get bot's own user ID to avoid replying to self
  try {
    const auth = await app.client.auth.test();
    botUserId = auth.user_id as string;
    teamId = auth.team_id as string;
    console.log(`[Slack] Bot user: ${auth.user} (${botUserId})`);
  } catch (e) {
    console.error("[Slack] Failed to get bot identity:", e);
  }

  // Track active threads to avoid concurrent processing
  const activeThreads = new Set<string>();

  // Handle all messages (DMs and mentions)
  app.event("message", async ({ event, say }) => {
    const msg = event as any;

    // Ignore bot's own messages
    if (msg.bot_id || msg.user === botUserId) return;

    // Ignore message subtypes (edits, deletes, etc.)
    if (msg.subtype) return;

    // Check allowed users
    const allowedUsers: string[] = slackConfig.allowedUserIds || [];
    if (allowedUsers.length > 0 && !allowedUsers.includes(msg.user)) {
      return; // Silently ignore unauthorized users
    }

    const text = (msg.text || "").trim();
    if (!text) return;

    // Use thread_ts as thread ID. If message is not in a thread, start one.
    const threadTs = msg.thread_ts || msg.ts;
    const isInThread = !!msg.thread_ts;

    // Prevent concurrent processing of same thread
    if (activeThreads.has(threadTs)) {
      return;
    }
    activeThreads.add(threadTs);

    try {
      // Handle slash-style commands
      if (text.startsWith("/")) {
        const result = await handleCommand(text, threadTs, msg.channel, app, say);
        if (result) return;
      }

      console.log(`[Slack] Message from ${msg.user} in ${msg.channel} (thread: ${threadTs}): ${text.substring(0, 100)}`);

      // Set typing status
      try {
        await (app.client as any).apiCall('assistant.threads.setStatus', {
          channel_id: msg.channel,
          thread_ts: threadTs,
          status: 'is thinking...',
        });
      } catch {}

      // Start native Slack stream
      const streamer = app.client.chatStream({
        channel: msg.channel,
        thread_ts: threadTs,
        ...(teamId ? { recipient_team_id: teamId } : {}),
        ...(msg.user ? { recipient_user_id: msg.user } : {}),
      });
      let streamStarted = false;
      let accumulated = '';

      await streamUserMessage("slack", text,
        async (chunk) => {
          accumulated += chunk;
          try {
            await streamer.append({ markdown_text: chunk });
            streamStarted = true;
          } catch (e) {
            console.error('[Slack] Stream append error:', e);
          }
        },
        () => {}
      );

      // Stop the stream
      if (streamStarted) {
        await streamer.stop().catch((e: any) => console.error('[Slack] Stream stop error:', e));
        // Clear typing status
        try {
          await (app.client as any).apiCall('assistant.threads.setStatus', {
            channel_id: msg.channel,
            thread_ts: threadTs,
            status: '',
          });
        } catch {}
      } else if (!accumulated) {
        await say({ text: '(no response)', thread_ts: threadTs });
      }

    } catch (err: any) {
      console.error(`[Slack] Error processing message:`, err.message);
      await say({ text: `Something went wrong: ${err.message}`, thread_ts: threadTs });
    } finally {
      activeThreads.delete(threadTs);
    }
  });

  // Handle app mentions (in channels)
  app.event("app_mention", async ({ event, say }) => {
    const msg = event as any;

    if (msg.user === botUserId) return;

    const allowedUsers: string[] = slackConfig.allowedUserIds || [];
    if (allowedUsers.length > 0 && !allowedUsers.includes(msg.user)) {
      return;
    }

    // Strip the bot mention from the text
    const text = (msg.text || "")
      .replace(/<@[A-Z0-9]+>/g, "")
      .trim();

    if (!text) return;

    const threadTs = msg.thread_ts || msg.ts;

    if (activeThreads.has(threadTs)) return;
    activeThreads.add(threadTs);

    try {
      console.log(`[Slack] Mention from ${msg.user}: ${text.substring(0, 100)}`);

      const typingInterval2 = setInterval(async () => {
        try { await app.client.chat.meTyping({ channel: msg.channel }); } catch {}
      }, 3000);
      await app.client.chat.meTyping({ channel: msg.channel }).catch(() => {});

      const result = await runUserMessage("slack", text, threadTs);
      const reply = result.exitCode === 0
        ? result.stdout || "(no response)"
        : `Error: ${result.stderr || "Unknown error"}`;

      await say({
        text: truncateMessage(reply),
        thread_ts: threadTs,
      });

    } catch (err: any) {
      console.error(`[Slack] Error:`, err.message);
      await say({
        text: `Something went wrong: ${err.message}`,
        thread_ts: threadTs,
      });
    } finally {
      activeThreads.delete(threadTs);
    }
  });

  await app.start();
  console.log(`[Slack] Connected via Socket Mode`);
  console.log(`[Slack] Listening for DMs and mentions`);
  const users: string[] = slackConfig.allowedUserIds || [];
  if (users.length > 0) {
    console.log(`[Slack] Allowed users: ${users.join(", ")}`);
  } else {
    console.log(`[Slack] Warning: No allowedUserIds set — responding to all users`);
  }
}

async function handleCommand(
  text: string,
  threadTs: string,
  channel: string,
  app: App,
  say: Function
): Promise<boolean> {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === "/new" || cmd === "/reset") {
    await removeThreadSession(threadTs);
    await say({ text: "Session reset. Starting fresh.", thread_ts: threadTs });
    return true;
  }

  if (cmd === "/compact") {
    await say({ text: "Compacting session...", thread_ts: threadTs });
    await compactCurrentSession();
    await say({ text: "Done.", thread_ts: threadTs });
    return true;
  }

  if (cmd === "/status") {
    const session = await peekThreadSession(threadTs);
    if (session) {
      await say({
        text: `Thread session: ${session.sessionId.slice(0, 8)}... | Turns: ${session.turnCount}`,
        thread_ts: threadTs,
      });
    } else {
      await say({ text: "No active session for this thread.", thread_ts: threadTs });
    }
    return true;
  }

  // Check for skill commands
  const skillPrompt = await resolveSkillPrompt(text);
  if (skillPrompt) {
    const result = await runUserMessage("slack", skillPrompt, threadTs);
    const reply = result.exitCode === 0 ? result.stdout || "(no output)" : `Error: ${result.stderr}`;
    await say({ text: truncateMessage(reply), thread_ts: threadTs });
    return true;
  }

  return false;
}

function truncateMessage(text: string, maxLen = 3900): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + "\n... (truncated)";
}

