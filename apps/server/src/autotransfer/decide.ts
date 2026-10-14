// Auto transfer: THE decision (docs/prd/auto-transfer.md §9), a pure function. Given a chat at its turn boundary, the usage snapshot
// (`ClaudeUsageMonitor.report().claudes`), the Move flow's own verdict (`switchOptions`), the safeguards' counters and the effective settings,
// it says what to do: nothing (with the code), warn, suggest (a card), wait (busy) or move (with the handoff). It never reads a clock, a
// database or a workspace: the engine gathers the inputs and acts on the answer, so every case of §14 is a test over fixtures.
//
// Numbers keep their basis: a percent left is measured (Claude Code reported it); a projection is an estimate (`Figure`).

import {
  ALL_MODEL_WINDOWS,
  AUTO_CONSTANTS,
  downgradeChain,
  estimatedFigure,
  isWindowOfFamily,
  modelFamilyOf,
  modelInfo,
  measuredFigure,
  unavailableFigure,
  usageUnavailable,
  type AutoClaudeRef,
  type AutoFacts,
  type AutoLimit,
  type AutoMode,
  type AutoReason,
  type AutoRefusal,
  type AutoTransferSettings,
  type ChatSession,
  type ChatSwitchOptions,
  type ClaudeUsage,
  type ClaudeUsageWindow,
  type MoveCandidate,
  type MoveRecommendation,
  type UnavailableReason,
} from '@portal/contracts';

import { ROOM_PCT } from '../claudeusage/recommend.js';

const MIN = 60_000;

/** U1a's ranking, injected (the engine passes `recommendMove` from claudeusage/recommend.ts; its signature is kept as is). */
export type RecommendFn = (claudes: ClaudeUsage[], opts: { workspaceId: string; from?: string | null; nowMs: number; allow?: (claudeId: string) => boolean }) => MoveRecommendation;

/** The effective mode (FR1): the chat's override, else the user's choice, else the platform's, never above the platform's ceiling. */
export function effectiveMode(platform: AutoMode, user: AutoMode | null, session: AutoMode | null): AutoMode {
  if (platform === 'off') return 'off';
  const wanted = session ?? user ?? platform;
  if (wanted === 'auto' && platform !== 'auto') return 'ask';
  return wanted;
}

/** The family of a model id from the catalogue (T-109): `fable`, `opus`, `sonnet`, `haiku` (`claude-fable-5-1`, `sonnet[1m]`), or null. */
export const modelFamily = modelFamilyOf;

/** Whether a usage window is the per-model window of a model family (`week_opus`, `model:fable`, `model:claude-opus-4`). */
export const windowOfFamily = (key: string, family: string | null): boolean => isWindowOfFamily(key, family);

/**
 * Whether a Claude can run a model family (T-109): what its `list_models` said (`listed`, when known), else the catalogue: a family every
 * plan has (`assumed`) yes, one only some plans have (Fable) only when the Claude shows that family's usage window. A family the catalogue
 * doesn't know is judged as before (yes).
 */
export function claudeHasFamily(u: Pick<ClaudeUsage, 'windows'> | undefined, family: string | null, listed: boolean | null): boolean {
  if (listed !== null) return listed;
  const info = modelInfo(family);
  if (!info || info.assumed) return true;
  return !!u?.windows.some((w) => isWindowOfFamily(w.key, family));
}

/** Where the source Claude stands for THIS chat (FR5, FR6): the windows that stop it, the fullest of them, and why a move is wanted. */
export interface SourceReading {
  /** The window with the least left among those that stop this chat. */
  window: ClaudeUsageWindow;
  leftPct: number;
  reason: AutoReason | null;
  facts: AutoFacts;
  /** That window stops every model on the Claude (`shared`: the session, the week) or only the chat's model (`model`). */
  limit: AutoLimit;
  /** The least left over the shared windows alone (null when none has a number): what a model change on this Claude would still have. */
  sharedLeftPct: number | null;
  /** D-39: at the threshold, held back by the pace rule (projected under `paceMinPct` at the reset). */
  paceHold?: boolean;
}

/** Whether a window stops every model (`session`, `week`) rather than one model's own. */
export const sharedWindow = (key: string): boolean => ALL_MODEL_WINDOWS.includes(key);

