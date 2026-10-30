// Nothing the extension writes to its output channel, a message or an error may carry a secret (VC4): the portal token, the device code,
// or anything else shaped like a credential that a portal error or an agent's text might hold.

const PATTERNS: RegExp[] = [
  /\bcp[a-z]{2}_[A-Za-z0-9_-]{16,}/g, // the portal's tokens: cpat_, cpst_, cpoa_, cpor_, cppt_ ...
  /\bBearer\s+\S+/gi,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\b(deviceCode|device_code|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  // A pattern with groups keeps its key (`token: [hidden]`); without groups the callback's second argument is the offset, a number.
  for (const p of PATTERNS) out = out.replace(p, (_m: string, key: unknown, sep: unknown) => (typeof key === 'string' && typeof sep === 'string' ? `${key}${sep}[hidden]` : '[hidden]'));
  return out;
}
