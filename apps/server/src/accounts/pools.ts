import { AppError, newId } from '@isnanme/core';
import type {
  AccountPool,
  AccountPoolRequest,
  AssignAccountPoolRequest,
  PoolStrategy,
  WorkspaceAccountState,
} from '@portal/contracts';
import type { FragmentProvider, Reconciler } from '../delivery/reconciler.js';
import { NODE, ROOT, type Fragment } from '../delivery/types.js';
import type { Store } from '../store/store.js';

/** Minimum Claude Code version for pool delivery (foundation PRD §9). */
const MIN_CLAUDE = '2.1.296';
/** After writing safe values on unassign, wait this long before removing files (Account Pool PRD §10.4). */
const UNASSIGN_GRACE_MS = 60_000;
/** Check results that leave an account usable for new assignments. */
const USABLE = ['ok', 'rate_limited', 'unknown'];
/** A workspace rides out shorter cooldowns on Claude Code's own retries (§12.2). */
const COOLING_TOLERATED_MS = 2 * 60_000;
/** Rate-limit moves onto any one account per minute, and the random delay before each move (§12.3). */
const MOVES_PER_MINUTE = 5;
const JITTER_MAX_MS = 10_000;
/** Outbox files stop growing past this until the portal pulls them (foundation §8). */
const OUTBOX_CAP = 1024 * 1024;

interface AccountRow {
  id: string;
  enabled: number;
  secret: string | null;
  check_result: string;
  health: string;
  health_until: string | null;
  organization_id: string | null;
}

/** Can keep serving the workspaces it has: working, or cooling only briefly. */
function servable(a: AccountRow, now: number): boolean {
  if (!a.enabled || !a.secret || !USABLE.includes(a.check_result)) return false;
  if (a.health === 'ok') return true;
  return a.health === 'cooling' && (!a.health_until || Date.parse(a.health_until) - now <= COOLING_TOLERATED_MS);
}

/** Can take workspaces: servable and healthy. */
const pickable = (a: AccountRow, now: number) => servable(a, now) && a.health === 'ok';

interface PoolContent {
  endpointId: string;
  members: { accountId: string; enabled: boolean }[];
  strategy: PoolStrategy;
  hideLogin: boolean;
}

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });

/** `apiKeyHelper` for one account: logs each run to the outbox (Account Pool §11.5), prints only the key. */
const ACCOUNT_KEY = `#!/bin/sh
# claudepilot: prints the key of account $1 for Claude Code's apiKeyHelper. Print nothing else.
f="/etc/claudepilot/account/$1.key"
o="$HOME/.claudepilot/outbox"
if [ -d "$o" ] && [ "$(stat -c %s "$o/account.jsonl" 2>/dev/null || echo 0)" -lt ${OUTBOX_CAP} ]; then
  e=false; [ -s "$f" ] || e=true
  # The calling claude process: Claude Code starts the helper through a shell, so step past shells.
  p=$PPID
  for _ in 1 2 3; do
    case "$(cat /proc/$p/comm 2>/dev/null)" in
      sh|dash|bash) n=$(sed 's/.*) //' /proc/$p/stat 2>/dev/null | cut -d' ' -f2); [ -n "$n" ] && p=$n || break ;;
      *) break ;;
    esac
  done
  printf '{"id":"%s-%s","t":"%s","type":"helper_run","account":"%s","ppid":%s,"empty":%s}\\n' \\
    "$(date +%s%N)" "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$p" "$e" >> "$o/account.jsonl" 2>/dev/null
fi
[ -s "$f" ] || { echo "claudepilot: no key for account $1" >&2; exit 1; }
exec cat "$f"
`;

/**
 * StopFailure hook: records only the error category and session (never prompts or replies). Plain sh,
 * so it writes within milliseconds: `claude -p` exits right after a failed turn and may not wait for it.
 */
