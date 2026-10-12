import { headroomFrom, type ChatSession, type ClaudeUsage, type ClaudeUsageWindow, type Headroom, type WindowPace } from '@portal/contracts';
import { leftText, localTime } from '../../../usage/claude/format';
import type { GlanceCompact, GlanceLevel } from '../../types';
import { LEVEL_WORD } from '../../ui';

// The Quota widget's logic, apart from React so it can be checked by hand (PRD glance-widgets §6, PLAN-4 P1/P5).
// Only measured values appear in the chip: the percent a probe read and the reset time Claude Code reported. Speed, pace and the
// projection are estimates and live in the full form, labelled; the chip uses the projection only to turn its dot to `warn`.

export interface Thresholds {
  warn: number;
  critical: number;
}

/** A window as it reads at `nowMs`: once its reset time has passed the number is old, whatever the portal last said. */
export function windowAt(w: ClaudeUsageWindow, nowMs: number): ClaudeUsageWindow {
  return w.resetsAt && Date.parse(w.resetsAt) <= nowMs && w.level !== 'reset' ? { ...w, level: 'reset' } : w;
}

/** What a Claude has left at `nowMs`: the portal's own `headroomFrom`, so the chip, the Claude rows and the switch dialog agree. */
export function headroomAt(c: ClaudeUsage, nowMs: number): Headroom {
  return headroomFrom({ claudeId: c.claudeId, runsOn: c.runsOn, windows: c.windows.map((w) => windowAt(w, nowMs)), checkedAt: c.checkedAt, stale: c.stale });
}

/** The level of a percent used against the person's thresholds (default: the portal's alert levels, 80 and 95). */
export const levelOfUsed = (usedPct: number, th: Thresholds): 'ok' | 'warn' | 'critical' => (usedPct >= th.critical ? 'critical' : usedPct >= th.warn ? 'warn' : 'ok');

/** The Claude's projection says it runs out before it resets (an estimate; absent on a portal that does not send it). */
export const projectedOver = (c: ClaudeUsage): boolean => c.outlook?.status?.basis === 'estimate' && c.outlook.status.value === 'over';

/** How one Claude reads: its level (thresholds applied), the percent left of the window that limits it, and the headroom behind. */
export interface QuotaReading {
  claude: ClaudeUsage;
  headroom: Headroom;
  level: GlanceLevel;
  /** Percent left of the fullest window; null without a plan reading. 0 once it is used up. */
  leftPct: number | null;
  over: boolean;
}

export function readClaude(c: ClaudeUsage, nowMs: number, th: Thresholds): QuotaReading {
  const h = headroomAt(c, nowMs);
  const over = h.kind === 'plan' && projectedOver(c);
  let level: GlanceLevel;
  if (h.kind === 'no_limits') level = 'idle';
  else if (h.kind !== 'plan' || !h.limiting) level = 'unknown';
  else if (h.exhausted) level = 'critical';
  else {
    level = levelOfUsed(h.limiting.usedPct, th);
    // Not yet near, but at today's speed it will not last until the reset: look soon (an estimate, the title says so).
    if (over && level === 'ok') level = 'warn';
  }
  return { claude: c, headroom: h, level, leftPct: h.kind === 'plan' && h.limiting ? (h.exhausted ? 0 : h.limiting.leftPct) : null, over };
}

/**
 * Whether the viewer may USE this Claude, not just see its numbers. The portal returns a viewer only the Claudes they may see; once
 * a row also says what the viewer may do (accounts, round 10), a Claude they can only look at is never their active one. Today
 * the one owner may use every listed Claude.
 */
export const mayUse = (_c: ClaudeUsage): boolean => true;

/**
 * The ACTIVE Claude: the open session's, else the one used most recently, else (nothing known about use) the first that has plan
 * limits, else the first; always one of the Claudes the portal listed for this viewer that they may use. An id that is not among
 * them (a stale focus, a Claude since unshared) is ignored. Null when there is none.
 */
export function pickActive(claudes: readonly ClaudeUsage[], focusClaudeId: string | null, recentClaudeId: string | null): ClaudeUsage | null {
  const mine = claudes.filter(mayUse);
  const by = (id: string | null) => (id ? mine.find((c) => c.claudeId === id) : undefined);
  return by(focusClaudeId) ?? by(recentClaudeId) ?? mine.find((c) => c.state === 'ok' || c.state === 'near' || c.state === 'exhausted') ?? mine[0] ?? null;
}

/** The Claude of the most recently active session that has one (archived sessions do not count). Pure, for the check. */
export function recentClaudeOf(sessions: readonly Pick<ChatSession, 'claudeId' | 'lastActivityAt' | 'archivedAt'>[]): string | null {
  let best: { id: string; at: number } | null = null;
  for (const s of sessions) {
    if (!s.claudeId || s.archivedAt) continue;
    const at = Date.parse(s.lastActivityAt);
    if (Number.isFinite(at) && (!best || at > best.at)) best = { id: s.claudeId, at };
  }
  return best?.id ?? null;
}

/**
 * "28 %": the percent left of the window that limits, whole. "0 %" only when nothing is left, "<1 %" for a sliver (0.4 left is not
 * rounded up to a 1 that was not read), "-" when there is no plan reading.
 */
