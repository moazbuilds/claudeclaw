import { mkdir, readFile, writeFile, realpath } from "fs/promises";
import { join, dirname, resolve, sep } from "path";
import { execSync } from "child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import {
  getSession,
  createSession,
  resetSession,
  incrementTurn,
  markCompactWarned,
  getFallbackSession,
  createFallbackSession,
  resetFallbackSession,
  incrementFallbackTurn,
  peekSession,
  incrementMessageCount,
  backupSession,
} from "./sessions";
import { needsRotation, rotateSession, loadLatestSummary } from "./rotation";
import {
  getThreadSession,
  createThreadSession,
  removeThreadSession,
  incrementThreadTurn,
  markThreadCompactWarned,
} from "./sessionManager";
import { getSettings, DEFAULT_SESSION_TIMEOUT_MS, type ModelConfig, type SecurityConfig } from "./config";
import { buildClockPromptPrefix } from "./timezone";
import { selectModel } from "./model-router";
import { recordResult, abortReason, clearSession, startSession } from "./watchdog";
import { getPluginManager, type EventContext } from "./plugins";
