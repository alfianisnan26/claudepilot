/** Shortest server code the server accepts (from env or set by hand). */
export const CODE_MIN_LENGTH = 6;
export const CODE_MAX_LENGTH = 64;

/** Generated codes: 4-4 groups from an alphabet with no look-alikes (no 0/O, 1/I/L). */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const GENERATED_CODE_LENGTH = 8;

/** What a code is compared as: case, spaces and dashes don't matter when typing it. */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

/** `ABCDEFGH` → `ABCD-EFGH`, for showing a generated code. Other codes pass through. */
export function formatCode(code: string): string {
  return /^[A-Z0-9]{8}$/.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** Why a code can't be used, or null when it can. */
export function codeProblem(input: string): string | null {
  const code = normalizeCode(input);
  if (code.length < CODE_MIN_LENGTH) return `Use at least ${CODE_MIN_LENGTH} characters.`;
  if (code.length > CODE_MAX_LENGTH) return `Use at most ${CODE_MAX_LENGTH} characters.`;
  if (!/^[A-Z0-9]+$/.test(code)) return 'Use letters and digits only.';
  return null;
}