const ACCOUNT_EVENT = `#!/bin/sh
# claudepilot: StopFailure hook. Appends the error category to the outbox, nothing else.
f="$HOME/.claudepilot/outbox/account.jsonl"
[ -d "\${f%/*}" ] && [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" -lt ${OUTBOX_CAP} ] || exit 0
i=$(head -c 65536)
e=$(printf '%s' "$i" | sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\\([a-z_]\\{1,40\\}\\)".*/\\1/p' | head -n 1)
s=$(printf '%s' "$i" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9-]\\{1,64\\}\\)".*/\\1/p' | head -n 1)
a=$CLAUDEPILOT_ACCOUNT
case "$a" in *[!A-Za-z0-9-]*) a= ;; esac
printf '{"id":"%s-%s","t":"%s","type":"stop_failure","error":"%s","session":"%s","account":"%s"}\\n' \\
  "$(date +%s%N)" "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\${e:-unknown}" "$s" "$a" >> "$f" 2>/dev/null
exit 0
`;

interface AssignmentRow {
  workspace_id: string;
  pool_id: string;
  active_account_id: string | null;
  pinned_account_id: string | null;
  state: string;
  waiting_until: string | null;
  changed_at: string;
  reason: string | null;
}

/**
 * Account pools and their assignment to workspaces (Account Pool PRD §8 FR7–FR12, §10, §12.1). Also
 * the `account` fragment provider for the delivery engine.
 */
export class AccountPools implements FragmentProvider {
  readonly type = 'account' as const;
  reconciler: Reconciler | null = null;
  /** Pools or assignments changed (edits, assignments, failovers), for live pages. */
  onChange: () => void = () => {};
  /**
   * Chat sessions (chat-sessions PRD §6 rule 2): called with the workspace when its assignment is about
   * to change (removed, or set to another pool), after the request checked out and before anything is
   * written or delivered, so its live chat sessions end before the change goes out.
   */
  onTransition?: (workspaceId: string) => void;
  /** Recent moves onto each account, for the per-minute cap (a soft limit: memory is enough). */
  readonly #movesOnto = new Map<string, number[]>();

  constructor(
    private readonly store: Store,
    private readonly opts: { jitterMs?: () => number } = {},
  ) {}

  get #db() {
    const db = this.store.db;
    if (!db || !this.store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not writable.');
    return db;
  }

  /* ---------- Pools ---------- */

