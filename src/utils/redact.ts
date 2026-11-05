/**
 * Redaction of tool arguments for the application log.
 *
 * Tool-call arguments can carry credentials (user passwords), upload payloads
 * (base64 files/images) and page content (html / markdown, and the fragments
 * passed to the partial-edit tools). None of that belongs in a log line, so
 * only the length of these values is recorded.
 */
const SENSITIVE_ARG_KEYS = new Set([
  'password',
  'file',
  'image',
  'token',
  'api_token',
  'apiToken',
  // Page content and edit fragments.
  'html',
  'markdown',
  'content',
  'old_string',
  'new_string',
  'email',
]);

export function redactArgs(args: unknown, depth = 0): unknown {
  if (depth > 6) return '[too deep]';
  if (Array.isArray(args)) return args.map((v) => redactArgs(v, depth + 1));
  if (!args || typeof args !== 'object') return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (SENSITIVE_ARG_KEYS.has(k)) {
      out[k] = typeof v === 'string' ? `[redacted ${v.length} chars]` : '[redacted]';
    } else {
      out[k] = redactArgs(v, depth + 1);
    }
  }
  return out;
}
