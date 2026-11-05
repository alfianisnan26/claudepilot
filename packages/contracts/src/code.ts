/** A short server code (from env, set by hand or generated before PILOT-1185) is this long: one sign-in box each. */
export const CODE_LENGTH = 8;

/**
 * PILOT-1185 slice 2: a long code, the strong kind. 26 characters of the generator's alphabet are 128.8 bits (MIN_CODE_BITS); a code is
 * 8 characters (today's, kept working) or LONG_CODE_MIN to LONG_CODE_MAX. Between them is too long for the boxes and too weak for the bar.
 */
export const LONG_CODE_MIN = 26;
export const LONG_CODE_MAX = 64;

/** Generated codes: groups of 4 from an alphabet with no look-alikes (no 0/O, 1/I/L). */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/** PILOT-1185 slice 2: 28 characters (7 groups of 4), 28 × log2(31) ≈ 138.7 bits, above MIN_CODE_BITS. */
export const GENERATED_CODE_LENGTH = 28;

/** What a code is compared as: case, spaces and dashes don't matter when typing it. */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

/** Whether a (normalized) code is a long one: the sign-in field is then one text field, not the 8 boxes. */
export const isLongCode = (code: string): boolean => code.length > CODE_LENGTH;

/** `ABCDEFGH` → `ABCD-EFGH`, and a long code in groups of 4 (`ABCD-EFGH-…`), for showing a code. */
export function formatCode(code: string): string {
  if (!/^[A-Z0-9]+$/.test(code) || (code.length !== CODE_LENGTH && code.length < LONG_CODE_MIN)) return code;
  return code.match(/.{1,4}/g)!.join('-');
}

/**
 * PILOT-1185: the strength a server code must have before a strict portal (PORTAL_SIGNIN_CODE_STRICT=true) starts with it, or takes it as
 * a new code, while code sign-in is on. The ticket's bar; an 8-character code (at most 41 bits) never reaches it, a long one can.
 */
export const MIN_CODE_BITS = 128;

/** The character sets a code is measured against, smallest first: the first that holds every character is its alphabet. */
const CODE_SETS = ['23456789', '0123456789', CODE_ALPHABET.replace(/[0-9]/g, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', CODE_ALPHABET, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];

/**
 * A code's strength in bits, as length times log2 of the alphabet it actually uses (PILOT-1185): `24689357` is 8 × log2(8) = 24 bits,
 * 8 characters of the generator's alphabet 8 × log2(31) ≈ 39.6, a generated code 138.7. Case, spaces and dashes do not count
 * (normalizeCode). An upper bound: it cannot see a pattern.
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
  if (code.length !== CODE_LENGTH && (code.length < LONG_CODE_MIN || code.length > LONG_CODE_MAX))
    return `Use ${CODE_LENGTH} characters, or ${LONG_CODE_MIN} to ${LONG_CODE_MAX}.`;
  return null;
}
