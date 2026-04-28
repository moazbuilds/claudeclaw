import { runUserMessage, ensureProjectClaudeMd } from "../runner";
import { getSession } from "../sessions";
import { loadSettings, initConfig } from "../config";

export async function send(args: string[]) {
  const telegramFlag = args.includes("--telegram");
  const discordFlag = args.includes("--discord");
  const message = args.filter((a) => a !== "--telegram" && a !== "--discord").join(" ");

  if (!message) {
    console.error("Usage: claudeclaw send <message> [--telegram] [--discord]");
    process.exit(1);
  }

  await initConfig();
  await loadSettings();
  await ensureProjectClaudeMd();

  const session = await getSession();
  if (!session) {
    console.error("No active session. Start the daemon first.");
    process.exit(1);
  }

  const result = await runUserMessage("send", message);
  console.log(result.stdout);

  if (telegramFlag) {
    const settings = await loadSettings();
    const token = settings.telegram.token;
    const userIds = settings.telegram.allowedUserIds;

    if (!token || userIds.length === 0) {
      console.error("Telegram is not configured in settings.");
      process.exit(1);
    }

    const text = result.exitCode === 0
      ? result.stdout || "(empty)"
      : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

    for (const userId of userIds) {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: userId, text }),
        }
      );
      if (!res.ok) {
        console.error(`Failed to send to Telegram user ${userId}: ${res.statusText}`);
      }
    }
    console.log("Sent to Telegram.");
  }

  if (discordFlag) {
    const settings = await loadSettings();
    const dToken = settings.discord.token;
    const dUserIds = settings.discord.allowedUserIds;

    if (!dToken || dUserIds.length === 0) {
      console.error("Discord is not configured in settings.");
      process.exit(1);
    }

    const dText = result.exitCode === 0
      ? result.stdout || "(empty)"
      : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

    for (const userId of dUserIds) {
      // Create DM channel
      const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
        method: "POST",
        headers: {
          Authorization: `Bot ${dToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ recipient_id: userId }),
      });
      if (!dmRes.ok) {
        console.error(`Failed to create DM for Discord user ${userId}: ${dmRes.statusText}`);
        continue;
      }
      const { id: channelId } = (await dmRes.json()) as { id: string };
      const msgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${dToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: dText.slice(0, 2000) }),
      });
      if (!msgRes.ok) {
        console.error(`Failed to send to Discord user ${userId}: ${msgRes.statusText}`);
      }
    }
    console.log("Sent to Discord.");
  }

  if (result.exitCode !== 0) process.exit(result.exitCode);
}
