export function wrapUntrusted(label: string, content: string, maxLen = 8000): string {
  const id = Math.random().toString(36).slice(2, 10);
  const truncated = content.length > maxLen
    ? content.slice(0, maxLen) + "\n[truncated]"
    : content;
  // Defang any closing tag for this label regardless of ID, so attackers can't break out of the wrapper.
  const safe = truncated.replace(
    new RegExp(`</untrusted-${label}-[a-z0-9]+>`, "g"),
    "[redacted-tag]"
  );
  return `<untrusted-${label}-${id}>\n${safe}\n</untrusted-${label}-${id}>`;
}
