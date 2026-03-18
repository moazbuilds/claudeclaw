interface ResultEnvelope {
  is_error?: unknown;
  result?: unknown;
  error?: unknown;
}

function extractJsonErrorDetail(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as ResultEnvelope;

    if (parsed.is_error === true && typeof parsed.result === "string" && parsed.result.trim()) {
      return parsed.result.trim();
    }

    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }

    if (
      parsed.error &&
      typeof parsed.error === "object" &&
      typeof (parsed.error as { message?: unknown }).message === "string" &&
      (parsed.error as { message: string }).message.trim()
    ) {
      return (parsed.error as { message: string }).message.trim();
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

export function extractRuntimeErrorDetail(result: { stdout: string; stderr: string }): string {
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  return extractJsonErrorDetail(result.stdout) ?? "Unknown error";
}