/**
 * What a Claude has left for a chat on model `family` (FR6, T-29): the least left over its live shared windows and that model's own windows.
 * Null when none of them has a number. A Claude with a lot of shared room but its Opus week used up has nothing left for an Opus chat.
 */
export function leftFor(c: Pick<ClaudeUsage, 'windows'>, family: string | null, nowMs: number): number | null {
  const ws = c.windows.filter((w) => live(w, nowMs) && (sharedWindow(w.key) || windowOfFamily(w.key, family)));
  if (!ws.length) return null;
  return Math.max(0, round1(Math.min(...ws.map((w) => (w.level === 'exhausted' ? 100 : w.usedPct!)).map((u) => 100 - u))));
}

/** A window that has a number and has not reset (a reset, an unknown level or a reset time in the past leaves it out). */
const live = (w: ClaudeUsageWindow, nowMs: number) =>
  w.usedPct !== null && w.level !== 'reset' && w.level !== 'unknown' && !(w.resetsAt && Date.parse(w.resetsAt) <= nowMs);

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Why a destination's usage is UNKNOWN for a chat on model `family` (T-255), or null when it is measured. Unknown: no reading, a reading
 * Claude Code could not give (not signed in, no usage endpoint, no reset time on the session window: see `usageUnavailable`), a stale
 * reading, or no live window that would stop the chat there, or one of those without a reset time. An unknown Claude is never preferred to
 * a measured one: Claude Code shows 0 % with no reset time even for an account already at its limit (2026-10-13).
 */
export function unknownUsage(u: ClaudeUsage | undefined, family: string | null, nowMs: number): UnavailableReason | null {
  if (!u || !u.checkedAt) return 'no_reading';
  const why = usageUnavailable(u, nowMs);
  if (why) return why;
  if (!freshReading(u, nowMs)) return 'stale';
  const ws = u.windows.filter((w) => live(w, nowMs) && (sharedWindow(w.key) || windowOfFamily(w.key, family)));
  if (!ws.length) return 'no_number';
  if (ws.some((w) => !w.resetsAt)) return 'no_reset_time';
  return null;
}

/** A candidate whose usage is unknown (T-255): it keeps its place in the ranking's order, after every measured one; why is on `leftPct`. */
export const isUnknown = (c: Pick<MoveCandidate, 'reason'>): boolean => c.reason === 'unknown';

/** Whether a reading is fresh enough to act on: read at most 15 minutes ago and not stale. */
export function freshReading(c: Pick<ClaudeUsage, 'checkedAt' | 'stale'>, nowMs: number): boolean {
  if (!c.checkedAt || c.stale) return false;
  const at = Date.parse(c.checkedAt);
  return Number.isFinite(at) && nowMs - at <= AUTO_CONSTANTS.maxReadingAgeMin * MIN && at <= nowMs + MIN;
}

/**
 * The source's limit for a chat on `model`: `session` and `week`, and the chat's own model window. `leftPct` is the smallest `100 − used`.
 * `exhausted` when one of them is at 100 %; `low` at or under the threshold; `projection` when on, confident, within 2 hours and at most 30 % left.
 * Null when no window applies (no number yet).
 */
