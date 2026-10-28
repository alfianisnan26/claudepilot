// What the approval card shows of a payload (docs/prd/approvals.md): the exact JSON, with anything that could be a secret masked. The portal
// already refuses a secret-shaped value or a secret-named key when the request is made; this is defence in depth for what is drawn.

export const MASK = '••••••';

/** A key that would name a secret's value. A kind that needs a secret names it (`secretName`), which stays readable. */
const SECRET_KEY = /^(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|credentials|auth|authorization|cookie)$/i;

/** Common credential shapes, and any long unbroken run of key-like characters. */
const SECRET_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /[A-Za-z0-9+/_=-]{40,}/,
];

export const looksSecret = (s: string): boolean => SECRET_SHAPES.some((re) => re.test(s));

/** The payload with secret-named keys and secret-shaped strings replaced by the mask, whatever their depth. */
export function maskPayload(value: unknown, depth = 0): unknown {
  if (depth > 12) return MASK;
  if (typeof value === 'string') return looksSecret(value) ? MASK : value;
  if (Array.isArray(value)) return value.map((v) => maskPayload(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && v !== null && v !== '' ? MASK : maskPayload(v, depth + 1)]),
    );
  }
  return value;
}

/** The text the card draws: the masked payload, indented. */
export const payloadText = (payload: unknown): string => JSON.stringify(maskPayload(payload), null, 2);
