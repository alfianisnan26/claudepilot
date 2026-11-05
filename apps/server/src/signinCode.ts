// PILOT-1185: is the server sign-in code strong enough to be guessed at without a per-address limit (PILOT-1182)? Measured at boot, once
// the store has said whether code sign-in is on. A weak code with code sign-in on is a warning (and one security alert); with
// PORTAL_SIGNIN_CODE_STRICT=true the portal refuses to start with it. Code sign-in off: the code only confirms an action of a session that
// is already signed in (chat/reauth.ts), so there is nothing to guess from outside and nothing is said. The code itself is never in a line.
import { codeBits, MIN_CODE_BITS, type CodeSource } from '@portal/contracts';

export interface SigninCodeCheck {
  /** The code's strength (codeBits), rounded down. */
  bits: number;
  /** Code sign-in is on and the code is below MIN_CODE_BITS. */
  weak: boolean;
  /** weak, on a strict portal: it must not start. */
  refuse: boolean;
  /** What the boot log says; null when there is nothing to say. Holds no part of the code. */
  line: string | null;
}

export function signinCodeCheck(portal: { code: string; source: CodeSource; codeSignIn: boolean }, strict: boolean): SigninCodeCheck {
  const bits = Math.floor(codeBits(portal.code));
  const weak = portal.codeSignIn && bits < MIN_CODE_BITS;
  if (!weak) return { bits, weak, refuse: false, line: null };
  const what = `the server sign-in code (${portal.source}) has about ${bits} bits, below ${MIN_CODE_BITS}`;
  if (strict)
    return {
      bits,
      weak,
      refuse: true,
      line: `refusing to start: ${what}, and PORTAL_SIGNIN_CODE_STRICT is on (PILOT-1185). Set a stronger PORTAL_SERVER_CODE, or unset PORTAL_SIGNIN_CODE_STRICT and turn code sign-in off.`,
    };
  return {
    bits,
    weak,
    refuse: false,
    line: `${what}: with code sign-in on, a guesser who gets past the per-address limit (PILOT-1182) can find it. PORTAL_SIGNIN_CODE_STRICT=true refuses to start with such a code (PILOT-1185).`,
  };
}
