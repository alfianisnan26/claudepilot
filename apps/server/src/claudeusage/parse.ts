// Claude usage (docs/prd/claude-usage.md §10): what Claude Code says about a plan's limits, reduced to numbers,
// times and a window name. Everything in a reply is untrusted: nothing here throws, every number is clamped, every
// label is cleaned, and anything that is not a window, an extra-usage record or a plan tier is dropped (§14).

import { USAGE_THRESHOLDS, type UsageLevel } from '@portal/contracts';

export interface WindowReading {
  /** `session`, `week`, `week_opus`, `week_sonnet`, `week_apps`, `week_models`, `model:<slug>`, `other:<slug>`. */
  key: string;
  label: string;
  /** Percent used, 0 to 1000; null when Claude Code gave no number. */
  usedPct: number | null;
  resetsAtMs: number | null;
}

/** Extra usage; amounts in minor units of `currency`. */
export interface ExtraReading {
  enabled: boolean;
  usedPct: number | null;
  limit: number | null;
  used: number | null;
  currency: string | null;
}

/** What one `get_usage` reply means (§10.1). */
export type ParsedUsage =
  /** A plan with its windows (possibly none: a plan Claude Code listed no window for). */
  | { kind: 'plan'; plan: string | null; windows: WindowReading[]; extra: ExtraReading | null }
  /** `rate_limits_available: false`: a pool, an API key, a provider, signed out, or a login without the profile scope. */
  | { kind: 'no_limits'; plan: string | null }
  /** A plan whose usage Claude Code could not fetch (`rate_limits: null`). */
  | { kind: 'unavailable'; plan: string | null }
  | { kind: 'unreadable' };

export const MAX_WINDOWS = 12;
const MAX_PCT = 1000;
const MIN_TIME = Date.UTC(2020, 0, 1);
const MAX_TIME = Date.UTC(2100, 0, 1);

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A percent: a finite number (or a numeric string), clamped to 0..1000 and rounded to a tenth. */
export function cleanPct(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(MAX_PCT, Math.max(0, n)) * 10) / 10;
}

/** A time as epoch ms: an ISO string, Unix seconds, or ms; null unless it falls between 2020 and 2100. */
export function cleanTime(v: unknown): number | null {
  let ms: number;
  if (typeof v === 'string') ms = Date.parse(v);
  else if (typeof v === 'number' && Number.isFinite(v)) ms = v > 1e11 ? v : v * 1000;
  else return null;
  return Number.isFinite(ms) && ms >= MIN_TIME && ms <= MAX_TIME ? Math.round(ms) : null;
}

/** Characters that must never reach a page as text: controls, zero-width marks and line or paragraph separators. */
const unsafeChar = (ch: string): boolean => {
  const c = ch.charCodeAt(0);
  return c < 32 || (c >= 127 && c <= 159) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f);
};

