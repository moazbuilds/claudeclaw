import { downloadWhisperModel, installWhisperCpp, transcribe } from "@remotion/install-whisper-cpp";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, extname, join } from "node:path";

const WHISPER_CPP_VERSION = "1.7.6";
const WHISPER_MODEL = "base.en";
const WHISPER_ROOT = join(process.cwd(), ".claude", "claudeclaw", "whisper");
const WHISPER_PATH = join(WHISPER_ROOT, "whisper.cpp");
const MODEL_FOLDER = join(WHISPER_ROOT, "models");
const TMP_FOLDER = join(WHISPER_ROOT, "tmp");

let warmupPromise: Promise<void> | null = null;

async function prepareWhisperAssets(printOutput: boolean): Promise<void> {
  await mkdir(WHISPER_ROOT, { recursive: true });
  await mkdir(MODEL_FOLDER, { recursive: true });
  await mkdir(TMP_FOLDER, { recursive: true });

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

function ensureWavInput(inputPath: string): string {
  if (extname(inputPath).toLowerCase() === ".wav") return inputPath;

  const wavPath = join(TMP_FOLDER, `${basename(inputPath, extname(inputPath))}-${Date.now()}.wav`);
  const result = spawnSync("ffmpeg", ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", wavPath], {
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error("ffmpeg failed to convert audio to 16k mono WAV");
  }
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

export async function transcribeAudioToText(inputPath: string): Promise<string> {
  await warmupWhisperAssets();

  const wavPath = ensureWavInput(inputPath);
  const shouldCleanup = wavPath !== inputPath;
  try {
    const result = await transcribe({
      inputPath: wavPath,
      model: WHISPER_MODEL,
      modelFolder: MODEL_FOLDER,
      whisperCppVersion: WHISPER_CPP_VERSION,
      whisperPath: WHISPER_PATH,
      tokenLevelTimestamps: false,
      printOutput: false,
      language: null,
    });

    return result.transcription
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    if (shouldCleanup) {
      await rm(wavPath, { force: true }).catch(() => {});
    }
  }
}
