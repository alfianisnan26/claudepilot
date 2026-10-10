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

/** Why a code can't be used, or null when it can. */
export function codeProblem(input: string): string | null {
  const code = normalizeCode(input);
  if (!/^[A-Z0-9]*$/.test(code)) return 'Use letters and digits only.';
  if (code.length !== CODE_LENGTH) return `Use exactly ${CODE_LENGTH} characters.`;
  return null;
}