export function sourceReading(
  c: ClaudeUsage,
  model: string | null,
  thresholdPct: number,
  useProjection: boolean,
  nowMs: number,
  pace: { respect: boolean; minPct: number } = { respect: false, minPct: 90 },
): SourceReading | null {
  const family = modelFamily(model);
  const windows = c.windows.filter((w) => live(w, nowMs) && (ALL_MODEL_WINDOWS.includes(w.key) || windowOfFamily(w.key, family)));
  if (!windows.length) return null;
  const window = windows.reduce((a, b) => (b.usedPct! > a.usedPct! ? b : a));
  const leftPct = Math.max(0, round1(100 - window.usedPct!));
  const exhausted = windows.some((w) => w.usedPct! >= 100 || w.level === 'exhausted');
  const facts: AutoFacts = {
    leftPct: measuredFigure(leftPct),
    thresholdPct,
    resetsAt: window.resetsAt ? measuredFigure(window.resetsAt) : unavailableFigure('no_reset_time'),
  };
  let reason: AutoReason | null = null;
  let paceHold = false;
  if (exhausted) reason = 'exhausted';
  else if (leftPct <= thresholdPct) {
    reason = 'low';
    // D-39: at the threshold the chat moves only when the binding window is projected to reach `minPct` by its reset (the projection the
    // usage summary shows: its pace, when confident). No confident projection: the threshold alone decides, and the facts say so.
    if (pace.respect) {
      const p = window.pace;
      const projected = p && !p.lowConfidence && p.projectedPct.value !== null ? p.projectedPct.value : null;
      if (projected === null) facts.pace = { verdict: 'unavailable', minPct: pace.minPct };
      else {
        facts.projectedPct = estimatedFigure(projected);
        if (p!.etaAt.value !== null) facts.etaAt = estimatedFigure(p!.etaAt.value);
        const under = projected < pace.minPct;
        facts.pace = { verdict: under ? 'under' : 'over', minPct: pace.minPct };
        if (under) (reason = null), (paceHold = true);
      }
    }
  }
  else if (useProjection && !paceHold && leftPct <= AUTO_CONSTANTS.projectionMaxLeftPct) {
    // The window that runs out first at its pace, among those that stop the chat, counts only with confidence and within the horizon.
    let best: { eta: number; w: ClaudeUsageWindow } | null = null;
    for (const w of windows) {
      const p = w.pace;
      if (!p || p.lowConfidence || p.status.value !== 'over' || p.etaAt.value === null) continue;
      const eta = Date.parse(p.etaAt.value);
      if (!Number.isFinite(eta) || eta - nowMs > AUTO_CONSTANTS.projectionHorizonMin * MIN) continue;
      if (!best || eta < best.eta) best = { eta, w };
    }
    if (best) {
      reason = 'projection';
      facts.etaAt = estimatedFigure(best.w.pace!.etaAt.value!);
      if (best.w.pace!.projectedPct.value !== null) facts.projectedPct = estimatedFigure(best.w.pace!.projectedPct.value);
    }
  }
  const limit: AutoLimit = { key: window.key, label: window.label, kind: sharedWindow(window.key) ? 'shared' : 'model' };
  facts.limit = limit;
  const shared = windows.filter((w) => sharedWindow(w.key));
  const sharedLeftPct = shared.length ? Math.max(0, round1(Math.min(...shared.map((w) => (w.level === 'exhausted' ? 0 : 100 - w.usedPct!))))) : null;
  return { window, leftPct, reason, facts, limit, sharedLeftPct, paceHold };
}

/** What the engine knows about a chat's history of moves (from its own rows), for the safeguards and the guards on the choice. */
export interface DecideCounters {
  /** "Later", an Undo, a failure or a move set it. */
  pausedUntilMs: number | null;
  /** The chat's last move (by this feature or by a person), for the minimum pause. */
  lastMoveMs: number | null;
  /** Moves this feature made for the chat in the last 24 hours. */
  movesSession24h: number;
  /** Moves this feature made for the chat's owner, all chats, in the last 24 hours. */
  movesOwner24h: number;
  /** Failed automatic moves of the chat in the last 24 hours (two end automatic moves for it that day). */
  failures24h: number;
  /** When an automatic move started waiting for a quiet boundary. */
  deferSinceMs: number | null;
  /** Claudes this chat left by a move, with when, and when the window that pushed it out resets (the ping-pong guard). */
  left: { claudeId: string; atMs: number; resetsAtMs: number | null }[];
}

export interface DecideInput {
  nowMs: number;
  mode: AutoMode;
  /** The effective values for the chat's owner (the platform's caps, the user's choices). */
  settings: AutoTransferSettings;
  /** The source Claude's own threshold (`AutoClaudeConfig`), null for the effective one. */
  claudeThresholdPct: number | null;
  /** The source Claude's ordered destinations: an allowlist when not empty. */
  destinations: string[];
  session: Pick<ChatSession, 'id' | 'workspaceId' | 'claudeId' | 'model' | 'state' | 'mode' | 'switching'>;
  /** The workspace runs on an account pool. */
  pooled: boolean;
  /** The usage snapshot's Claudes (any workspace: the function keeps the chat's). */
  claudes: ClaudeUsage[];
  /** The chat's owner is an enabled user who may operate the chat. */
  ownerOk: boolean;
  /** Whether the owner may use a Claude (`can(owner, 'operate', claude)`), passed to `recommendMove` as `allow`. */
  allow: (claudeId: string) => boolean;
  /** The Move flow's verdict for this chat; null when it could not be asked (then no Claude qualifies). */
  options: ChatSwitchOptions | null;
  /** Live sessions per Claude, counting a move on its way. */
  load: (claudeId: string) => number;
  counters: DecideCounters;
  recommend: RecommendFn;
  /** What a Claude's `list_models` said about a family (T-109), null when not known (then the catalogue and the usage windows decide). */
  listed?: (claudeId: string, family: string) => boolean | null;
}

