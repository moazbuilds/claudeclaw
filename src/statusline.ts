import { join } from "path";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");

// Write state.json so the statusline script can read fresh data
export interface StateData {
  heartbeat?: { nextAt: number };
  jobs: {
    name: string;
    nextAt: number;
    /** Outcome of the most recent run. Absent until the job runs at least once. */
    lastResult?: "ok" | "error" | "skipped";
    /** Unix timestamp (ms) of the most recent completion. Absent until first run. */
    lastRanAt?: number;
  }[];
  security: string;
  telegram: boolean;
  discord: boolean;
  startedAt: number;
  web?: { enabled: boolean; host: string; port: number };
}

export async function writeState(state: StateData) {
  await Bun.write(
    join(HEARTBEAT_DIR, "state.json"),
    JSON.stringify(state) + "\n"
  );
}
