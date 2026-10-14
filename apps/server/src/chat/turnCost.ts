// T-343: the running turn's cost, an ESTIMATE. Claude Code reports a session's cost (`total_cost_usd`) only in the `result` that ends a
// turn, and a crew worker often does its whole brief in one turn, so until then the portal adds up the turn's API calls from the stream:
// each call's tokens by kind times its model's list price (lab/prices.ts, the one price table). Pure; the controller keeps one per session
// and drops it when the turn's result arrives: the result always wins.

import { callCostUsd } from '../lab/prices.js';
import type { CallSpend } from './protocol.js';

type Call = Omit<CallSpend, 'messageId' | 'agent'>;

export class TurnCost {
  readonly #calls = new Map<string, Call>();
  #anonymous = 0;

  /**
   * Takes one line's call usage. Lines of the same call (one per content block, then `message_delta`) repeat its usage with output
   * growing, so each count keeps its largest. A main-thread line that does not name its model is priced at `mainModel` (the session's).
   */
  add(s: CallSpend, mainModel: string | null): void {
    const key = s.messageId ?? `anonymous-${++this.#anonymous}`;
    const was = this.#calls.get(key);
    const model = was?.model ?? s.model ?? (s.agent ? null : mainModel);
    this.#calls.set(key, {
      model,
      input: Math.max(was?.input ?? 0, s.input),
      cacheRead: Math.max(was?.cacheRead ?? 0, s.cacheRead),
      cacheWrite5m: Math.max(was?.cacheWrite5m ?? 0, s.cacheWrite5m),
      cacheWrite1h: Math.max(was?.cacheWrite1h ?? 0, s.cacheWrite1h),
      output: Math.max(was?.output ?? 0, s.output),
    });
  }

  /** Dollars so far, or null when any call's model has no known price ("unavailable": a part priced would be a low guess). */
  estimateUsd(): number | null {
    let sum = 0;
    for (const c of this.#calls.values()) {
      const usd = callCostUsd(c.model, c);
      if (usd === null) return null;
      sum += usd;
    }
    return sum;
  }
}