export interface DecideChoice {
  reason: AutoReason;
  to: AutoClaudeRef;
  alternatives: AutoClaudeRef[];
  facts: AutoFacts;
  handoff: 'ask' | 'skip';
  dropped: { approvals: number; queued: number; agents: number };
  /** The source's window and its period, for "warn once". */
  period: string;
}

export type Decision =
  | { act: 'none'; code: AutoRefusal; reading: SourceReading | null }
  | { act: 'warn'; code: 'no_destination' | 'destination_busy'; reading: SourceReading; period: string }
  /** `why`: an `auto` chat that only gets a card (Bypass, the deferral ran out, two failures today), else null for `ask`. */
  | ({ act: 'suggest'; why: 'bypass' | 'deferred' | 'failed_today' | null; reading: SourceReading } & DecideChoice)
  | ({ act: 'wait'; code: 'busy'; reading: SourceReading } & DecideChoice)
  | ({ act: 'move'; reading: SourceReading } & DecideChoice);

const ref = (c: MoveCandidate): AutoClaudeRef => ({ id: c.claudeId, name: c.name });
const ZERO = { approvals: 0, queued: 0, agents: 0 };

/** The candidates that qualify (FR7 to FR9), best first, and those only `ask` may list; and whether any was skipped only for being full. */
export function candidates(
  input: DecideInput,
  mode: 'ask' | 'auto',
  family: string | null = modelFamily(input.session.model),
): { eligible: MoveCandidate[]; alternatives: MoveCandidate[]; full: boolean } {
  const { session, settings, nowMs } = input;
  const rec = input.recommend(input.claudes, { workspaceId: session.workspaceId, from: session.claudeId, nowMs, allow: input.allow });
  const ok = new Set((input.options?.options ?? []).filter((o) => o.ok).map((o) => o.claude.id));
  const threshold = input.claudeThresholdPct ?? settings.thresholdPct;
  const usage = new Map(input.claudes.map((c) => [c.claudeId, c]));
  const allow = new Set(input.destinations);
  let full = false;
  const pass = (c: MoveCandidate): boolean => {
    const unknown = isUnknown(c);
    if (!ok.has(c.claudeId) || !input.allow(c.claudeId)) return false;
    if (allow.size && !allow.has(c.claudeId)) return false;
    const u = usage.get(c.claudeId);
    // The Claude must be able to run the model at all (T-109): a Fable chat never goes to a Claude without Fable on its own model; such a
    // Claude is a candidate only with a model it has (the downgrade chain, below).
    if (family && c.reason !== 'no_limits' && !(unknown && !u) && !claudeHasFamily(u, family, input.listed?.(c.claudeId, family) ?? null)) return false;
    if (c.reason === 'no_limits') {
      if (!settings.allowApiKey || settings.sameModelOnly) return false; // what a key's model availability is, the portal can't see
    } else if (!unknown && (!u || !freshReading(u, nowMs))) return false;
    // The chat's model must have room there (T-29): its own window at or under the threshold would stop it again at once, whatever the
    // shared windows say. A model whose family is unknown is judged on the shared windows only, as before.
    if (c.reason !== 'no_limits' && u && family) {
      const left = leftFor(u, family, nowMs);
      if (left !== null && left <= threshold) return false;
    }
    if (settings.sameModelOnly && c.reason !== 'no_limits') {
      // The family must be known, and its own window on the destination not used up.
      if (!family || (!u && !unknown)) return false;
      if (u?.windows.some((w) => windowOfFamily(w.key, family) && live(w, nowMs) && (w.level === 'exhausted' || w.usedPct! >= 100))) return false;
    }
    // Ping-pong: a Claude the chat left in the last 4 hours, unless the window that pushed it out has reset since.
    const left = input.counters.left.find((l) => l.claudeId === c.claudeId && nowMs - l.atMs < AUTO_CONSTANTS.pingPongMin * MIN);
    if (left && !(left.resetsAtMs !== null && left.resetsAtMs <= nowMs)) return false;
    if (input.load(c.claudeId) >= settings.maxPerDestination) {
      full = true;
      return false;
    }
    return true;
  };
  const best = (mode === 'auto' ? ['room', 'no_limits'] : ['room', 'over_pace', 'no_limits']) as MoveCandidate['reason'][];
  // The ranking judges a Claude by its fullest window of all; for THIS chat only the shared windows and its model's own count (T-29): a
  // Claude whose Opus week is full has room for a Sonnet chat. Re-classed on what is left for the chat's model, then ordered by it (the
  // ranking's order breaks ties, so its pace and reset rules still decide between equals).
  const forChat = (c: MoveCandidate): MoveCandidate => {
    const u = usage.get(c.claudeId);
    if (c.reason === 'no_limits' || !u || !family || (c.reason !== 'room' && c.reason !== 'over_pace' && c.reason !== 'tight')) return c;
    const left = leftFor(u, family, nowMs);
    if (left === null) return c;
    const reason: MoveCandidate['reason'] = left < ROOM_PCT ? 'tight' : c.reason === 'over_pace' ? 'over_pace' : 'room';
    return { ...c, reason, leftPct: measuredFigure(left) };
  };
  // The ranking's shape kept (room first, then Claudes without plan limits, then tight), each part by what it leaves the chat, ties in
  // the ranking's own order (stable sort).
  const byLeft = (a: MoveCandidate, b: MoveCandidate) => (b.leftPct.value ?? -1) - (a.leftPct.value ?? -1);
  // T-255: a Claude whose usage is unknown for this chat (no reading, no reset time, stale) is taken out of the measured ranking and
  // listed after every measured candidate, with why on its `leftPct`: it is chosen only when no measured one qualifies.
  const unknowns: MoveCandidate[] = [];
  const all = rec.candidates
    .filter((c) => c.rank !== null || c.reason === 'unknown')
    .filter((c) => {
      if (c.reason === 'no_limits') return true;
      const why = c.reason === 'unknown' ? (unknownUsage(usage.get(c.claudeId), family, nowMs) ?? 'no_reading') : unknownUsage(usage.get(c.claudeId), family, nowMs);
      if (!why) return true;
      unknowns.push({ ...c, reason: 'unknown', basis: 'unavailable', rank: null, recommended: false, leftPct: unavailableFigure(why) });
      return false;
    })
    .map(forChat);
  const ranked = [
    ...all.filter((c) => c.reason === 'room' || c.reason === 'over_pace').sort(byLeft),
    ...all.filter((c) => c.reason === 'no_limits'),
    ...all.filter((c) => c.reason === 'tight').sort(byLeft),
  ];
  let eligible = ranked.filter((c) => best.includes(c.reason) && pass(c));
  const alternatives = mode === 'ask' ? ranked.filter((c) => c.reason === 'tight' && pass(c)) : [];
  const pos = (id: string) => input.destinations.indexOf(id);
  // The allowlist's order among the eligible; the ranking breaks ties (it cannot: ids are unique, but the sort is stable).
  if (allow.size) eligible = [...eligible].sort((a, b) => pos(a.claudeId) - pos(b.claudeId));
  const unknownOk = unknowns.filter(pass);
  if (allow.size) unknownOk.sort((a, b) => pos(a.claudeId) - pos(b.claudeId));
  eligible = [...eligible, ...unknownOk];
  return { eligible, alternatives, full: full && !eligible.length };
}

