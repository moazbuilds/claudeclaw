/**
 * Extract a user-facing error detail from a Claude CLI run result.
 *
 * Claude CLI sometimes returns human-readable auth/quota failures in JSON
 * stdout instead of stderr. Prefer stderr when present, otherwise parse the
 * JSON stdout payload and fall back to raw stdout text.
 */
export function extractErrorDetail(result: { stdout: string; stderr: string }): string {
  const stderr = result.stderr?.trim() || "";
  if (stderr) return stderr;

  const stdout = result.stdout?.trim() || "";
  if (!stdout) return "";

  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.is_error && parsed?.result) return String(parsed.result).trim();
    if (parsed?.error?.message) return String(parsed.error.message).trim();
    if (typeof parsed?.error === "string") return parsed.error.trim();
  } catch {}

  return stdout;
}
