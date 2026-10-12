// Limits and approval (docs/prd/triggers.md FR12, FR13, §11): the input rules (every limit has a bound, none can be switched off: an
// empty field is refused, never read as "no limit") and the check that runs BEFORE a run acts. The order is the PRD's; the first failure
// is the run's `skipped` reason. There is no queue: a refused run is recorded and gone.

import { TRIGGER_APPROVAL_DEFAULT, TRIGGER_DEFAULT_LIMITS, TRIGGER_LIMIT_BOUNDS, type TriggerApproval, type TriggerEventFacts, type TriggerLimits, type TriggerReason, type TriggerSource } from '@portal/contracts';
import { LOGIN } from './normalize.js';

export const APPROVAL_TTL = { min: 1, max: 168, default: 24 };
const TRUSTED_MAX = 50;

/** Field name to message. */
export type Problems = Record<string, string>;

/** Limits from input: missing keys take the base (the defaults, or the trigger's current ones); a present key must be a number in bounds. */
export function parseLimits(input: unknown, base: TriggerLimits = TRIGGER_DEFAULT_LIMITS, problems: Problems = {}): TriggerLimits {
  const out: TriggerLimits = { ...base };
  if (input === undefined) return out;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    problems.limits = 'Expected the limits as an object.';
    return out;
  }
  for (const [key, b] of Object.entries(TRIGGER_LIMIT_BOUNDS) as [keyof TriggerLimits, { min: number; max: number }][]) {
    const v = (input as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) problems[`limits.${key}`] = `A number from ${b.min} to ${b.max}.`;
    else if (v < b.min || v > b.max) problems[`limits.${key}`] = `From ${b.min} to ${b.max}.`;
    else out[key] = key.startsWith('cost') ? Math.round(v * 100) / 100 : Math.floor(v);
  }
  return out;
}

/** Approval from input. `source` picks the default mode; a webhook trigger set to `never` needs `confirm` (FR12). */
export function parseApproval(input: unknown, source: TriggerSource, base: TriggerApproval | null, confirm: boolean, problems: Problems = {}): TriggerApproval {
  const out: TriggerApproval = base ? { ...base, trustedSenders: [...base.trustedSenders] } : { mode: TRIGGER_APPROVAL_DEFAULT[source], trustedSenders: [], ttlHours: APPROVAL_TTL.default };
  if (input !== undefined) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) problems.approval = 'Expected the approval rule as an object.';
    else {
      const a = input as Record<string, unknown>;
      if (a.mode !== undefined) {
        if (a.mode === 'always' || a.mode === 'untrusted' || a.mode === 'never') out.mode = a.mode;
        else problems['approval.mode'] = 'Always, unless trusted, or never.';
      }
      if (a.trustedSenders !== undefined) {
        if (!Array.isArray(a.trustedSenders) || a.trustedSenders.length > TRUSTED_MAX || !a.trustedSenders.every((s) => typeof s === 'string' && LOGIN.test(s)))
          problems['approval.trustedSenders'] = `Up to ${TRUSTED_MAX} logins (letters, digits, . _ -).`;
        else out.trustedSenders = [...new Set(a.trustedSenders as string[])];
      }
      if (a.ttlHours !== undefined) {
        if (typeof a.ttlHours !== 'number' || !Number.isInteger(a.ttlHours) || a.ttlHours < APPROVAL_TTL.min || a.ttlHours > APPROVAL_TTL.max) problems['approval.ttlHours'] = `Whole hours from ${APPROVAL_TTL.min} to ${APPROVAL_TTL.max}.`;
        else out.ttlHours = a.ttlHours;
      }
    }
  }
  // Removing the protection: a webhook trigger that starts runs without anyone looking needs a confirmation.
  if (source === 'webhook' && out.mode === 'never' && base?.mode !== 'never' && !confirm) problems['approval.mode'] = 'Starting webhook runs without approval needs confirm.';
  return out;
}

/** Whether a run waits for a person (FR12). Cron and CI have no sender and go on under `untrusted`; a fork's sender is never trusted. */
export function needsApproval(approval: TriggerApproval, facts: TriggerEventFacts): boolean {
  if (approval.mode === 'always') return true;
  if (approval.mode === 'never') return false;
  if (facts.source !== 'webhook') return false;
  if (!facts.sender || facts.fork === true) return true;
  return !approval.trustedSenders.some((s) => s.toLowerCase() === facts.sender!.toLowerCase());
}

/** Everything the check needs, gathered by the runner at the moment of the check. */
export interface LimitState {
  masterOn: boolean;
  enabled: boolean;
  ownerEnabled: boolean;
  /** `can(owner, 'operate', workspace)` now. */
  ownerMayOperate: boolean;
  /** The database is Locked, Frozen or read-only. */
  locked: boolean;
  emergency: boolean;
  workspace: 'ok' | 'gone' | 'stopped';
  /** CI only: the loop guard. */
  cooldown: boolean;
  selfTriggered: boolean;
  /** Runs `starting` or `running`: of this trigger, of its owner, of every trigger. */
  active: { trigger: number; owner: number; total: number };
  caps: { owner: number; total: number };
  /** Runs started in the last 60 minutes and since midnight in the trigger's zone. */
  startedLastHour: number;
  startedToday: number;
  /** Today's estimated cost of this trigger's runs. */
  costToday: number;
}

/** The first limit that refuses a start, in the PRD's order (FR13), or null. */
export function firstRefusal(l: TriggerLimits, s: LimitState): TriggerReason | null {
  if (!s.masterOn) return 'master_off';
  if (!s.enabled) return 'disabled';
  if (!s.ownerEnabled) return 'owner_disabled';
  if (!s.ownerMayOperate) return 'owner_denied';
  if (s.locked) return 'locked';
  if (s.emergency) return 'emergency';
  if (s.workspace === 'gone') return 'workspace_gone';
  if (s.workspace === 'stopped') return 'workspace_stopped';
  if (s.cooldown) return 'cooldown';
  if (s.selfTriggered) return 'self_triggered';
  if (s.active.trigger >= l.maxParallel || s.active.owner >= s.caps.owner || s.active.total >= s.caps.total) return 'parallel_limit';
  if (s.startedLastHour >= l.maxPerHour) return 'hour_limit';
  if (s.startedToday >= l.maxPerDay) return 'day_limit';
  if (s.costToday >= l.costUsdPerDay) return 'cost_day_limit';
  return null;
}