  list(): AccountPool[] {
    const db = this.store.db;
    if (!db) return [];
    const rows = db
      .prepare(
        `SELECT p.*, r.content, (SELECT count(*) FROM account_assignments a WHERE a.pool_id = p.id) AS workspaces
         FROM pools p JOIN pool_revisions r ON r.pool_id = p.id AND r.revision = p.current_revision
         WHERE p.type = 'account' ORDER BY p.created_at`,
      )
      .all() as { id: string; name: string; description: string; current_revision: number; created_at: string; content: string; workspaces: number }[];
    return rows.map((r) => {
      const c = JSON.parse(r.content) as PoolContent;
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        endpointId: c.endpointId,
        members: c.members,
        strategy: c.strategy,
        hideLogin: c.hideLogin,
        revision: r.current_revision,
        workspaces: Number(r.workspaces),
        createdAt: r.created_at,
      };
    });
  }

  #content(req: Partial<AccountPoolRequest>, current?: PoolContent): PoolContent {
    const endpointId = req.endpointId ?? current?.endpointId;
    const endpoint = this.#db.prepare('SELECT id FROM endpoints WHERE id = ?').get(endpointId ?? '');
    if (!endpoint) throw invalid('endpointId', 'Pick an endpoint.');
    const ids = req.members ?? current?.members.map((m) => m.accountId) ?? [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw invalid('members', 'Pick the pool’s accounts.');
    if (new Set(ids).size !== ids.length) throw invalid('members', 'An account is listed twice.');
    for (const id of ids) {
      const a = this.#db.prepare('SELECT endpoint_id FROM accounts WHERE id = ?').get(id) as { endpoint_id: string } | undefined;
      if (!a) throw invalid('members', 'One of the accounts no longer exists.');
      if (a.endpoint_id !== endpointId) throw invalid('members', 'Every account in a pool must use the pool’s endpoint.');
      const other = this.list().find((p) => p.members.some((m) => m.accountId === id) && p.endpointId !== undefined);
      if (other && (!current || !current.members.some((m) => m.accountId === id)))
        throw invalid('members', `An account can be in one pool only; one is already in “${other.name}”.`);
    }
    const strategy = req.strategy ?? current?.strategy ?? 'fill-first';
    if (strategy !== 'fill-first' && strategy !== 'spread') throw invalid('strategy', 'Pick fill-first or spread.');
    return {
      endpointId: endpointId!,
      members: ids.map((accountId) => ({ accountId, enabled: true })),
      strategy,
      hideLogin: req.hideLogin ?? current?.hideLogin ?? false,
    };
  }

  #name(input: unknown, exceptId?: string): string {
    const name = typeof input === 'string' ? input.trim() : '';
    if (!name) throw invalid('name', 'Give the pool a name.');
    if (name.length > 60) throw invalid('name', 'Use at most 60 characters.');
    const clash = this.#db.prepare("SELECT id FROM pools WHERE type = 'account' AND name = ? COLLATE NOCASE").get(name) as { id: string } | undefined;
    if (clash && clash.id !== exceptId) throw new AppError('CONFLICT', `A pool named “${name}” already exists.`, { details: { name: 'Already used.' } });
    return name;
  }

  create(req: Partial<AccountPoolRequest>): AccountPool {
    const name = this.#name(req.name);
    const content = this.#content(req);
    const id = newId();
    const now = new Date().toISOString();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare("INSERT INTO pools (id, type, name, description, current_revision, created_at, updated_at) VALUES (?, 'account', ?, ?, 1, ?, ?)").run(id, name, String(req.description ?? '').slice(0, 300), now, now);
      this.#db.prepare('INSERT INTO pool_revisions (pool_id, revision, content, created_at) VALUES (?, 1, ?, ?)').run(id, JSON.stringify(content), now);
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    this.onChange();
    return this.list().find((p) => p.id === id)!;
  }

  /** Every edit is a new revision; assigned workspaces follow it (and re-pick if their account left). */
  update(id: string, req: Partial<AccountPoolRequest>): AccountPool {
    const current = this.list().find((p) => p.id === id);
    if (!current) throw new AppError('NOT_FOUND', 'That pool no longer exists.');
    if (req.endpointId && req.endpointId !== current.endpointId && current.workspaces > 0)
      throw new AppError('CONFLICT', 'Unassign the pool’s workspaces before changing its endpoint.');
    const name = req.name === undefined ? current.name : this.#name(req.name, id);
    const content = this.#content(req, current);
    const revision = current.revision + 1;
    const now = new Date().toISOString();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('INSERT INTO pool_revisions (pool_id, revision, content, created_at) VALUES (?, ?, ?, ?)').run(id, revision, JSON.stringify(content), now);
      this.#db.prepare('UPDATE pools SET name = ?, description = ?, current_revision = ?, updated_at = ? WHERE id = ?').run(name, req.description === undefined ? current.description : String(req.description).slice(0, 300), revision, now, id);
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    for (const ws of this.#workspacesOf(id)) this.#repick(ws, 'pool changed');
    this.onChange();
    return this.list().find((p) => p.id === id)!;
  }

  remove(id: string) {
    const current = this.list().find((p) => p.id === id);
    if (!current) throw new AppError('NOT_FOUND', 'That pool no longer exists.');
    if (current.workspaces > 0) throw new AppError('CONFLICT', `Unassign its ${current.workspaces} workspace(s) first.`);
    const pendingRemovals = this.#db.prepare('SELECT count(*) AS n FROM removals WHERE pool_id = ?').get(id) as { n: number };
    if (pendingRemovals.n > 0) throw new AppError('CONFLICT', 'Its workspaces are still being cleared. Try again in a minute.');
    this.#db.prepare('DELETE FROM pools WHERE id = ?').run(id);
    this.onChange();
  }

  /** Pools listing an account (to refuse removing an account that's still in one). */
  poolsWith(accountId: string): string[] {
    return this.list().filter((p) => p.members.some((m) => m.accountId === accountId)).map((p) => p.name);
  }

  /* ---------- Assignment ---------- */

  #workspacesOf(poolId: string): string[] {
    return (this.#db.prepare('SELECT workspace_id FROM account_assignments WHERE pool_id = ?').all(poolId) as { workspace_id: string }[]).map((r) => r.workspace_id);
  }

  #assignment(workspaceId: string): AssignmentRow | null {
    return (this.store.db?.prepare('SELECT * FROM account_assignments WHERE workspace_id = ?').get(workspaceId) as unknown as AssignmentRow | undefined) ?? null;
  }

  #account(id: string): AccountRow | undefined {
    return this.#db
      .prepare('SELECT id, enabled, secret, check_result, health, health_until, organization_id FROM accounts WHERE id = ?')
      .get(id) as AccountRow | undefined;
  }

  #recentMoves(accountId: string, now: number): number {
    const recent = (this.#movesOnto.get(accountId) ?? []).filter((t) => now - t < 60_000);
    this.#movesOnto.set(accountId, recent);
    return recent.length;
  }

  /**
   * Picks an account per the pool's strategy (§12.1): healthy accounts first, then ones only briefly
   * cooling. After a rate limit or spend cap, prefers another organization, and respects the
   * per-minute cap on moves onto one account (`capped` when every candidate is at it).
   */
  #pick(pool: AccountPool, opts: { exclude?: string[]; avoidOrg?: string | null; capped?: boolean } = {}): string | null | 'capped' {
    const now = Date.now();
    const members = pool.members
      .filter((m) => m.enabled && !opts.exclude?.includes(m.accountId))
      .map((m) => this.#account(m.accountId))
      .filter((a): a is AccountRow => !!a);
    let candidates = members.filter((a) => pickable(a, now));
    if (candidates.length === 0) candidates = members.filter((a) => servable(a, now));
    if (candidates.length === 0) return null;
    if (opts.avoidOrg) {
      const elsewhere = candidates.filter((a) => a.organization_id !== opts.avoidOrg);
      if (elsewhere.length) candidates = elsewhere;
    }
    if (opts.capped) {
      const open = candidates.filter((a) => this.#recentMoves(a.id, now) < MOVES_PER_MINUTE);
      if (open.length === 0) return 'capped';
      candidates = open;
    }
    if (pool.strategy === 'fill-first') return candidates[0]!.id;
    const load = (id: string) => (this.#db.prepare('SELECT count(*) AS n FROM account_assignments WHERE active_account_id = ?').get(id) as { n: number }).n;
    return candidates.reduce((best, a) => (load(a.id) < load(best.id) ? a : best)).id;
  }

  /** The earliest time an account in the pool is expected back from a cooldown (FR18), if any. */
  #earliestRecovery(pool: AccountPool): string | null {
    const now = Date.now();
    const times = pool.members
      .map((m) => this.#account(m.accountId))
      .filter((a): a is AccountRow => !!a && !!a.enabled && (a.health === 'cooling' || a.health === 'exhausted') && !!a.health_until)
      .map((a) => Date.parse(a.health_until!))
      .filter((t) => t > now);
    return times.length ? new Date(Math.min(...times)).toISOString() : null;
  }

  #event(type: string, accountId: string | null, workspaceId: string, details: Record<string, unknown>) {
    this.#db.prepare('INSERT INTO account_events (at, type, account_id, workspace_id, details) VALUES (?, ?, ?, ?, ?)').run(new Date().toISOString(), type, accountId, workspaceId, JSON.stringify(details));
    this.onChange();
  }

  /**
   * Keeps a workspace on its account while that account can serve; otherwise moves it (§12.2). With
   * nowhere to go it keeps the last key and waits for quota (FR18). Read, pick and write happen in
   * one synchronous step, so two moves never pick from the same stale state (§12.4).
   */
  #repick(workspaceId: string, reason: string) {
    const a = this.#assignment(workspaceId);
    if (!a) return;
    const pool = this.list().find((p) => p.id === a.pool_id);
    if (!pool) return;
    const now = Date.now();
    const at = new Date(now).toISOString();
    const current = a.active_account_id ? this.#account(a.active_account_id) : undefined;
    const stillMember = pool.members.some((m) => m.accountId === a.active_account_id && m.enabled);
    if (current && stillMember && servable(current, now)) {
      if (a.state === 'waiting') {
        this.#db.prepare("UPDATE account_assignments SET state = 'active', waiting_until = NULL, changed_at = ?, reason = ? WHERE workspace_id = ?").run(at, reason, workspaceId);
        this.#event('pool_resumed', current.id, workspaceId, { reason });
      }
      return void this.reconciler?.request(workspaceId, reason, { changed: true });
    }

    const cause = !current || !stillMember ? 'unavailable' : current.health === 'cooling' ? 'rate limit' : current.health === 'exhausted' ? 'spend cap' : 'unavailable';
    const next = this.#pick(pool, {
      exclude: current ? [current.id] : [],
      avoidOrg: cause === 'unavailable' ? null : current?.organization_id,
      // Moves off an account that can't serve at all skip the per-minute cap (§12.3).
      capped: cause === 'rate limit',
    });
    if (next === 'capped') {
      setTimeout(() => this.#safeRepick(workspaceId, reason), 15_000).unref();
      return;
    }
    if (next) {
      this.#db
        .prepare("UPDATE account_assignments SET active_account_id = ?, state = 'active', waiting_until = NULL, changed_at = ?, reason = ? WHERE workspace_id = ?")
        .run(next, at, reason, workspaceId);
      this.#movesOnto.set(next, [...(this.#movesOnto.get(next) ?? []), now]);
      this.#event(current ? 'failover' : 'account_picked', current?.id ?? next, workspaceId, { from: current?.id ?? null, to: next, cause, reason });
    } else {
      // No other account: keep the last key in place (FR18) rather than leave the workspace without one.
      const until = this.#earliestRecovery(pool);
      this.#db
        .prepare("UPDATE account_assignments SET state = 'waiting', waiting_until = ?, changed_at = ?, reason = ? WHERE workspace_id = ?")
        .run(until, at, `${reason}; no other usable account`, workspaceId);
      if (a.state !== 'waiting') this.#event('pool_waiting', current?.id ?? null, workspaceId, { until, reason });
    }
    void this.reconciler?.request(workspaceId, reason, { changed: true });
  }

  /** For timers: a database that went read-only meanwhile must not crash the portal. */
  #safeRepick(workspaceId: string, reason: string) {
    try {
      this.#repick(workspaceId, reason);
    } catch (e) {
      console.error(`[pools] re-pick of ${workspaceId} failed: ${(e as Error).message}`);
    }
  }

  /**
   * An account changed (health, check, disabled, key replaced): move or re-deliver its workspaces.
   * `failover` spreads the moves over 0–10 s so many workspaces don't land on one account at once.
   */
  accountChanged(accountId: string, why: string, opts: { failover?: boolean } = {}) {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    const rows = db.prepare('SELECT workspace_id FROM account_assignments WHERE active_account_id = ?').all(accountId) as { workspace_id: string }[];
    for (const r of rows) {
      if (opts.failover) setTimeout(() => this.#safeRepick(r.workspace_id, why), this.opts.jitterMs?.() ?? Math.random() * JITTER_MAX_MS).unref();
      else this.#safeRepick(r.workspace_id, why);
    }
    // Waiting workspaces may now have an account.
    const waiting = db.prepare("SELECT workspace_id FROM account_assignments WHERE state = 'waiting'").all() as { workspace_id: string }[];
    for (const r of waiting) if (!rows.some((x) => x.workspace_id === r.workspace_id)) this.#safeRepick(r.workspace_id, why);
  }

  /** Workspaces with a pool, whose outbox the portal pulls for failure signals. */
  assignedWorkspaces(): string[] {
    const rows = this.store.db?.prepare('SELECT workspace_id FROM account_assignments').all() as { workspace_id: string }[] | undefined;
    return (rows ?? []).map((r) => r.workspace_id);
  }

  activeAccount(workspaceId: string): string | null {
    return this.#assignment(workspaceId)?.active_account_id ?? null;
  }

  /**
   * Assigns a pool (or none) to a workspace. `existing` workspaces need `confirmOverride`: the pool's
   * key outranks any sign-in already there and changes who pays (PRD §13).
   */
  assign(workspaceId: string, req: Partial<AssignAccountPoolRequest>, opts: { existing: boolean }): WorkspaceAccountState | null {
    const poolId = req.poolId ?? null;
    const current = this.#assignment(workspaceId);
    if ((current?.pool_id ?? null) === poolId) return this.stateFor(workspaceId);
    const now = new Date().toISOString();
    if (poolId === null) {
      if (!current) return null;
      this.onTransition?.(workspaceId); // chat: end the workspace's sessions first (§6 rule 2)
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#db.prepare('DELETE FROM account_assignments WHERE workspace_id = ?').run(workspaceId);
        this.#db.prepare('DELETE FROM assignments WHERE workspace_id = ? AND pool_id = ?').run(workspaceId, current.pool_id);
        this.#db.prepare("INSERT INTO removals (workspace_id, pool_type, pool_id, requested_at) VALUES (?, 'account', ?, ?)").run(workspaceId, current.pool_id, now);
        this.#db.exec('COMMIT');
      } catch (e) {
        this.#db.exec('ROLLBACK');
        throw e;
      }
      void this.reconciler?.request(workspaceId, 'unassigned', { changed: true });
      this.onChange();
      return null;
    }
    const pool = this.list().find((p) => p.id === poolId);
    if (!pool) throw invalid('poolId', 'That pool no longer exists.');
    if (opts.existing && !current && req.confirmOverride !== true)
      throw new AppError('CONFIRM_REQUIRED', 'This workspace may have its own sign-in. Confirm that the pool’s key should override it.');
    this.onTransition?.(workspaceId); // chat: end the workspace's sessions first (§6 rule 2)
    const picked = this.#pick(pool);
    const account = picked === 'capped' ? null : picked;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (current) this.#db.prepare('DELETE FROM assignments WHERE workspace_id = ? AND pool_id = ?').run(workspaceId, current.pool_id);
      this.#db.prepare("INSERT INTO assignments (workspace_id, pool_id, pool_type, assigned_at) VALUES (?, ?, 'account', ?) ON CONFLICT DO NOTHING").run(workspaceId, poolId, now);
      this.#db
        .prepare(
          `INSERT INTO account_assignments (workspace_id, pool_id, active_account_id, state, changed_at, reason) VALUES (?, ?, ?, ?, ?, 'assigned')
           ON CONFLICT (workspace_id) DO UPDATE SET pool_id = excluded.pool_id, active_account_id = excluded.active_account_id,
             state = excluded.state, changed_at = excluded.changed_at, reason = excluded.reason`,
        )
        .run(workspaceId, poolId, account, account ? 'active' : 'waiting', now);
      // A pending unassign of the same type is superseded.
      this.#db.prepare("DELETE FROM removals WHERE workspace_id = ? AND pool_type = 'account'").run(workspaceId);
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    void this.reconciler?.request(workspaceId, 'assigned', { changed: true });
    this.onChange();
    return this.stateFor(workspaceId);
  }

  stateFor(workspaceId: string): WorkspaceAccountState | null {
    const db = this.store.db;
    if (!db) return null;
    const row = db
      .prepare(
        `SELECT a.pool_id, p.name AS pool_name, a.active_account_id, acc.name AS account_name, a.state, a.waiting_until, a.reason, a.changed_at
         FROM account_assignments a JOIN pools p ON p.id = a.pool_id LEFT JOIN accounts acc ON acc.id = a.active_account_id
         WHERE a.workspace_id = ?`,
      )
      .get(workspaceId) as
      | { pool_id: string; pool_name: string; active_account_id: string | null; account_name: string | null; state: string; waiting_until: string | null; reason: string | null; changed_at: string }
      | undefined;
    if (row) {
      const waiting = row.state === 'waiting' || !row.active_account_id;
      return {
        poolId: row.pool_id,
        poolName: row.pool_name,
        accountId: row.active_account_id,
        accountName: row.account_name,
        state: waiting ? 'waiting' : 'active',
        waitingUntil: waiting ? row.waiting_until : null,
        reason: row.reason,
        changedAt: row.changed_at,
      };
    }
    const removing = db
      .prepare("SELECT r.pool_id, p.name FROM removals r LEFT JOIN pools p ON p.id = r.pool_id WHERE r.workspace_id = ? AND r.pool_type = 'account' ORDER BY r.id DESC LIMIT 1")
      .get(workspaceId) as { pool_id: string; name: string | null } | undefined;
    return removing
      ? { poolId: removing.pool_id, poolName: removing.name ?? 'removed pool', accountId: null, accountName: null, state: 'removing', waitingUntil: null, reason: null, changedAt: null }
      : null;
  }

  /** The workspace was removed: forget its assignment (its files went with it). */
  forgetWorkspace(workspaceId: string) {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    db.prepare('DELETE FROM account_assignments WHERE workspace_id = ?').run(workspaceId);
    db.prepare("DELETE FROM assignments WHERE workspace_id = ? AND pool_type = 'account'").run(workspaceId);
    db.prepare("DELETE FROM removals WHERE workspace_id = ? AND pool_type = 'account'").run(workspaceId);
    db.prepare('DELETE FROM workspace_delivery WHERE workspace_id = ?').run(workspaceId);
    db.prepare("UPDATE exposures SET removed_at = ? WHERE workspace_id = ? AND removed_at IS NULL").run(new Date().toISOString(), workspaceId);
  }

  /* ---------- Fragment provider ---------- */

  knownPools(workspaceId: string): string[] {
    const db = this.store.db;
    if (!db) return [];
    const rows = db
      .prepare("SELECT pool_id FROM account_assignments WHERE workspace_id = ? UNION SELECT pool_id FROM removals WHERE workspace_id = ? AND pool_type = 'account'")
      .all(workspaceId, workspaceId) as { pool_id: string }[];
    return rows.map((r) => r.pool_id);
  }

  fragments(workspaceId: string, ctx: { running: boolean; now: Date }): Fragment[] {
    const db = this.store.db!;
    const a = this.#assignment(workspaceId);
    if (!a) {
      const removal = db.prepare("SELECT * FROM removals WHERE workspace_id = ? AND pool_type = 'account' ORDER BY id DESC LIMIT 1").get(workspaceId) as
        | { id: number; pool_id: string; stage: number; stage_at: string | null }
        | undefined;
      if (!removal) return [];
      // Safe unassign (§10.4): first safe values and no helper, then (a reload later) no files at all.
      const graceOver = removal.stage_at && ctx.now.getTime() - Date.parse(removal.stage_at) >= UNASSIGN_GRACE_MS;
      if (ctx.running && (removal.stage === 0 || !graceOver)) {
        return [
          {
            owner: 'account',
            pool: { id: removal.pool_id, revision: 0 },
            settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', DISABLE_LOGIN_COMMAND: '', CLAUDEPILOT_ACCOUNT: '' } },
          },
        ];
      }
      return [];
    }

    const pool = this.list().find((p) => p.id === a.pool_id);
    if (!pool || !a.active_account_id) return [];
    const account = db.prepare('SELECT id, secret FROM accounts WHERE id = ?').get(a.active_account_id) as { id: string; secret: string | null } | undefined;
    const endpoint = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(pool.endpointId) as
      | { base_url: string; model_names: string; context_tokens: number | null; max_output_tokens: number | null; disable_betas: number }
      | undefined;
    if (!account?.secret || !endpoint || !this.store.secrets) return [];
    const key = this.store.secrets.open(account.secret, { table: 'accounts', row: account.id, column: 'secret' });
    const models = JSON.parse(endpoint.model_names) as Record<string, string>;
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: endpoint.base_url,
      // Empty values cancel shell exports that would outrank the helper (FR14).
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '60000',
      CLAUDEPILOT_ACCOUNT: account.id,
      CLAUDEPILOT_WORKSPACE: workspaceId,
      DISABLE_LOGIN_COMMAND: pool.hideLogin ? '1' : '',
    };
    if (models.default) env.ANTHROPIC_MODEL = models.default;
    if (models.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = models.opus;
    if (models.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = models.sonnet;
    if (models.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = models.haiku;
    if (endpoint.context_tokens) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(endpoint.context_tokens);
    if (endpoint.max_output_tokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(endpoint.max_output_tokens);
    if (endpoint.disable_betas) env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';

    return [
      {
        owner: 'account',
        pool: { id: pool.id, revision: pool.revision },
        minClaudeVersion: MIN_CLAUDE,
        dirs: [{ path: '/etc/claudepilot/account', mode: 0o750, uid: ROOT, gid: NODE }],
        files: [
          { path: `/etc/claudepilot/account/${account.id}.key`, content: key, mode: 0o440, uid: ROOT, gid: NODE, secretRef: `account:${account.id}` },
          { path: '/etc/claudepilot/bin/account-key', content: ACCOUNT_KEY, mode: 0o755, uid: ROOT, gid: ROOT },
          { path: '/etc/claudepilot/bin/account-event', content: ACCOUNT_EVENT, mode: 0o755, uid: ROOT, gid: ROOT },
        ],
        settings: {
          apiKeyHelper: `/etc/claudepilot/bin/account-key ${account.id}`,
          env,
          hooks: { StopFailure: [{ matcher: '*', hooks: [{ type: 'command', command: '/etc/claudepilot/bin/account-event' }] }] },
        },
      },
    ];
  }

  delivered(workspaceId: string, ctx: { running: boolean; now: Date; delivered: Set<string> }) {
    const db = this.store.db;
    if (!db || !this.store.writable || this.#assignment(workspaceId)) return;
    const removal = db.prepare("SELECT * FROM removals WHERE workspace_id = ? AND pool_type = 'account' ORDER BY id DESC LIMIT 1").get(workspaceId) as
      | { id: number; stage: number }
      | undefined;
    if (!removal) return;
    const dropIn = '/etc/claude-code/managed-settings.d/40-claudepilot-account.json';
    if (ctx.delivered.has(dropIn)) {
      // Safe values are in place; come back after the grace period to remove the files.
      if (removal.stage === 0) db.prepare('UPDATE removals SET stage = 1, stage_at = ? WHERE id = ?').run(ctx.now.toISOString(), removal.id);
      setTimeout(() => void this.reconciler?.request(workspaceId, 'unassign grace'), UNASSIGN_GRACE_MS + 1000).unref();
    } else {
      // The drop-in is no longer delivered: the reconciler deletes the leftover files after its own grace.
      db.prepare('DELETE FROM removals WHERE id = ?').run(removal.id);
    }
  }
}
