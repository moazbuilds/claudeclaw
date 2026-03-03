import { start } from "./commands/start";
import { stop, stopAll } from "./commands/stop";
import { clear } from "./commands/clear";
import { status } from "./commands/status";
import { telegram } from "./commands/telegram";
import { discord } from "./commands/discord";
import { send } from "./commands/send";

const args = process.argv.slice(2);
const command = args[0];

if (command === "--stop-all") {
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
} else {
  start();
}
