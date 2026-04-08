import { start } from "./commands/start";
import { stop, stopAll } from "./commands/stop";
import { clear } from "./commands/clear";
import { status } from "./commands/status";
import { telegram } from "./commands/telegram";
import { discord } from "./commands/discord";
import { send } from "./commands/send";
import { runFireCommand } from "./commands/fire";

const args = process.argv.slice(2);
const command = args[0];

const HELP = [
  "claudeclaw — Claude Code harness",
  "",
  "Usage:",
  "  claudeclaw start                    Start the daemon",
  "  claudeclaw status                   Show daemon status",
  "  claudeclaw send <message>           Send a message to the active session",
  "  claudeclaw fire <agent>:<label>     Fire an agent job once, immediately",
  "  claudeclaw fire <agent> <label>     Same, alternate form",
  "  claudeclaw telegram                 Run Telegram adapter",
  "  claudeclaw discord                  Run Discord adapter",
  "  claudeclaw --stop                   Stop the daemon",
  "  claudeclaw --stop-all               Stop all daemons",
  "  claudeclaw --clear                  Clear session/state",
  "  claudeclaw --help                   Show this help",
  "",
].join("\n");

if (command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(HELP);
  process.exit(0);
} else if (command === "--stop-all") {
  stopAll();
} else if (command === "--stop") {
  stop();
} else if (command === "--clear") {
  clear();
} else if (command === "start") {
  start(args.slice(1));
} else if (command === "status") {
  status(args.slice(1));
} else if (command === "telegram") {
  telegram();
} else if (command === "discord") {
  discord();
} else if (command === "send") {
  send(args.slice(1));
} else if (command === "fire") {
  runFireCommand(args.slice(1)).then((code) => process.exit(code));
} else {
  start();
}