/**
 * The source window period (§9, FR10, FR10a, FR6b): the Claude, the window and its reset ROUNDED TO THE MINUTE. The probe's reset time
 * jitters by milliseconds between readings of one window (06:00:00.000Z, .119Z, .267Z live, T-280), and with the raw value every probe
 * was a new period: the chat was steered (and warned) again. A minute matches the usage module's own "same period" tolerance
 * (`SAME_PERIOD_MS`). The reason (`low`, `projection`) is not part of it: one steer per window, whatever the reason.
 */
export function windowPeriod(claudeId: string, window: Pick<ClaudeUsageWindow, 'key' | 'resetsAt'>): string {
  const t = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const reset = Number.isFinite(t) ? new Date(Math.round(t / MIN) * MIN).toISOString() : (window.resetsAt ?? '');
  return `${claudeId}|${window.key}|${reset}`;
}

/** The decision, in the order of §9: each step stops the evaluation with its code. */
export function decide(input: DecideInput): Decision {
  const { session, settings, nowMs, counters } = input;
  // 1. The mode.
  if (input.mode === 'off') return { act: 'none', code: 'mode_off', reading: null };
  // 2. A pool, or a Claude with no plan reading.
  if (input.pooled) return { act: 'none', code: 'pooled', reading: null };
  const source = input.claudes.find((c) => c.claudeId === session.claudeId);
  if (!source || source.runsOn !== 'plan' || !source.checkedAt) return { act: 'none', code: 'no_plan_reading', reading: null };
  const threshold = input.claudeThresholdPct ?? settings.thresholdPct;
  const reading = sourceReading(source, session.model, threshold, settings.useProjection, nowMs, { respect: settings.respectPace, minPct: settings.paceMinPct });
  if (!reading) return { act: 'none', code: 'no_plan_reading', reading: null };
  // 3. A fresh reading.
  if (!freshReading(source, nowMs)) return { act: 'none', code: 'stale_reading', reading };
  // 4. A reason.
  if (!reading.reason) return { act: 'none', code: reading.paceHold ? 'pace_under' : 'above_threshold', reading };
  // 5. The owner.
  if (!input.ownerOk) return { act: 'none', code: 'owner_denied', reading };
  // 6. The safeguards. Not for a source already out of quota (R2, T-105): the chat can do nothing there, so it moves at once, pause and
  // caps or not; the ping-pong guard (step 7) still keeps it off the Claude it just left. The caps count only moves that were not forced.
  const forced = reading.reason === 'exhausted';
  if (!forced) {
    if (counters.pausedUntilMs !== null && counters.pausedUntilMs > nowMs) return { act: 'none', code: 'paused', reading };
    if (counters.lastMoveMs !== null && nowMs - counters.lastMoveMs < settings.minPauseMin * MIN) return { act: 'none', code: 'paused', reading };
    if (counters.movesSession24h >= settings.maxPerSessionPerDay) return { act: 'none', code: 'session_cap', reading };
    if (counters.movesOwner24h >= settings.maxPerDay) return { act: 'none', code: 'day_cap', reading };
  }
  // 7. A destination.
  const period = windowPeriod(session.claudeId, reading.window);
  // A chat in Bypass (unless the platform allows moving those: `allowBypass`, the owner's ask of 2026-10-13; the move keeps Bypass),
  // or one whose automatic moves failed twice today, only ever gets a card: rank it as `ask` would.
  const bypass = session.mode === 'bypassPermissions' && !settings.allowBypass;
  const failedToday = counters.failures24h >= 2;
  const autoish = input.mode === 'auto' && !bypass && !failedToday;
  const family = modelFamily(session.model);
  const usage = new Map(input.claudes.map((c) => [c.claudeId, c]));
  // T-255: a Claude with unknown usage is taken only by a chat that can do nothing where it is (exhausted): one that is merely low waits
  // for a measured destination rather than gamble on a Claude that may be at its limit already.
  const forced0 = reading.reason === 'exhausted';
  const pick = (f: string | null) => {
    const r = candidates(input, autoish ? 'auto' : 'ask', f);
    return forced0 ? r : { ...r, eligible: r.eligible.filter((c) => !isUnknown(c)) };
  };
  const { eligible, alternatives, full } = pick(family);
  const fallbacks = settings.modelFallback.filter((f) => f !== family);
  // The options (T-29): keep the model and move; change model here (only when the limit is the model's own and the shared windows have
  // room); move with another model (only when no Claude has room on this one). `keepModelFirst` orders the first two.
  // T-255: a Claude with unknown usage is the last resort, after a model change here and a measured Claude on another model.
  const keep = eligible[0] ?? null;
  const keepUnknown = !!keep && isUnknown(keep);
  let here: { model: string; left: number } | null = null;
  if (reading.limit.kind === 'model' && reading.sharedLeftPct !== null && reading.sharedLeftPct > threshold) {
    for (const f of fallbacks) {
      const left = leftFor(source, f, nowMs);
      if (left !== null && left > threshold) {
        here = { model: f, left };
        break;
      }
    }
  }
  let other: { pick: MoveCandidate; model: string } | null = null;
  if (!keep || keepUnknown) {
    // Move with another model (T-109): the best one at or below the chat's by the catalogue's rank (Fable, then Opus, Sonnet, Haiku), or
    // the owner's order in `automove.modelFallback`; never a model above the chat's. With "Same model" on, only the owner's own list.
    const chain = settings.sameModelOnly ? fallbacks : downgradeChain(family, settings.modelFallback).filter((x) => x !== family);
    let unknownOther: { pick: MoveCandidate; model: string } | null = null;
    for (const f of chain) {
      const list = pick(f).eligible;
      const c = list.find((x) => !isUnknown(x));
      if (c) {
        other = { pick: c, model: f };
        break;
      }
      if (!unknownOther && list[0]) unknownOther = { pick: list[0], model: f };
    }
    // With the chat's own model only on an unknown Claude, that one comes before an unknown one on a lesser model.
    if (!other && !keep) other = unknownOther;
  }
  const order = keepUnknown
    ? (['here', 'other', 'keep'] as const)
    : settings.keepModelFirst
      ? (['keep', 'here', 'other'] as const)
      : (['here', 'keep', 'other'] as const);
  const chosen = order.find((o) => (o === 'keep' ? keep : o === 'here' ? here : other));
  if (!chosen) return { act: 'warn', code: full ? 'destination_busy' : 'no_destination', reading, period };
  const facts: AutoFacts = { ...reading.facts };
  const destLeft = (c: MoveCandidate, f: string | null) => {
    if (c.reason === 'no_limits') return;
    if (isUnknown(c)) {
      facts.destLeftPct = c.leftPct.basis === 'unavailable' ? c.leftPct : unavailableFigure('no_reading');
      return;
    }
    const u = usage.get(c.claudeId);
    const left = u ? leftFor(u, f, nowMs) : null;
    const value = left ?? c.leftPct.value;
    if (value !== null) facts.destLeftPct = measuredFigure(value);
  };
  let to: AutoClaudeRef;
  let alts: MoveCandidate[];
  if (chosen === 'here') {
    to = { id: session.claudeId, name: source.claudeName, model: here!.model };
    facts.destLeftPct = measuredFigure(here!.left);
    alts = eligible;
  } else if (chosen === 'keep') {
    to = ref(keep!);
    destLeft(keep!, family);
    alts = [...eligible.slice(1), ...alternatives];
  } else {
    to = { ...ref(other!.pick), model: other!.model };
    destLeft(other!.pick, other!.model);
    alts = alternatives;
  }
  // A model change in place keeps the conversation: no handoff, nothing dropped.
  const inPlace = to.id === session.claudeId;
  const handoff: 'ask' | 'skip' = inPlace || reading.reason === 'exhausted' || input.options?.handoff.ok === false ? 'skip' : 'ask';
  const choice: DecideChoice = {
    reason: reading.reason,
    to,
    alternatives: alts.map(ref),
    facts,
    handoff,
    dropped: inPlace ? ZERO : (input.options?.dropped ?? ZERO),
    period,
  };
  // 8. `ask`: the card.
  if (input.mode === 'ask') return { act: 'suggest', why: null, reading, ...choice };
  // 9. `auto`: not Bypass unless allowed (a model change in place leaves Bypass as it is: allowed); not after two failures today; only at a
  // quiet boundary, else wait (up to 30 minutes), then a card.
  if (bypass && !inPlace) return { act: 'suggest', why: 'bypass', reading, ...choice };
  if (failedToday) return { act: 'suggest', why: 'failed_today', reading, ...choice };
  const d = choice.dropped;
  const quiet = session.state === 'idle' && !session.switching && d.approvals === 0 && d.queued === 0 && d.agents === 0;
  if (!quiet) {
    // A turn that runs (or sub-agents that do) is waited for however long it takes: the chat is told to finish its step and stop (T-105
    // item 2, the engine's steer) and moves at the boundary. Only an idle chat held by an open approval or a queue becomes a card after 30 minutes.
    const turnRuns = session.state === 'working';
    if (!turnRuns && counters.deferSinceMs !== null && nowMs - counters.deferSinceMs >= AUTO_CONSTANTS.deferMaxMin * MIN) return { act: 'suggest', why: 'deferred', reading, ...choice };
    return { act: 'wait', code: 'busy', reading, ...choice };
  }
  // 10. The move.
  return { act: 'move', reading, ...choice };
}
