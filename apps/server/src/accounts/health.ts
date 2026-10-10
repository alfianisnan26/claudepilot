import type { AccountHealthState, CheckResult } from '@portal/contracts';
import type { OutboxEvent } from '../delivery/outbox.js';
import type { Store } from '../store/store.js';
import { assertReachableHost, authHeaders, redact } from './check.js';

/** Claude Code 2.1.296's default model: probes measure the model group workspaces use (PRD §11.2). */
export const DEFAULT_PROBE_MODEL = 'claude-opus-5-5';
const PROBE_TIMEOUT_MS = 15_000;
/** At most one probe per account per minute; signals in between share the next one (§11.5). */
const PROBE_SPACING_MS = 60_000;
/** Helper runs closer than this, by one process, mean its key is being rejected (cache lifetime 60 s, §11.5). */
const RERUN_WINDOW_MS = 50_000;
const CHECK_EVERY_MS = 15 * 60_000;
const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const UNCONFIRMED_WINDOW_MS = 10 * 60_000;
const UNCONFIRMED_FLAG = 3;
const RATE_BUCKETS = ['requests', 'tokens', 'input-tokens', 'output-tokens'];

export interface HealthVerdict {
  state: AccountHealthState;
  until: Date | null;
  detail: string | null;
  /** For a 429 with no retry hint: the backoff this cooldown used. */
  backoffMs?: number | null;
}

export interface ProbeResponse {
  /** Null when the host couldn't be reached (never the key's fault). */
  status: number | null;
  /** The parsed body, with the key taken out of the error message. */
  body: unknown;
  headers: Headers;
}

export type Prober = (endpoint: { baseUrl: string; allowPrivateNetwork: boolean }, key: string, model: string) => Promise<ProbeResponse>;

