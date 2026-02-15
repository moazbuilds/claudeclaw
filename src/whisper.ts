import {
  downloadWhisperModel,
  installWhisperCpp,
  transcribe,
} from "@remotion/install-whisper-cpp";
import { spawnSync } from "node:child_process";
import { mkdir, rm, stat, access } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WHISPER_CPP_VERSION = "1.7.6";
const WHISPER_MODEL = "base.en";
const WHISPER_ROOT = join(process.cwd(), ".claude", "claudeclaw", "whisper");
const WHISPER_PATH = join(WHISPER_ROOT, "whisper.cpp");
const MODEL_FOLDER = join(WHISPER_ROOT, "models");
const TMP_FOLDER = join(WHISPER_ROOT, "tmp");
const OGG_MJS_CONVERTER = fileURLToPath(new URL("./ogg.mjs", import.meta.url));

let warmupPromise: Promise<void> | null = null;

type WhisperDebugLog = (message: string) => void;

function noopLog(): void {}

function isVersionAtLeast(version: string, minimum: string): boolean {
  const current = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const required = minimum.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(current.length, required.length);
  for (let index = 0; index < maxLength; index += 1) {
    const currentPart = current[index] ?? 0;
    const requiredPart = required[index] ?? 0;
    if (currentPart > requiredPart) return true;
    if (currentPart < requiredPart) return false;
  }
  return true;
}

function decodeOggOpusToWavViaNode(inputPath: string, wavPath: string, log: WhisperDebugLog): void {
  log(`voice decode: running node converter`);
  const result = spawnSync("node", [OGG_MJS_CONVERTER, inputPath, wavPath], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "";
    const stdout = result.stdout?.trim() || "";
    throw new Error(
      `node decode failed (exit ${result.status ?? "unknown"})${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`
    );
  }

  if (result.stderr?.trim()) log(`voice decode(node): ${result.stderr.trim()}`);
  log(`voice decode: node converter completed`);
}

function getWhisperExecutablePathForVersion(whisperPath: string, whisperCppVersion: string): string {
  const useWhisperCli = isVersionAtLeast(whisperCppVersion, "1.7.4");
  const executableName = useWhisperCli ? "whisper-cli" : "main";
  const executableFolder = useWhisperCli ? ["build", "bin"] : [];
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(resolve(process.cwd(), whisperPath), ...executableFolder, `./${executableName}${suffix}`);
}

function isMissingWhisperExecutableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const maybeErr = err as NodeJS.ErrnoException;
  if (maybeErr.code !== "ENOENT") return false;
  const message = maybeErr.message ?? "";
  const syscall = maybeErr.syscall ?? "";
  const path = maybeErr.path ?? "";
  return (
    message.includes("whisper-cli") ||
    message.includes("spawn") ||
    syscall.includes("spawn") ||
    path.includes("whisper-cli") ||
    path.includes("/main")
  );
}

async function prepareWhisperAssets(printOutput: boolean): Promise<void> {
  await mkdir(WHISPER_ROOT, { recursive: true });
  await mkdir(MODEL_FOLDER, { recursive: true });
  await mkdir(TMP_FOLDER, { recursive: true });

  const whisperExecutablePath = getWhisperExecutablePathForVersion(WHISPER_PATH, WHISPER_CPP_VERSION);
  try {
    await access(whisperExecutablePath);
  } catch {
    // Recover from a partial/broken install where whisper.cpp exists but build output is missing.
    await rm(WHISPER_PATH, { recursive: true, force: true });
  }

  await installWhisperCpp({
    version: WHISPER_CPP_VERSION,
    to: WHISPER_PATH,
    printOutput,
  });
  await downloadWhisperModel({
    model: WHISPER_MODEL,
    folder: MODEL_FOLDER,
    printOutput,
  });
}

async function ensureWavInput(inputPath: string, log: WhisperDebugLog): Promise<string> {
  const ext = extname(inputPath).toLowerCase();
  log(`voice input: path=${inputPath} ext=${ext || "(none)"}`);
  if (ext === ".wav") return inputPath;

  if (ext !== ".ogg" && ext !== ".oga") {
    throw new Error(`unsupported audio format "${ext || "(none)"}" without ffmpeg; supported: .oga, .ogg, .wav`);
  }

  const wavPath = join(TMP_FOLDER, `${basename(inputPath, extname(inputPath))}-${Date.now()}.wav`);
  decodeOggOpusToWavViaNode(inputPath, wavPath, log);
  return wavPath;
}

export function warmupWhisperAssets(options?: { printOutput?: boolean }): Promise<void> {
  const printOutput = options?.printOutput ?? false;
  if (!warmupPromise) {
    warmupPromise = prepareWhisperAssets(printOutput).catch((err) => {
      warmupPromise = null;
      throw err;
    });
  }
  return warmupPromise;
}

export async function transcribeAudioToText(
  inputPath: string,
  options?: { debug?: boolean; log?: WhisperDebugLog }
): Promise<string> {
  const log = options?.debug ? (options?.log ?? console.log) : noopLog;
  await warmupWhisperAssets();
  log(`voice transcribe: warmup ready cwd=${process.cwd()} input=${inputPath}`);
  try {
    const inputStat = await stat(inputPath);
    log(`voice transcribe: input size=${inputStat.size} bytes`);
  } catch (err) {
    log(`voice transcribe: failed to stat input - ${err instanceof Error ? err.message : String(err)}`);
  }

  const wavPath = await ensureWavInput(inputPath, log);
  const shouldCleanup = wavPath !== inputPath;
  log(`voice transcribe: using wav=${wavPath} cleanup=${shouldCleanup}`);

  const runTranscription = async () =>
    transcribe({
      inputPath: wavPath,
      model: WHISPER_MODEL,
      modelFolder: MODEL_FOLDER,
      whisperCppVersion: WHISPER_CPP_VERSION,
      whisperPath: WHISPER_PATH,
      tokenLevelTimestamps: false,
      printOutput: false,
      language: null,
    });

  try {
    let result;
    try {
      result = await runTranscription();
    } catch (err) {
      if (!isMissingWhisperExecutableError(err)) throw err;
      log("voice transcribe: missing whisper executable, forcing reinstall and retry");
      warmupPromise = null;
      await rm(WHISPER_PATH, { recursive: true, force: true });
      await warmupWhisperAssets();
      result = await runTranscription();
    }

    log(`voice transcribe: whisper segments=${result.transcription.length}`);

    const transcript = result.transcription
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    log(`voice transcribe: transcript chars=${transcript.length}`);
    return transcript;
  } finally {
    if (shouldCleanup) {
      log(`voice transcribe: cleanup wav=${wavPath}`);
      await rm(wavPath, { force: true }).catch(() => {});
    }
  }
}
