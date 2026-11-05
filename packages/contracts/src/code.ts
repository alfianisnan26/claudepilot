/** Every server code (from env, set by hand or generated) is this long: one sign-in box each. */
export const CODE_LENGTH = 8;

/** Generated codes: 4-4 groups from an alphabet with no look-alikes (no 0/O, 1/I/L). */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const GENERATED_CODE_LENGTH = CODE_LENGTH;

/** What a code is compared as: case, spaces and dashes don't matter when typing it. */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

/** `ABCDEFGH` → `ABCD-EFGH`, for showing a code. */
export function formatCode(code: string): string {
  return /^[A-Z0-9]{8}$/.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * PILOT-1185: the strength a server code must have before a strict portal (PORTAL_SIGNIN_CODE_STRICT=true) starts with it, or takes it as
 * a new code, while code sign-in is on. The ticket's bar; an 8-character code (at most 41 bits) never reaches it.
 */
export const MIN_CODE_BITS = 128;

/** The character sets a code is measured against, smallest first: the first that holds every character is its alphabet. */
const CODE_SETS = [
  '23456789',
  '0123456789',
  CODE_ALPHABET.replace(/[0-9]/g, ''),
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  CODE_ALPHABET,
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
];

/**
 * A code's strength in bits, as length times log2 of the alphabet it actually uses (PILOT-1185): `24681357` is 8 × log2(8) = 24 bits,
 * a typical generated code 8 × log2(31) ≈ 39.6. Case, spaces and dashes do not count (normalizeCode). An upper bound: it cannot see a pattern.
 */
export function codeBits(input: string): number {
  const code = normalizeCode(input);
  if (!code) return 0;
  const set = CODE_SETS.find((s) => [...code].every((ch) => s.includes(ch)));
  return code.length * Math.log2(set ? set.length : 36);
}

/** Why a code can't be used, or null when it can. */
export function codeProblem(input: string): string | null {
  const code = normalizeCode(input);
  if (!/^[A-Z0-9]*$/.test(code)) return 'Use letters and digits only.';
  if (code.length !== CODE_LENGTH) return `Use exactly ${CODE_LENGTH} characters.`;
  return null;
}
