import { execSync, spawnSync } from "node:child_process";
import { chmod, mkdir, rename, rm, stat, access, readdir, open, readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings } from "./config";

const WHISPER_MODEL = "base.en";
const WHISPER_ROOT = join(process.cwd(), ".claude", "claudeclaw", "whisper");
const BIN_DIR = join(WHISPER_ROOT, "bin");
const LIB_DIR = join(WHISPER_ROOT, "lib");
const MODEL_FOLDER = join(WHISPER_ROOT, "models");
const TMP_FOLDER = join(WHISPER_ROOT, "tmp");
const OGG_MJS_CONVERTER = fileURLToPath(new URL("./ogg.mjs", import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));

const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin`;

interface BinarySource {
  url: string;
  format: "tar.gz" | "zip";
  headers?: Record<string, string>;
}

const BINARY_SOURCES: Record<string, BinarySource> = {
  "linux-x64": {
    url: "https://github.com/dscripka/whisper.cpp_binaries/releases/download/commit_3d42463/whisper-bin-linux-x64.tar.gz",
    format: "tar.gz",
  },
  "darwin-arm64": {
    url: "https://ghcr.io/v2/homebrew/core/whisper-cpp/blobs/sha256:f0901568c7babbd3022a043887007400e4b57a22d3a90b9c0824d01fa3a77270",
    format: "tar.gz",
    headers: { Authorization: "Bearer QQ==" },
  },
  "darwin-x64": {
    url: "https://ghcr.io/v2/homebrew/core/whisper-cpp/blobs/sha256:e6c2f78cbc5d6b311dfe24d8c5d4ffc68a634465c5e35ed11746068583d273c4",
    format: "tar.gz",
    headers: { Authorization: "Bearer QQ==" },
  },
  "linux-arm64": {
    url: "https://ghcr.io/v2/homebrew/core/whisper-cpp/blobs/sha256:684199fd6bec28cddfa086c584a49d236386c109f901a443b577b857fd052f83",
    format: "tar.gz",
    headers: { Authorization: "Bearer QQ==" },
  },
  "win32-x64": {
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip",
    format: "zip",
  },
};

let warmupPromise: Promise<void> | null = null;

type WhisperDebugLog = (message: string) => void;

function noopLog(): void {}

function getWhisperBinaryPath(): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(BIN_DIR, `whisper-cli${suffix}`);
}

function getModelPath(): string {
  return join(MODEL_FOLDER, `ggml-${WHISPER_MODEL}.bin`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(dir: string, names: string[]): Promise<string | null> {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const targets = names.flatMap((n) => (suffix ? [n + suffix, n] : [n]));

  async function search(current: string): Promise<string | null> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isFile() && targets.includes(entry.name)) return fullPath;
      if (entry.isDirectory()) {
        const found = await search(fullPath);
        if (found) return found;
      }
    }
    return null;
  }

  return search(dir);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function downloadFile(url: string, destPath: string, headers?: Record<string, string>): Promise<void> {
  const tmpPath = destPath + ".tmp";
  let existingBytes = 0;

  try {
    existingBytes = (await stat(tmpPath)).size;
  } catch {}

  const reqHeaders: Record<string, string> = { ...headers };
  if (existingBytes > 0) {
    reqHeaders["Range"] = `bytes=${existingBytes}-`;
    console.log(`whisper: resuming download from ${formatBytes(existingBytes)}`);
  }

  const response = await fetch(url, { redirect: "follow", headers: reqHeaders });

  const isResume = response.status === 206 && existingBytes > 0;
  if (!isResume && !response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }

  // If server ignored Range and sent full file, start over
  if (existingBytes > 0 && response.status === 200) {
    existingBytes = 0;
    await rm(tmpPath, { force: true });
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  const totalSize = isResume ? existingBytes + contentLength : contentLength;
  const body = response.body;
  if (!body) throw new Error("No response body");

  // Stream to file with progress, appending if resuming
  const fh = await open(tmpPath, isResume ? "a" : "w");
  let received = isResume ? existingBytes : 0;
  let lastLog = Date.now();

  try {
    for await (const chunk of body) {
      await fh.write(new Uint8Array(chunk));
      received += chunk.byteLength;
      if (totalSize > 0 && Date.now() - lastLog > 2000) {
        const pct = Math.round((received / totalSize) * 100);
        console.log(`whisper: downloading ${formatBytes(received)} / ${formatBytes(totalSize)} (${pct}%)`);
        lastLog = Date.now();
      }
    }
  } finally {
    await fh.close();
  }

  await rename(tmpPath, destPath);
}

async function downloadAndExtractBinary(): Promise<void> {
  const platformKey = `${process.platform}-${process.arch}`;
  const source = BINARY_SOURCES[platformKey];
  if (!source) {
    throw new Error(
      `No pre-built whisper binary for ${platformKey}. Supported: ${Object.keys(BINARY_SOURCES).join(", ")}`
    );
  }

  const extractDir = join(TMP_FOLDER, "extract");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await mkdir(BIN_DIR, { recursive: true });
  await mkdir(LIB_DIR, { recursive: true });

  const archiveExt = source.format === "tar.gz" ? "tar.gz" : "zip";
  const archivePath = join(TMP_FOLDER, `whisper-bin.${archiveExt}`);

  console.log(`whisper: downloading binary for ${platformKey}...`);
  await downloadFile(source.url, archivePath, source.headers);

  console.log("whisper: extracting...");
  if (source.format === "tar.gz") {
    const proc = Bun.spawnSync(["tar", "xzf", archivePath, "-C", extractDir]);
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to extract tar.gz: ${proc.stderr.toString()}`);
    }
  } else {
    const proc = Bun.spawnSync(["unzip", "-o", archivePath, "-d", extractDir]);
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to extract zip: ${proc.stderr.toString()}`);
    }
  }

  // Find the whisper binary (could be named whisper-cli or main)
  const found = await findExecutable(extractDir, ["whisper-cli", "main"]);
  if (!found) {
    throw new Error("Could not find whisper-cli or main binary in downloaded archive");
  }

  const destBinary = getWhisperBinaryPath();
  await Bun.write(destBinary, Bun.file(found));
  await chmod(destBinary, 0o755);

  // Copy any shared libraries (for Homebrew bottles)
  const entries = await readdir(extractDir, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.includes("whisper") && (name.endsWith(".so") || name.endsWith(".dylib") || name.match(/\.so\.\d/))) {
      const parentPath = entry.parentPath ?? entry.path ?? "";
      const srcPath = join(parentPath, name);
      const destPath = join(LIB_DIR, name);
      await Bun.write(destPath, Bun.file(srcPath));
    }
  }

  // Cleanup
  await rm(extractDir, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  console.log("whisper: binary ready");
}

async function downloadModel(): Promise<void> {
  const modelPath = getModelPath();
  if (await fileExists(modelPath)) return;

  await mkdir(MODEL_FOLDER, { recursive: true });
  console.log(`whisper: downloading model ${WHISPER_MODEL}...`);
  await downloadFile(MODEL_URL, modelPath);
  console.log("whisper: model ready");
}

async function prepareWhisperAssets(printOutput: boolean): Promise<void> {
  const startedAt = Date.now();
  console.log(`whisper warmup: start root=${WHISPER_ROOT} model=${WHISPER_MODEL}`);
  await mkdir(WHISPER_ROOT, { recursive: true });
  await mkdir(TMP_FOLDER, { recursive: true });

  const binaryPath = getWhisperBinaryPath();
  if (!(await fileExists(binaryPath))) {
    await downloadAndExtractBinary();
  } else {
    console.log("whisper warmup: binary exists");
  }

  await downloadModel();
  console.log(`whisper warmup: complete in ${Date.now() - startedAt}ms`);
}

function ensureOggDeps(): void {
  const marker = join(PLUGIN_ROOT, "node_modules", "ogg-opus-decoder");
  try {
    statSync(marker);
  } catch {
    console.log("whisper: installing ogg-opus-decoder...");
    const pkgMgr = (() => {
      try { execSync("bun --version", { stdio: "ignore" }); return "bun"; } catch {}
      return "npm";
    })();
    execSync(`${pkgMgr} install`, { cwd: PLUGIN_ROOT, stdio: "inherit" });
  }
}

function decodeOggOpusToWavViaNode(inputPath: string, wavPath: string, log: WhisperDebugLog): void {
  ensureOggDeps();
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
    console.log(`whisper warmup: creating warmup promise printOutput=${printOutput}`);
    warmupPromise = prepareWhisperAssets(printOutput).catch((err) => {
      console.error(`whisper warmup: failed - ${err instanceof Error ? err.message : String(err)}`);
      warmupPromise = null;
      throw err;
    });
  } else {
    console.log("whisper warmup: reusing in-flight warmup promise");
  }
  return warmupPromise;
}

async function transcribeViaApi(
  inputPath: string,
  baseUrl: string,
  model: string,
  log: WhisperDebugLog
): Promise<string> {
  const apiModel = model || "Systran/faster-whisper-large-v3";
  const url = `${baseUrl}/v1/audio/transcriptions`;
  log(`voice transcribe: using STT API url=${url} model=${apiModel}`);

  const audioBytes = await readFile(inputPath);
  const ext = extname(inputPath).toLowerCase().replace(".", "") || "ogg";
  const mimeMap: Record<string, string> = {
    ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav",
    mp3: "audio/mpeg", m4a: "audio/mp4", webm: "audio/webm",
  };
  const mimeType = mimeMap[ext] ?? "audio/ogg";

  const form = new FormData();
  form.append("file", new Blob([audioBytes], { type: mimeType }), `audio.${ext}`);
  form.append("model", apiModel);

  const response = await fetch(url, { method: "POST", body: form });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`STT API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { text?: string };
  const transcript = (data.text ?? "").trim();
  log(`voice transcribe: API transcript chars=${transcript.length}`);
  return transcript;
}

