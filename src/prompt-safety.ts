export function wrapUntrusted(label: string, content: string, maxLen = 8000): string {
  const id = Math.random().toString(36).slice(2, 10);
  const truncated = content.length > maxLen
    ? content.slice(0, maxLen) + "\n[truncated]"
    : content;
  // Defang any opening or closing tag for this label (any ID) inside the content,
  // so attackers cannot inject structure that breaks the wrapper boundary.
  const safe = truncated.replace(
    new RegExp(`</?untrusted-${label}-[a-zA-Z0-9_-]+>`, "g"),
    "[redacted-tag]"
  );
  return `<untrusted-${label}-${id}>\n${safe}\n</untrusted-${label}-${id}>`;
}