/** Label text from a server: unsafe characters out, spaces collapsed, at most 40 characters. */
export function cleanLabel(v: unknown, fallback: string): string {
  const s = [...(asStr(v) ?? '')].map((ch) => (unsafeChar(ch) ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim();
  const out = s.length > 40 ? `${s.slice(0, 39)}…` : s;
  return out || fallback;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

/** The plan's tier name Claude Code reports ("pro", "max", "team", "enterprise"); anything else odd is dropped. */
export function cleanPlan(v: unknown): string | null {
  const s = (asStr(v) ?? '').trim().toLowerCase();
  return /^[a-z][a-z0-9_ -]{0,23}$/.test(s) ? s : null;
}

/** Window names Claude Code uses in `rate_limits` and in `rate_limit_info`, by the keys this portal uses. */
const WINDOW_OF: Record<string, string> = {
  five_hour: 'session',
  seven_day: 'week',
  seven_day_opus: 'week_opus',
  seven_day_sonnet: 'week_sonnet',
  seven_day_oauth_apps: 'week_apps',
  seven_day_overage_included: 'week_models',
};
const LABEL_OF: Record<string, string> = { session: 'Session', week: 'Week', week_opus: 'Opus', week_sonnet: 'Sonnet', week_apps: 'Apps', week_models: 'Models' };
/** Where windows sit in a row: the session, the week, then the weeks of single models, the rest last. */
const ORDER = ['session', 'week', 'week_opus', 'week_sonnet', 'week_models', 'week_apps'];

/** Windows in the order a row shows them. */
export function sortWindows<T extends { key: string }>(windows: T[]): T[] {
  const rank = (k: string) => {
    const i = ORDER.indexOf(k);
    return i >= 0 ? i : k.startsWith('model:') ? ORDER.length : ORDER.length + 1;
  };
  return [...windows].sort((a, b) => rank(a.key) - rank(b.key));
}

export const labelOf = (key: string): string => LABEL_OF[key] ?? (key.startsWith('model:') ? key.slice(6) : key.startsWith('other:') ? key.slice(6).replace(/-/g, ' ') : key);

/** The key a model's weekly window gets: Opus and Sonnet keep the names the named fields use. */
function modelKey(name: string): string {
  const s = slug(name);
  return s === 'opus' ? 'week_opus' : s === 'sonnet' ? 'week_sonnet' : s ? `model:${s}` : 'other:model';
}

type Windows = Map<string, WindowReading>;

/** Adds a window; a later source fills what an earlier one left null and wins where both have a value. */
function put(map: Windows, w: WindowReading): void {
  const old = map.get(w.key);
  if (!old && map.size >= MAX_WINDOWS) return;
  map.set(w.key, old ? { key: w.key, label: w.label || old.label, usedPct: w.usedPct ?? old.usedPct, resetsAtMs: w.resetsAtMs ?? old.resetsAtMs } : w);
}

const sorted = (map: Windows): WindowReading[] => sortWindows([...map.values()]);

/** `{utilization, resets_at}` as the named fields carry it; null (or anything else) is no window. */
function namedWindow(key: string, raw: unknown): WindowReading | null {
  const o = asObj(raw);
  if (!o) return null;
  const usedPct = cleanPct(o.utilization);
  const resetsAtMs = cleanTime(o.resets_at);
  return usedPct === null && resetsAtMs === null ? null : { key, label: labelOf(key), usedPct, resetsAtMs };
}

function parseExtra(raw: unknown): ExtraReading | null {
  const o = asObj(raw);
  if (!o) return null;
  const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12 ? Math.round(v) : null);
  const currency = asStr(o.currency);
  return {
    enabled: o.is_enabled === true,
    usedPct: cleanPct(o.utilization),
    limit: money(o.monthly_limit),
    used: money(o.used_credits),
    currency: currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null,
  };
}

/**
 * The reply of `get_usage {skip_behaviors: true}` (its `response` object). The windows can come in three places and
 * all three are read, since which one Claude Code fills depends on the account and its allowlist: the named fields
 * (`five_hour`, `seven_day`, …), `model_scoped[]`, and the server's own `limits[]` rows passed through. Rows win.
 */
export function parseUsageReply(response: unknown): ParsedUsage {
  const r = asObj(response);
  if (!r) return { kind: 'unreadable' };
  const plan = cleanPlan(r.subscription_type);
  if (r.rate_limits_available === false) return { kind: 'no_limits', plan };
  if (r.rate_limits_available !== true) return { kind: 'unreadable' };
  const rl = asObj(r.rate_limits);
  if (!rl) return { kind: 'unavailable', plan };

  const windows: Windows = new Map();
  for (const [field, key] of Object.entries(WINDOW_OF)) {
    const w = namedWindow(key, rl[field]);
    if (w) put(windows, w);
  }
  for (const raw of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
    const o = asObj(raw);
    const name = cleanLabel(o?.display_name, '');
    if (!o || !name) continue;
    const key = modelKey(name);
    put(windows, { key, label: LABEL_OF[key] ?? name, usedPct: cleanPct(o.utilization), resetsAtMs: cleanTime(o.resets_at) });
  }
  let extra = parseExtra(rl.extra_usage);
  let spendRow: { usedPct: number | null } | null = null;
  for (const raw of Array.isArray(rl.limits) ? rl.limits : []) {
    const row = asObj(raw);
    if (!row) continue;
    const kind = asStr(row.kind) ?? '';
    const usedPct = cleanPct(row.percent ?? row.utilization);
    const resetsAtMs = cleanTime(row.resets_at);
    const scope = asObj(row.scope);
    const model = cleanLabel(asObj(scope?.model)?.display_name, '');
    const surface = cleanLabel(asObj(scope?.surface)?.display_name, '');
    if (kind === 'session') put(windows, { key: 'session', label: 'Session', usedPct, resetsAtMs });
    else if (kind === 'weekly_all') put(windows, { key: 'week', label: 'Week', usedPct, resetsAtMs });
    else if (kind === 'weekly_scoped' && model) {
      const key = modelKey(model);
      put(windows, { key, label: LABEL_OF[key] ?? model, usedPct, resetsAtMs });
    } else if (kind === 'spend') spendRow = { usedPct };
    else if (usedPct !== null || resetsAtMs !== null) {
      const name = surface || cleanLabel(kind.replace(/_/g, ' '), 'Other');
      put(windows, { key: `other:${slug(surface || kind) || 'other'}`, label: name, usedPct, resetsAtMs });
    }
  }
  if (!extra && spendRow) extra = { enabled: true, usedPct: spendRow.usedPct, limit: null, used: null, currency: null };
  return { kind: 'plan', plan, windows: sorted(windows), extra };
}

/* ---------- Passive: a live session's rate_limit_info (§10.2) ---------- */

export interface PassiveReading {
  windows: WindowReading[];
  /** Window keys Claude Code said it refused a request for. */
  rejected: string[];
  /** The refusal was for extra usage, not a plan window. */
  overageRejected: boolean;
}

/** A fraction of a window (0.82 is 82 %; above 1 once over) as a percent. */
function fromFraction(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? cleanPct(Math.min(v, 10) * 100) : null;
}

/**
 * The `rate_limit_info` of a `rate_limit_event` (or of an assistant line's `api_error_params`). Utilization there is a
 * fraction and times are Unix seconds, unlike `get_usage`. Null when it carries nothing worth keeping.
 */
export function parseRateLimitInfo(raw: unknown): PassiveReading | null {
  const info = asObj(raw);
  if (!info) return null;
  const windows: Windows = new Map();
  const unified = asObj(info.unifiedWindows);
  for (const [field, key] of [['five_hour', 'session'], ['seven_day', 'week'], ['seven_day_overage_included', 'week_models']] as const) {
    const w = asObj(unified?.[field]);
    if (!w) continue;
    const usedPct = fromFraction(w.utilization);
    const resetsAtMs = cleanTime(w.resetsAt);
    if (usedPct !== null || resetsAtMs !== null) put(windows, { key, label: labelOf(key), usedPct, resetsAtMs });
  }
  const type = asStr(info.rateLimitType);
  const key = type ? WINDOW_OF[type] : undefined;
  const status = asStr(info.status);
  const rejected: string[] = [];
  let overageRejected = false;
  if (key) {
    // The window the status speaks for; its own numbers fill what `unifiedWindows` left out.
    put(windows, { key, label: labelOf(key), usedPct: fromFraction(info.utilization), resetsAtMs: cleanTime(info.resetsAt) });
    if (status === 'rejected') {
      const w = windows.get(key)!;
      windows.set(key, { ...w, usedPct: Math.max(w.usedPct ?? 0, 100) });
      rejected.push(key);
    }
  } else if (type === 'overage' && status === 'rejected') overageRejected = true;
  if (!windows.size && !overageRejected) return null;
  return { windows: sorted(windows), rejected, overageRejected };
}

/* ---------- Sign-in state (claude auth status --json): two fields only ---------- */

export interface AuthState {
  loggedIn: boolean;
  /** `claude.ai`, `api_key`, `oauth_token`, `none` (Claude Code's words), or `unknown`. */
  method: string;
}

/**
 * Reads `loggedIn` and `authMethod` from the output of `claude auth status --json` and nothing else: the rest of it
 * (an email, an organization's name and id, the config directory) is never looked at, kept or logged.
 */
export function parseAuthStatus(output: string): AuthState | null {
  const open = output.indexOf('{');
  const close = output.lastIndexOf('}');
  if (open < 0 || close < open) return null;
  try {
    const j = asObj(JSON.parse(output.slice(open, close + 1)));
    if (!j || typeof j.loggedIn !== 'boolean') return null;
    const method = asStr(j.authMethod) ?? '';
    return { loggedIn: j.loggedIn, method: /^[a-z0-9_.-]{1,24}$/.test(method) ? method : 'unknown' };
  } catch {
    return null;
  }
}

/* ---------- Levels ---------- */

/** Where a window stands at `nowMs`: its reset time passing makes the number old (`reset`). */
export function windowLevel(usedPct: number | null, resetsAtMs: number | null, nowMs: number): UsageLevel {
  if (resetsAtMs !== null && resetsAtMs <= nowMs) return 'reset';
  if (usedPct === null) return 'unknown';
  if (usedPct >= 100) return 'exhausted';
  if (usedPct >= USAGE_THRESHOLDS.critical) return 'high';
  if (usedPct >= USAGE_THRESHOLDS.warn) return 'near';
  return 'ok';
}
