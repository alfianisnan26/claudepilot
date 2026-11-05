// The detail of an internal failure, made safe for the audit (PILOT-1188): a caller gets fixed text, and the cause goes to `bridge_audit`
// through this. No error source today carries the bearer, so this guards against a future one: `Bearer <x>`, `token=<x>`-style pairs and
// any long token-like run are masked, and the line is cut to 200 characters.

const MAX = 200;

export function redactDetail(text: string): string {
  return text
    .replace(/\b(bearer|basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b(token|secret|password|key)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1$2[redacted]')
    .replace(/[A-Za-z0-9_\-.+/=]{32,}/g, '[redacted]')
    .slice(0, MAX);
}
