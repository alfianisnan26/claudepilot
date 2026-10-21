// The flow watchdog (T-1966, docs/prd/flow-watchdog.md): a deterministic loop inside the portal, no model, that keeps a program's work
// moving when the lead sessions that run it only act when messaged. Every few minutes it counts, per configured program (a ticket tag and a
// group of peer leads), the five stalls below and messages the lead that can clear each, rate limited and audited; it tells the owner only
// when nothing was done for hours after it nudged.

export const FLOW_API = {
  /** GET: the watchdog's snapshot (`FlowSnapshot`), owner only. */
  snapshot: '/api/flow',
} as const;

/** The chat actor of its messages, and the first words of every one (a lead can tell them from a person's). */
export const FLOW_ACTOR = 'portal:flow';
export const FLOW_PREFIX = 'FLOW WATCHDOG:';

/**
 * The five conditions. `merge`: in review with a QA PASS on the head and not merged for the merge threshold. `qa`: in review with no
 * verdict on the head and nobody working on it for the QA threshold. `idle`: a lead idle for the idle threshold while its unit holds open
 * work and it runs fewer workers than its cap. `bypass`: a lead that was in Bypass is not now (reported only). `stall`: nothing done in the
 * stall window while tickets wait in review.
 */
export const FLOW_CONDITIONS = ['merge', 'qa', 'idle', 'bypass', 'stall'] as const;
export type FlowCondition = (typeof FLOW_CONDITIONS)[number];

/** What the watchdog did: told a lead, reported (no safe action), told the owner, or could not (no live session, a refused send). */
/** What holds a program: the Flow pause (`flow.paused`), or Keep going's pause for all or for the program's name. */
export type FlowHold = 'flow' | 'keepgoing';

export const FLOW_ACTIONS = ['told', 'reported', 'notified', 'skipped', 'failed'] as const;
export type FlowActionKind = (typeof FLOW_ACTIONS)[number];

export interface FlowAction {
  at: string;
  program: string;
  condition: FlowCondition;
  kind: FlowActionKind;
  /** The session told (its live continuation), when one was. */
  sessionId: string | null;
  /** The tickets it named (stable ids), at most 20. */
  tickets: string[];
  /** One fixed sentence: what and why (never message text from a session). */
  note: string;
}

export interface FlowProgramView {
  name: string;
  tag: string;
  enabled: boolean;
  /** False when the last round could not read it (the counts are then not zero but unknown). */
  ok: boolean;
  /** The merge-gate lead as configured (or the first lead of the group), and the live session it resolves to now. */
  mergeGate: string | null;
  mergeGateLive: string | null;
  /** The peer leads (configured ids) the program watches. */
  leads: string[];
  counts: Record<FlowCondition, number>;
  inReview: number;
  /** Closed done within the stall window. */
  doneRecent: number;
  /** Held by a pause: counted, nothing sent or notified. Null: not held. */
  paused: FlowHold | null;
  /** The stall began (nothing done while tickets wait in review), or null. */
  stallSince: string | null;
}

export interface FlowSnapshot {
  /** The kill switch `flow.enabled`. */
  enabled: boolean;
  /** The last round, or null before the first one. */
  lastRunAt: string | null;
  programs: FlowProgramView[];
  /** The newest actions first, at most `FLOW_LIMITS.actions`. */
  actions: FlowAction[];
}

export const FLOW_LIMITS = { actions: 5, ticketsPerMessage: 20, kept: 50 } as const;

export const FLOW_SETTING_KEYS = {
  enabled: 'flow.enabled',
  programs: 'flow.programs',
  /** Programs held (comma separated names, or `*` for all): counted, never acted on. */
  paused: 'flow.paused',
  mergeAfterMin: 'flow.mergeAfterMin',
  qaAfterMin: 'flow.qaAfterMin',
  idleAfterMin: 'flow.idleAfterMin',
  repeatMin: 'flow.repeatMin',
  stallHours: 'flow.stallHours',
  notifyAfterHours: 'flow.notifyAfterHours',
} as const;

/** The default program: Konfersi's migration work, its leads the first matching group of `tickets.leadPeerGroups`. */
export const FLOW_DEFAULT_PROGRAMS = 'konfersi|konfersi-migration||';