export async function transcribeAudioToText(
  inputPath: string,
  options?: { debug?: boolean; log?: WhisperDebugLog }
): Promise<string> {
  const log = options?.debug ? (options?.log ?? console.log) : noopLog;

  const stt = getSettings().stt;
  if (stt?.baseUrl) {
    return transcribeViaApi(inputPath, stt.baseUrl, stt.model, log);
  }
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

  const binaryPath = getWhisperBinaryPath();
  const modelPath = getModelPath();

  const runTranscription = () => {
    const proc = Bun.spawnSync(
      [binaryPath, "-m", modelPath, "-f", wavPath, "--no-timestamps"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          LD_LIBRARY_PATH: [LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
          DYLD_LIBRARY_PATH: [LIB_DIR, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":"),
        },
      }
    );

    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim();
      throw new Error(`whisper transcription failed (exit ${proc.exitCode}): ${stderr}`);
    }

    return proc.stdout.toString();
  };

  try {
    let rawOutput: string;
    try {
      rawOutput = runTranscription();
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("ENOENT")) throw err;
      log("voice transcribe: missing whisper executable, forcing re-download and retry");
      warmupPromise = null;
      await rm(BIN_DIR, { recursive: true, force: true });
      await warmupWhisperAssets();
      rawOutput = runTranscription();
    }

    const transcript = rawOutput
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "[BLANK_AUDIO]")
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
