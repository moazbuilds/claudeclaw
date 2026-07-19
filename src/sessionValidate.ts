/** Parsed session records must carry a non-empty sessionId or be treated as absent. */
export function hasValidSessionId(value: unknown): value is { sessionId: string } {
  if (!value || typeof value !== "object") return false;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0;
}
