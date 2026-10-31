// Helpers outside the portal (T-965 item 1, general-manager PRD §9.2): the supervisor, a coordinator's monitor, a job on another machine.
// Each says it is alive with `POST /api/schedules/heartbeat` (./heartbeat.ts checks the token); this keeps the last beat per name and lists
// it next to the portal's own loops, `stale` when the last beat is older than two of its intervals. In memory, like the loops: after a
// restart a helper is listed again at its next beat. A helper's name, kind, owner and description are its own words: cleaned of escapes
// and anything credential-shaped, cut, and returned to a model as untrusted text (./portalTools.ts).

import { AppError } from '@isnanme/core';
import { SCHEDULE_HEARTBEAT_LIMITS as LIMITS, type ScheduleHeartbeatAck, type ScheduleRow } from '@portal/contracts';
import { cleanText } from '../portalmcp/sanitize.js';
import { iso, STALE_INTERVALS } from './registry.js';

const NAME = /^[a-z0-9][a-z0-9._-]*$/;

interface Helper {
  name: string;
  kind: string;
  intervalMs: number;
  owner: string;
  description: string | null;
  last: number;
  /** The token that sent the last beat (its id; never its secret). */
  tokenId: string;
}

/** Who sent a beat: the verified token's id and label. */
export interface HeartbeatFrom {
  tokenId: string;
  label: string;
}

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });

function word(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > max || !NAME.test(v)) {
    throw invalid(field, `1 to ${max} lower case letters, digits, dot, underscore or dash.`);
  }
  return v;
}

function optionalText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw invalid(field, 'Text, or leave it out.');
  const clean = cleanText(v.trim(), max);
  return clean === '' ? null : clean;
}

export class HelperRegistry {
  readonly #helpers = new Map<string, Helper>();

  /** Records one beat. Throws VALIDATION_FAILED for a bad body, RATE_LIMITED when the list is full of live helpers. */
  beat(body: unknown, from: HeartbeatFrom, now: Date = new Date()): ScheduleHeartbeatAck {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('BAD_REQUEST', 'Expected a JSON object.');
    const b = body as Record<string, unknown>;
    const name = word(b.name, 'name', LIMITS.nameMax);
    const kind = word(b.kind, 'kind', LIMITS.kindMax);
    const interval = b.interval;
    if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < LIMITS.intervalMinS || interval > LIMITS.intervalMaxS) {
      throw invalid('interval', `Whole seconds, ${LIMITS.intervalMinS} to ${LIMITS.intervalMaxS}.`);
    }
    const owner = optionalText(b.owner, 'owner', LIMITS.ownerMax) ?? cleanText(from.label, LIMITS.ownerMax);
    const description = optionalText(b.description, 'description', LIMITS.descriptionMax);
    const t = now.getTime();
    if (!this.#helpers.has(name) && this.#helpers.size >= LIMITS.helpersMax) this.#makeRoom(t);
    const intervalMs = interval * 1000;
    this.#helpers.set(name, { name, kind, intervalMs, owner, description, last: t, tokenId: from.tokenId });
    return { id: `helper:${name}`, next_due: iso(t + intervalMs)!, stale_after: iso(t + STALE_INTERVALS * intervalMs)! };
  }

  /** A full list drops the helper that has been silent longest, when it is stale; otherwise the new one is refused. */
  #makeRoom(now: number): void {
    let oldest: Helper | null = null;
    for (const h of this.#helpers.values()) if (!oldest || h.last < oldest.last) oldest = h;
    if (oldest && now - oldest.last > STALE_INTERVALS * oldest.intervalMs) {
      this.#helpers.delete(oldest.name);
      return;
    }
    throw new AppError('RATE_LIMITED', `At most ${LIMITS.helpersMax} helpers report at once.`);
  }

  get size(): number {
    return this.#helpers.size;
  }

  /** One row per helper, by name. */
  rows(now: Date = new Date()): ScheduleRow[] {
    const t = now.getTime();
    return [...this.#helpers.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((h) => ({
        id: `helper:${h.name}`,
        kind: 'helper',
        name: h.name,
        module: h.kind,
        description: h.description,
        interval_ms: h.intervalMs,
        cron: null,
        last_run: iso(h.last),
        last_result: null,
        last_error: null,
        next_run: iso(h.last + h.intervalMs),
        state: t - h.last > STALE_INTERVALS * h.intervalMs ? 'stale' : 'ok',
        source: null,
        owner: h.owner,
        target: null,
        action: null,
        enabled: null,
      }));
  }
}

/** The portal's one list of helpers. */
export const portalHelpers = new HelperRegistry();