/** One `/v1/messages` request with `max_tokens: 1`: about 10 input tokens on the probe model (§11.2). */
export const probeKey: Prober = async (endpoint, key, model) => {
  const none = { status: null, body: null, headers: new Headers() };
  try {
    await assertReachableHost(endpoint.baseUrl, endpoint.allowPrivateNetwork);
  } catch {
    return none;
  }
  let res: Response;
  try {
    res = await fetch(`${endpoint.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { ...authHeaders(key), 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return none;
  }
  const text = await res.text().catch(() => '');
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: classified by status alone
  }
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  if (error && typeof error.message === 'string') error.message = redact(error.message, key);
  return { status: res.status, body, headers: res.headers };
};

const nextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/** A future date or time stated in a limit message ("… regain access on 2026-11-01 at 00:00 UTC"). */
function statedTime(message: string, now: Date): Date | null {
  const m = message.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/);
  const t = m ? Date.parse(m[0].includes('T') || m[0].includes(' ') ? m[0] : `${m[0]}T00:00:00Z`) : NaN;
  return Number.isFinite(t) && t > now.getTime() ? new Date(t) : null;
}

/** The latest reset among the exhausted rate-limit buckets (`anthropic-ratelimit-*-remaining: 0`). */
function exhaustedReset(headers: Headers, now: Date): Date | null {
  let latest: number | null = null;
  for (const b of RATE_BUCKETS) {
    if (headers.get(`anthropic-ratelimit-${b}-remaining`) !== '0') continue;
    const t = Date.parse(headers.get(`anthropic-ratelimit-${b}-reset`) ?? '');
    if (Number.isFinite(t) && t > now.getTime() && (latest === null || t > latest)) latest = t;
  }
  return latest === null ? null : new Date(latest);
}

/**
 * The rule table (PRD §11.3): a structured response → the account's health, or null for "no change"
 * (overloaded, server errors and request errors aren't the key's fault). Fields are read in order:
 * status, `error.type`, `error.details.error_code`, `retry-after`, then message text.
 */
export function classifyResponse(
  res: { status: number; body: unknown; headers: Headers },
  now: Date,
  prev: { state: AccountHealthState; until: Date | null; backoffMs: number | null },
): HealthVerdict | null {
  const error = (res.body as { error?: { type?: string; message?: string; details?: { error_code?: string } } } | null)?.error;
  const message = typeof error?.message === 'string' ? error.message.slice(0, 300) : '';
  const { status } = res;
  if (status >= 200 && status < 300) return { state: 'ok', until: null, detail: null };
  if (status === 401) return { state: 'invalid', until: null, detail: message || 'The key was rejected (401).' };
  if (status === 402) return { state: 'billing', until: null, detail: message || 'Billing problem (402).' };
  if (status === 403) return { state: 'attention', until: null, detail: message || 'No permission (403).' };
  if (status === 404) return { state: 'attention', until: null, detail: message || 'Not found (404): check the host URL and model names.' };
  if (status === 429) {
    const retryAfter = res.headers.get('retry-after');
    if (error?.details?.error_code === 'enforced_spend_limit_reached' || (!retryAfter && /spend limit/i.test(message)))
      return { state: 'exhausted', until: statedTime(message, now) ?? nextMonth(now), detail: message || 'Spend limit reached.' };
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const at = Number.isFinite(seconds) ? now.getTime() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter);
      if (Number.isFinite(at)) return { state: 'cooling', until: new Date(at), detail: message || 'Rate limited.', backoffMs: null };
    }
    const reset = exhaustedReset(res.headers, now);
    if (reset) return { state: 'cooling', until: reset, detail: message || 'Rate limited.', backoffMs: null };
    // No hint: back off 2 s doubling to 5 min, escalating at most once per cooldown window.
    const inWindow = prev.state === 'cooling' && prev.until !== null && prev.until > now;
    const backoffMs = inWindow ? (prev.backoffMs ?? BACKOFF_START_MS) : Math.min(BACKOFF_MAX_MS, prev.backoffMs ? prev.backoffMs * 2 : BACKOFF_START_MS);
    return { state: 'cooling', until: new Date(now.getTime() + backoffMs), detail: message || 'Rate limited.', backoffMs };
  }
  if (status === 400 && /^You have reached your specified/i.test(message))
    return { state: 'exhausted', until: statedTime(message, now) ?? nextMonth(now), detail: message };
  if (status === 400 && /credit balance/i.test(message)) return { state: 'billing', until: null, detail: message };
  return null;
}

/** A key check (`GET /v1/models`) says less than a probe: only these results change health. */
export function verdictOfCheck(result: CheckResult, now: Date): HealthVerdict | null {
  switch (result) {
    case 'ok':
      return { state: 'ok', until: null, detail: null };
    case 'invalid':
      return { state: 'invalid', until: null, detail: 'The key was rejected (401).' };
    case 'billing':
      return { state: 'billing', until: null, detail: 'Billing problem.' };
    case 'no_permission':
      return { state: 'attention', until: null, detail: 'No permission (403).' };
    case 'spend_limit':
      return { state: 'exhausted', until: nextMonth(now), detail: 'Spend limit reached.' };
    default:
      return null; // rate limited, unreachable, wrong path, errors: no change
  }
}

interface HealthRow {
  id: string;
  secret: string | null;
  enabled: number;
  health: AccountHealthState;
  health_until: string | null;
  backoff_ms: number | null;
  base_url: string;
  allow_private_network: number;
  model_names: string;
}

/** When a helper ran, from its `<ns>-<pid>` ID (falls back to the second-precision time). */
function runTime(e: OutboxEvent): number | null {
  const ns = /^(\d{13,})-/.exec(e.id)?.[1];
  if (ns) return Number(ns.slice(0, 13)); // first 13 digits of ns since the epoch = ms
  const t = Date.parse(String(e.t ?? ''));
  return Number.isFinite(t) ? t : null;
}

/**
 * Account health (PRD §11): turns workspace signals into confirmatory probes, probe and check results
 * into health states with expiries, and tells the pools so workspaces move (§12). A probe decides;
 * a signal alone never changes anything.
 */
export class AccountHealthService {
  /** Told when an account's health changes; `failover` when it got worse. */
  onChange: (accountId: string, why: string, opts: { failover: boolean }) => void = () => {};
  /** Runs a key check (`GET /v1/models`) and saves it the way the Accounts page does. */
  check: (accountId: string) => Promise<void> = async () => {};
  /** The workspace's current account, for signals that don't name one. */
  activeAccount: (workspaceId: string) => string | null = () => null;
  /** Workspaces whose signal a probe didn't confirm: reconciled in case their files drifted (§11.5). */
  onUnconfirmed: (workspaceIds: string[]) => void = () => {};
  /** After anything is logged (signals, probes, health changes), for live pages. */
  onEvent: () => void = () => {};

  readonly #lastProbe = new Map<string, number>();
  readonly #queued = new Map<string, { timer: NodeJS.Timeout; reasons: Set<string>; workspaces: Set<string> }>();
  readonly #runs = new Map<string, number>();
  readonly #unconfirmed = new Map<string, number[]>();
  #timer: NodeJS.Timeout | undefined;
  #checking = false;
  #lastPrune = 0;

  constructor(
    private readonly store: Store,
    private readonly opts: { probe?: Prober; now?: () => number; spacingMs?: number } = {},
  ) {}

  #now() {
    return this.opts.now?.() ?? Date.now();
  }

  start() {
    this.#timer = setInterval(() => this.#tick(), 15_000);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
    for (const q of this.#queued.values()) clearTimeout(q.timer);
    this.#queued.clear();
  }

  /* ---------- Signals from workspaces (§11.5) ---------- */

  /** Outbox `account` events from one workspace: helper runs and StopFailure hooks. */
  onSignals(workspaceId: string, events: OutboxEvent[]) {
    const delivered = Date.parse(
      (this.store.db?.prepare('SELECT applied_at FROM workspace_delivery WHERE workspace_id = ?').get(workspaceId) as { applied_at: string | null } | undefined)?.applied_at ?? '',
    );
    // One signal per account and cause per pull, however many lines point at it.
    const signals = new Map<string, { account: string; why: string }>();
    const runs = events
      .filter((e) => e.type === 'helper_run' && typeof e.account === 'string' && e.empty !== true)
      .map((e) => ({ account: e.account as string, ppid: String(e.ppid ?? ''), at: runTime(e) }))
      .filter((r): r is { account: string; ppid: string; at: number } => r.at !== null)
      .sort((a, b) => a.at - b.at);
    for (const r of runs) {
      const key = `${workspaceId}|${r.account}|${r.ppid}`;
      const prev = this.#runs.get(key);
      this.#runs.set(key, r.at);
      // A managed-settings write in between makes a process run the helper again: not a rejection.
      const deliveredBetween = Number.isFinite(delivered) && prev !== undefined && delivered > prev && delivered <= r.at;
      if (prev !== undefined && r.at - prev >= 0 && r.at - prev < RERUN_WINDOW_MS && !deliveredBetween)
        signals.set(`${r.account}|rerun`, { account: r.account, why: 'key rejected (helper ran again)' });
    }
    for (const e of events) {
      if (e.type !== 'stop_failure') continue;
      const account = typeof e.account === 'string' && e.account ? e.account : this.activeAccount(workspaceId);
      const why = `turn failed (${String(e.error || 'unknown').slice(0, 40)})`;
      if (account) signals.set(`${account}|${why}`, { account, why });
    }
    for (const s of signals.values()) this.#signal(workspaceId, s.account, s.why);
    if (this.#now() - this.#lastPrune > 10 * 60_000) {
      this.#lastPrune = this.#now();
      for (const [k, at] of this.#runs) if (this.#now() - at > 10 * 60_000) this.#runs.delete(k);
    }
  }

  #signal(workspaceId: string, accountId: string, why: string) {
    this.#event('signal', accountId, workspaceId, { why });
    this.requestProbe(accountId, why, workspaceId);
  }

  /** Queues a probe of the account, at most one a minute; reasons that arrive meanwhile share it. */
  requestProbe(accountId: string, reason: string, workspaceId?: string) {
    const queued = this.#queued.get(accountId);
    if (queued) {
      queued.reasons.add(reason);
      if (workspaceId) queued.workspaces.add(workspaceId);
      return;
    }
    const spacing = this.opts.spacingMs ?? PROBE_SPACING_MS;
    const wait = Math.max(0, (this.#lastProbe.get(accountId) ?? -Infinity) + spacing - this.#now());
    const entry = { reasons: new Set([reason]), workspaces: new Set(workspaceId ? [workspaceId] : []), timer: undefined as unknown as NodeJS.Timeout };
    entry.timer = setTimeout(() => {
      this.#queued.delete(accountId);
      void this.probe(accountId, { reasons: [...entry.reasons], workspaces: [...entry.workspaces] }).catch((e: unknown) =>
        console.error(`[health] probe of ${accountId} failed: ${(e as Error).message}`),
      );
    }, wait);
    entry.timer.unref();
    this.#queued.set(accountId, entry);
  }

  /** Probes now (admin re-checks skip the queue). Returns the verdict, or null for "no change". */
  async probe(accountId: string, ctx: { reasons: string[]; workspaces?: string[]; manual?: boolean }): Promise<HealthVerdict | null> {
    const db = this.store.db;
    const box = this.store.secrets;
    if (!db || !box || !this.store.writable) return null; // Locked: keys are out of reach
    const row = db
      .prepare(
        `SELECT a.id, a.secret, a.enabled, a.health, a.health_until, a.backoff_ms, e.base_url, e.allow_private_network, e.model_names
         FROM accounts a JOIN endpoints e ON e.id = a.endpoint_id WHERE a.id = ?`,
      )
      .get(accountId) as HealthRow | undefined;
    if (!row?.secret) return null;
    this.#lastProbe.set(accountId, this.#now());
    const models = JSON.parse(row.model_names) as { default?: string; opus?: string };
    const model = models.default ?? models.opus ?? DEFAULT_PROBE_MODEL;
    const key = box.open(row.secret, { table: 'accounts', row: accountId, column: 'secret' });
    const res = await (this.opts.probe ?? probeKey)({ baseUrl: row.base_url, allowPrivateNetwork: !!row.allow_private_network }, key, model);
    const now = new Date(this.#now());
    const prev = { state: row.health, until: row.health_until ? new Date(row.health_until) : null, backoffMs: row.backoff_ms };
    const verdict = res.status === null ? null : classifyResponse({ status: res.status, body: res.body, headers: res.headers }, now, prev);
    this.#event('probe', accountId, null, { model, status: res.status, result: verdict?.state ?? 'no change', reasons: ctx.reasons });
    if (!verdict) return null;

    const fromSignal = ctx.reasons.some((r) => r !== 'cooldown ended' && r !== 'admin re-check');
    if (verdict.state === 'ok' && fromSignal) this.#unconfirmedSignal(accountId, ctx.workspaces ?? []);
    this.#apply(accountId, verdict, { source: ctx.manual ? 'admin re-check' : 'probe', manual: !!ctx.manual });
    return verdict;
  }

  /** The probe found the account working: logged, never a move; three in 10 minutes flag it (§11.5). */
  #unconfirmedSignal(accountId: string, workspaces: string[]) {
    const now = this.#now();
    const recent = [...(this.#unconfirmed.get(accountId) ?? []).filter((t) => now - t < UNCONFIRMED_WINDOW_MS), now];
    this.#unconfirmed.set(accountId, recent);
    this.#event('signal_unconfirmed', accountId, null, { workspaces });
    if (recent.length === UNCONFIRMED_FLAG) this.#event('review_flagged', accountId, null, { unconfirmed: recent.length, minutes: UNCONFIRMED_WINDOW_MS / 60_000 });
    if (workspaces.length) this.onUnconfirmed(workspaces);
  }

  /* ---------- Checks and admin actions ---------- */

  /** After a key check was saved. Pools hear about it either way: the check result counts too. */
  fromCheck(accountId: string, result: CheckResult, manual: boolean) {
    const verdict = verdictOfCheck(result, new Date(this.#now()));
    const changed = verdict ? this.#apply(accountId, verdict, { source: manual ? 'check' : 'scheduled check', manual }) : false;
    if (!changed) this.onChange(accountId, `check: ${result}`, { failover: false });
  }

  /** Admin override (FR19): the account is usable again, whatever its state. */
  clear(accountId: string) {
    this.#apply(accountId, { state: 'ok', until: null, detail: null, backoffMs: null }, { source: 'admin', manual: true });
  }

  /**
   * Saves a verdict. A cooldown is never shortened by a probe alone (`until = max(old, new)`), and a
   * timed state ends only once its expiry passes and a probe succeeds, or by an admin (§11.3).
   * Returns whether the state or its expiry changed.
   */
  #apply(accountId: string, verdict: HealthVerdict, opts: { source: string; manual: boolean }): boolean {
    const db = this.store.db;
    if (!db || !this.store.writable) return false;
    const row = db.prepare('SELECT health, health_until, backoff_ms FROM accounts WHERE id = ?').get(accountId) as
      | { health: AccountHealthState; health_until: string | null; backoff_ms: number | null }
      | undefined;
    if (!row) return false;
    const now = new Date(this.#now());
    const prevUntil = row.health_until ? new Date(row.health_until) : null;
    let next = verdict;
    if (verdict.state === 'ok') {
      if (row.health === 'ok') return false;
      const timed = row.health === 'cooling' || row.health === 'exhausted';
      if (timed && prevUntil && prevUntil > now && !opts.manual) return false;
    } else if (verdict.state === row.health && verdict.until && prevUntil && prevUntil > verdict.until) {
      next = { ...verdict, until: prevUntil };
    }
    const backoff = next.state === 'ok' ? null : next.backoffMs === undefined ? row.backoff_ms : next.backoffMs;
    db.prepare('UPDATE accounts SET health = ?, health_until = ?, health_detail = ?, health_at = ?, backoff_ms = ? WHERE id = ?').run(
      next.state,
      next.until?.toISOString() ?? null,
      next.detail,
      now.toISOString(),
      backoff,
      accountId,
    );
    const changed = next.state !== row.health || (next.until?.getTime() ?? null) !== (prevUntil?.getTime() ?? null);
    if (!changed) return false;
    this.#event('health_changed', accountId, null, { from: row.health, to: next.state, until: next.until?.toISOString() ?? null, source: opts.source });
    this.onChange(accountId, `${next.state}${next.until ? ` until ${next.until.toISOString()}` : ''} (${opts.source})`, { failover: next.state !== 'ok' });
    return true;
  }

  /* ---------- Timers ---------- */

  #tick() {
    const db = this.store.db;
    if (!db || !this.store.secrets || !this.store.writable) return;
    const now = this.#now();
    // Cooldowns that ended: a probe decides whether the account is back.
    const ended = db
      .prepare("SELECT id FROM accounts WHERE enabled = 1 AND secret IS NOT NULL AND health IN ('cooling', 'exhausted') AND health_until <= ?")
      .all(new Date(now).toISOString()) as { id: string }[];
    for (const r of ended) if (!this.#queued.has(r.id)) this.requestProbe(r.id, 'cooldown ended');
    // Key checks every 15 minutes (FR16), one at a time.
    if (this.#checking) return;
    const stale = db
      .prepare('SELECT id FROM accounts WHERE enabled = 1 AND secret IS NOT NULL AND (checked_at IS NULL OR checked_at < ?) ORDER BY checked_at LIMIT 1')
      .get(new Date(now - CHECK_EVERY_MS).toISOString()) as { id: string } | undefined;
    if (!stale) return;
    this.#checking = true;
    void this.check(stale.id)
      .catch((e: unknown) => console.error(`[health] scheduled check failed: ${(e as Error).message}`))
      .finally(() => (this.#checking = false));
  }

  #event(type: string, accountId: string | null, workspaceId: string | null, details: Record<string, unknown>) {
    if (!this.store.writable) return;
    this.store.db
      ?.prepare('INSERT INTO account_events (at, type, account_id, workspace_id, details) VALUES (?, ?, ?, ?, ?)')
      .run(new Date(this.#now()).toISOString(), type, accountId, workspaceId, JSON.stringify(details));
    this.onEvent();
  }
}
