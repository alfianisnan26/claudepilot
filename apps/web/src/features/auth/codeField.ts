// PILOT-1185 slice 2: what the server-code field does with what is typed or pasted, short code (the 8 boxes) or long (one text field).
import { CODE_LENGTH, LONG_CODE_MAX, LONG_CODE_MIN, normalizeCode } from '@portal/contracts';

/**
 * The field's value from what is in it: letters and digits only, upper case, cut at the longest code. A short field that gets more than 8
 * characters at once (a pasted long code while the page still thinks the code is short) becomes a long one instead of cutting it.
 */
export function cleanCode(raw: string, long: boolean): { value: string; long: boolean } {
  const v = normalizeCode(raw).replace(/[^A-Z0-9]/g, '');
  const isLong = long || v.length > CODE_LENGTH;
  return { value: v.slice(0, isLong ? LONG_CODE_MAX : CODE_LENGTH), long: isLong };
}

/** Whether a change sends the code by itself: only the 8th box of a short code. A long code is sent with Enter or the button. */
export const sendsItself = (value: string, previous: string, long: boolean): boolean =>
  !long && value.length === CODE_LENGTH && value !== previous;

/** What to say when the code is sent too short, or null. A long field still sends 8 characters: the page may not know of a new short code. */
export function codeTooShort(value: string, long: boolean): string | null {
  if (long || value.length > CODE_LENGTH)
    return value.length < LONG_CODE_MIN && value.length !== CODE_LENGTH
      ? `Enter the whole code (${LONG_CODE_MIN} to ${LONG_CODE_MAX} characters).`
      : null;
  return value.length < CODE_LENGTH ? `Enter all ${CODE_LENGTH} characters.` : null;
}