export function leftText100(r: QuotaReading): string {
  if (r.leftPct === null) return '-';
  if (r.leftPct <= 0) return '0 %';
  if (r.leftPct < 0.5) return '<1 %';
  return `${Math.round(r.leftPct)} %`;
}

/** The chip's sentence: the state in words, the basis in it ("est." for a projection), no number that was not read. */
export function titleOf(r: QuotaReading, nowMs: number, scope: string | null = null): string {
  const who = `Quota, ${r.claude.claudeName}${scope ? ` (${scope})` : ''}`;
  const h = r.headroom;
  if (h.kind === 'no_limits') return `${who}: no plan limits`;
  if (h.kind === 'signed_out') return `${who}: not signed in`;
  if (h.kind !== 'plan' || !h.limiting) return `${who}: not read yet`;
  if (h.exhausted) return `${who}: used up${h.availableAt ? `, back ${localTime(h.availableAt, nowMs)}` : ''}`;
  const reset = h.limiting.resetsAt ? `, resets ${localTime(h.limiting.resetsAt, nowMs)} (in ${leftText(h.limiting.resetsAt, nowMs)})` : '';
  const old = h.stale ? ', old reading' : '';
  const proj = r.over ? ', projected to run out before the reset (est.)' : '';
  return `${who}: ${leftText100(r)} left of ${h.limiting.label}${reset}, ${LEVEL_WORD[r.level]}${proj}${old}`;
}

export interface QuotaInput {
  claudes: readonly ClaudeUsage[] | null;
  failed: boolean;
  focusClaudeId: string | null;
  recentClaudeId: string | null;
  mode: 'active' | 'all';
  nowMs: number;
  thresholds: Thresholds;
}

/**
 * The Claude the chip and the top of the full form are about: the active one, or in all-Claudes mode (with more than one) the one
 * with the least left of those that have a plan reading, so the chip and the form always say the same thing. `scope` says so in
 * words for the chip's title.
 */
export function leadClaude(i: Pick<QuotaInput, 'claudes' | 'focusClaudeId' | 'recentClaudeId' | 'mode' | 'nowMs' | 'thresholds'>): { reading: QuotaReading; scope: string | null } | null {
  if (!i.claudes) return null;
  const active = pickActive(i.claudes, i.focusClaudeId, i.recentClaudeId);
  if (!active) return null;
  const own = readClaude(active, i.nowMs, i.thresholds);
  if (i.mode === 'all' && i.claudes.length > 1) {
    const plans = i.claudes.filter(mayUse).map((c) => readClaude(c, i.nowMs, i.thresholds)).filter((r) => r.leftPct !== null);
    const least = plans.reduce<QuotaReading | null>((a, b) => (!a || b.leftPct! < a.leftPct! || (b.leftPct === a.leftPct && b.claude.claudeId === active.claudeId) ? b : a), null);
    if (least) return { reading: least, scope: `least left of ${plans.length} plans` };
  }
  return { reading: own, scope: null };
}

/** The compact form: percent left of the active Claude, or (all-Claudes mode) of the one with the least left. */
export function quotaCompact(i: QuotaInput): GlanceCompact {
  if (!i.claudes) return i.failed ? { value: '-', level: 'unknown', title: 'Quota: could not load' } : { value: null, level: 'unknown', title: 'Quota: loading', loading: true };
  const lead = leadClaude(i);
  if (!lead) return { value: '-', level: 'unknown', title: 'Quota: no Claudes' };
  const { reading: shown, scope } = lead;
  const value = shown.headroom.kind === 'no_limits' ? null : shown.leftPct === null ? '-' : leftText100(shown);
  return { value, level: shown.level, title: titleOf(shown, i.nowMs, scope), stale: shown.headroom.stale || shown.claude.stale };
}

/** One window as the full form draws it: the reading as it stands now, its level by the person's thresholds, its pace when the portal sent it. */
export interface WindowView {
  key: string;
  label: string;
  /** Percent used; null when there is no number or the window has reset (the number is old). */
  usedPct: number | null;
  level: GlanceLevel;
  resetsAt: string | null;
  /** Its reset time has passed: the number is old. */
  reset: boolean;
  pace: WindowPace | undefined;
}

export function windowViews(c: ClaudeUsage, nowMs: number, th: Thresholds): WindowView[] {
  return c.windows.map((raw) => {
    const w = windowAt(raw, nowMs);
    const reset = w.level === 'reset';
    const usedPct = reset ? null : w.usedPct;
    return { key: w.key, label: w.label, usedPct, reset, resetsAt: w.resetsAt, pace: reset ? undefined : w.pace, level: reset || usedPct === null ? 'unknown' : levelOfUsed(usedPct, th) };
  });
}

/** The window whose pace the full form opens first: the one the projection is about, else the fullest that has a number. */
export function leadWindowKey(c: ClaudeUsage, views: readonly WindowView[]): string | null {
  const decisive = c.outlook?.window?.key;
  if (decisive && views.some((v) => v.key === decisive)) return decisive;
  const live = views.filter((v) => v.usedPct !== null);
  return live.length ? live.reduce((a, b) => (b.usedPct! > a.usedPct! ? b : a)).key : null;
}
