// The recommended destination in the Move dialog (docs/prd/claude-usage.md §20.5), as words. The portal ranks the Claudes a chat can move to by what
// they have left and when it resets; this only says why the best one is the best. A recommendation is advice: nothing moves by itself. Pure, tested.

import type { MoveCandidate, MoveNone, MoveRecommendation } from '@portal/contracts';
import { localTime } from './format';

type Clock = (iso: string) => string;
const defaultClock: Clock = (iso) => localTime(iso);

/** The id of the Claude the portal recommends, or null (then `noneWords` says why, where it is worth saying). */
export const recommendedId = (advice: MoveRecommendation | null): string | null => advice?.recommended ?? null;

/** The candidate for one Claude, or undefined while the advice is not loaded or does not list it. */
export const candidateOf = (advice: MoveRecommendation | null, claudeId: string): MoveCandidate | undefined => advice?.candidates.find((c) => c.claudeId === claudeId);

/** Why the recommended Claude is recommended, for the ⓘ beside "Recommended". Null for a candidate that is not the recommended one. */
export function moveWords(c: MoveCandidate | undefined, clock: Clock = defaultClock): string | null {
  if (!c || !c.recommended) return null;
  if (c.reason === 'no_limits') return 'No plan limits (a pool or an API key): nothing to run out of, billed per use.';
  const left = c.leftPct.basis === 'unavailable' ? null : Math.round(c.leftPct.value);
  const window = c.window?.label ?? 'its fullest window';
  const reset = c.resetsAt.basis === 'unavailable' ? '' : `, resets ${clock(c.resetsAt.value)}`;
  const base = `${left === null ? 'Room' : `${left} % left`} of ${window}${reset}. The most room of the Claudes that can take this chat.`;
  return c.reason === 'over_pace' ? `${base} At its current pace it would run out before it resets (an estimate).` : base;
}

/** The one line under the options when nothing is recommended and that is worth saying; the dialog already says the other two cases. */
export function noneWords(none: MoveNone | null): string | null {
  return none === 'all_tight' ? 'Every Claude that can take it has under 20 % left.' : null;
}
