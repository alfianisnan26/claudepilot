import { zonedTime, type ClaudeUsage, type ClaudeUsageState, type ClaudeUsageWindow, type Headroom, type UsageLevel } from '@portal/contracts';

/** "2 h 10 m", "3 d 4 h", "12 m", "<1 m": how long until `iso`, from `nowMs`. Empty when there is no time. */
export function leftText(iso: string | null, nowMs: number): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - nowMs;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1 m';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d >= 1) return h ? `${d} d ${h} h` : `${d} d`;
  if (h >= 1) return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
  return `${m} m`;
}

/**
 * The time on this device's clock: "14:20" today, "Tue 09:00" within a week, else "15 Oct 09:00". The one formatter the Inbox and the
 * notifications use too (`zonedTime`, T-126), so the same fact reads the same everywhere.
 */
export function localTime(iso: string | null, nowMs: number = Date.now()): string {
  return zonedTime(iso, nowMs);
}

/** "12 m ago", "3 h ago", "2 d ago". */
export function agoText(iso: string | null, nowMs: number): string {
  if (!iso) return '';
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} m ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / 1440)} d ago`;
}

/** "41 %", "—" without a number. Above 100 stays as it is. */
export const pctText = (v: number | null): string => (v === null ? '—' : `${Math.round(v)} %`);

/** "Max", "Pro": the tier name as Claude Code says it, capitalised. */
export const planText = (plan: string | null): string => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '');

/** The colour a level reads in: accent, gold, red, or quiet. */
export type Tone = 'ok' | 'gold' | 'danger' | 'quiet';
export const toneOf = (level: UsageLevel): Tone => (level === 'ok' ? 'ok' : level === 'near' ? 'gold' : level === 'high' || level === 'exhausted' ? 'danger' : 'quiet');

export const TONE_TEXT: Record<Tone, string> = { ok: 'text-accent', gold: 'text-gold', danger: 'text-danger', quiet: 'text-muted' };

/** A Claude's overall tone: the worst of its windows that still count. */
export function stateTone(c: Pick<ClaudeUsage, 'state' | 'windows'>): Tone {
  if (c.state === 'exhausted') return 'danger';
  if (c.state === 'near') return c.windows.some((w) => w.level === 'high' || w.level === 'exhausted') ? 'danger' : 'gold';
  return c.state === 'ok' ? 'ok' : 'quiet';
}

export const STATE_WORDS: Record<ClaudeUsageState, string> = {
  ok: 'Within limits',
  near: 'Near the limit',
  exhausted: 'Out of usage',
  unknown: 'Not known',
  signed_out: 'Not signed in',
  no_limits: 'No plan limits',
};

/** Fixed texts for why the last read gave nothing; Claude Code's own output is never shown. */
export const PROBLEM_WORDS: Record<NonNullable<ClaudeUsage['problem']>, string> = {
  not_installed: 'Claude Code isn’t installed here',
  timeout: 'Claude Code didn’t answer',
  unreadable: 'Claude Code’s answer couldn’t be read',
  unavailable: 'Claude Code couldn’t reach its usage',
  no_scope: 'This sign-in can’t report limits',
};

/** The window the headroom line and the tiny meter lead with: the fullest one that still counts. */
export function fullest(windows: ClaudeUsageWindow[]): ClaudeUsageWindow | null {
  const live = windows.filter((w) => w.usedPct !== null && w.level !== 'reset' && w.level !== 'unknown');
  return live.length ? live.reduce((a, b) => (b.usedPct! > a.usedPct! ? b : a)) : null;
}

/** One terse line for the switch dialog: what the destination Claude has left. */
export function headroomLine(h: Headroom, nowMs: number): string {
  if (h.kind === 'no_limits') return 'No plan limits';
  if (h.kind === 'signed_out') return 'Not signed in';
  if (h.kind === 'unknown' || !h.limiting) return 'Usage not known';
  if (h.exhausted) return h.availableAt ? `Out until ${localTime(h.availableAt, nowMs)}` : 'Out of usage';
  const reset = h.limiting.resetsAt ? ` · resets ${localTime(h.limiting.resetsAt, nowMs)}` : '';
  return `${h.limiting.label} ${Math.round(h.limiting.usedPct)} %${reset}`;
}
