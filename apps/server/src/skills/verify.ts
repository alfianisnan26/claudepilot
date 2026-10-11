// Verification (Skillset FR21, FR23; §18 A7): after a delivery to a running workspace, two Claude Code
// subcommands run in it as the workspace user, with CLAUDEPILOT_VERIFY set (hook helpers exit at once)
// and nonessential traffic off. Neither starts a session nor makes a model request:
//   claude plugin details <prefix>@claudepilot   → the skills Claude Code sees in the current folder
//   claude plugin list --json                     → readFromFolder, folderVersion and load errors
// Both report the marketplace as not configured until a session has registered it, so a workspace
// nobody has used yet is "Not verified". Claude Code's own records in ~/.claude/plugins are only ever
// read through these commands. Results go to skill_inventory and the delivery event log.

import type { SkillVerifyStatus } from '@portal/contracts';
import { PLUGINS_DIR } from '../delivery/types.js';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import type { Runtime } from '../workspaces/runtime.js';
import { expectedHash, pluginId, type Expected } from './kind.js';
import { redactCredentials } from './scan.js';

/** What verification found for one set. */
export interface PluginResult {
  poolId: string;
  revision: number;
  prefix: string;
  status: Exclude<SkillVerifyStatus, 'pending'>;
  /** Claude Code's message for a load error, or what didn't match. */
  message: string | null;
  /** Skills `plugin details` listed. */
  skills: string[];
  /** The folder `plugin list` says sessions read the plugin from. */
  folder: string | null;
}

type Status = Exclude<SkillVerifyStatus, 'pending'>;
const RANK: Record<Status, number> = { verified: 0, not_verified: 1, mismatch: 2, error: 3 };
/** Re-check a workspace nobody has used yet, or one with a load error, this often. */
export const RECHECK_MS = 10 * 60_000;
/** FR23: each command gets 20 s. */
const COMMAND_TIMEOUT_MS = 20_000;
const NOT_REGISTERED = /Marketplace '?claudepilot'? not found|not configured/i;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const splitId = (id: string) => ({ target: id.slice(0, id.indexOf('/')), name: id.slice(id.indexOf('/') + 1) });
const clip = (s: string, n = 400) => redactCredentials(s.replace(/\s+/g, ' ').trim()).slice(0, n);
const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** The script: details per prefix, then the list. Prefixes are kebab-case (validated), quoted anyway. */
export function verifyScript(prefixes: string[]): string {
  return [
    'export HOME=/home/node CLAUDEPILOT_VERIFY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'cd /tmp 2>/dev/null || cd /',
    ...prefixes.flatMap((p) => [`echo ${q(`<<<cp-details ${p}>>>`)}`, `out=$(claude plugin details ${q(pluginId(p))} 2>&1); code=$?`, `printf '%s\\n' "$out" | head -c 20000`, `echo "<<<cp-exit $code>>>"`]),
    `echo '<<<cp-list>>>'`,
    'claude plugin list --json 2>/dev/null | head -c 400000',
    `echo '<<<cp-end>>>'`,
  ].join('\n');
}

/** `Skills (3)  a, b, c` → the count and names (names may be cut short on long lists). */
export function parseDetails(text: string): { count: number; names: string[] } | null {
  const m = /^\s*Skills \((\d+)\)\s*(.*)$/m.exec(text);
  if (!m) return null;
  const names = m[2]!
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/^…|\+\d+ more$/.test(s));
  return { count: Number(m[1]), names };
}

/** Turns the script's output into one result per expected set. */
export function judge(stdout: string, expected: Expected[]): PluginResult[] {
  const listPart = stdout.split('<<<cp-list>>>\n')[1]?.split('<<<cp-end>>>')[0] ?? '';
  let list: { id?: unknown; readFromFolder?: unknown; errors?: unknown; enabled?: unknown }[] = [];
  try {
    const parsed: unknown = JSON.parse(listPart.trim() || '[]');
    list = Array.isArray(parsed) ? (parsed as typeof list) : [];
  } catch {
    list = [];
  }
  return expected.map((e): PluginResult => {
    const base = { poolId: e.poolId, revision: e.revision, prefix: e.prefix };
    const section = stdout.split(`<<<cp-details ${e.prefix}>>>\n`)[1] ?? '';
    const exit = /<<<cp-exit (\d+)>>>/.exec(section);
    const details = section.slice(0, exit?.index ?? section.length);
    const code = exit ? Number(exit[1]) : -1;
    const entry = list.find((x) => x.id === pluginId(e.prefix));
    const folder = typeof entry?.readFromFolder === 'string' ? entry.readFromFolder : null;
    const errors = Array.isArray(entry?.errors) ? entry.errors.filter((x): x is string => typeof x === 'string') : [];
    // Another marketplace's plugin with the same name doesn't load next to the portal's (§12).
    const others = list.filter((x) => typeof x.id === 'string' && x.id.startsWith(`${e.prefix}@`) && x.id !== pluginId(e.prefix) && x.enabled === true).map((x) => x.id as string);
    const also = others.length ? ` ${others.join(', ')} uses the same name and doesn’t load.` : '';
    if (code !== 0 && NOT_REGISTERED.test(details)) return { ...base, status: 'not_verified', message: 'No Claude Code session has registered the portal marketplace yet.', skills: [], folder };
    if (errors.length) return { ...base, status: 'error', message: clip(errors.join(' ')) + also, skills: [], folder };
    if (code !== 0) return { ...base, status: 'error', message: clip(details) || `claude plugin details failed (exit ${code}).`, skills: [], folder };
    const seen = parseDetails(details);
    if (!seen) return { ...base, status: 'error', message: 'Claude Code’s plugin details didn’t list skills.', skills: [], folder };
    const want = [...e.skills].sort();
    const complete = seen.names.length === seen.count;
    const same = complete ? want.length === seen.names.length && want.every((n) => seen.names.includes(n)) : seen.count === want.length && seen.names.every((n) => want.includes(n));
    if (!same) return { ...base, status: 'mismatch', message: `Claude Code lists ${seen.count} skill${seen.count === 1 ? '' : 's'} (${seen.names.join(', ') || 'none'}); ${want.length} expected (${want.join(', ')}).`, skills: seen.names, folder };
    const expectedFolder = `${PLUGINS_DIR}/${e.prefix}/${e.folder}`;
    if (folder && folder !== expectedFolder) return { ...base, status: 'mismatch', message: `Sessions read it from ${folder}, not the current ${e.folder}.`, skills: seen.names, folder };
    return { ...base, status: 'verified', message: also.trim() || null, skills: seen.names, folder };
  });
}

interface InventoryRow {
  status: Status | null;
  observed_at: string | null;
  detail: string | null;
  attempts: number;
  expected: string;
  expected_hash: string | null;
  plugins: string;
}

/**
 * Runs verification when a delivery calls for it, and keeps `skill_inventory` current. One run per
 * workspace at a time. Mismatches and timeouts are retried once at the next reconcile before they're
 * reported; a load error is reported at once and may pause the set's rollout (FR23).
 */
export class SkillVerifier {
  readonly #running = new Set<string>();
  /** Inventory changed (for live pages). */
  onChange: (workspaceId: string) => void = () => {};

  constructor(
    private readonly store: Store,
    private readonly runtimes: (target: string) => Runtime | undefined,
    private readonly service: () => PoolService,
  ) {}

  #row(workspaceId: string): InventoryRow | undefined {
    return this.store.db?.prepare('SELECT * FROM skill_inventory WHERE workspace_id = ?').get(workspaceId) as InventoryRow | undefined;
  }

  #save(workspaceId: string, patch: Record<string, string | number | null>) {
    if (!this.store.writable) return;
    const db = this.store.db!;
    db.prepare('INSERT INTO skill_inventory (workspace_id) VALUES (?) ON CONFLICT (workspace_id) DO NOTHING').run(workspaceId);
    const keys = Object.keys(patch);
    if (keys.length) db.prepare(`UPDATE skill_inventory SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE workspace_id = ?`).run(...keys.map((k) => patch[k]!), workspaceId);
    this.onChange(workspaceId);
  }

  /**
   * After each delivery (the skillset kind's `delivered`): records what shipped, and verifies when the
   * shipped skills changed, a retry is due, the workspace just started after being "Not verified:
   * stopped", or a load error or unregistered marketplace is due its periodic re-check.
   */
  delivered(workspaceId: string, ctx: { running: boolean; now: Date; expected: Expected[] | null }): void {
    const row = this.#row(workspaceId);
    const expected = ctx.expected ?? [];
    const hash = ctx.expected ? expectedHash(expected) : 'none';
    const changed = row?.expected_hash !== hash;
    if (changed) {
      this.#save(workspaceId, {
        expected: JSON.stringify(expected),
        expected_hash: hash,
        // Only a change in what shipped counts for the reload notice, not the first record of it.
        changed_at: row?.expected_hash ? ctx.now.toISOString() : null,
        attempts: 0,
        ...(expected.length ? {} : { status: null, observed_at: null, plugins: '[]', skills: '[]', detail: ctx.expected ? null : 'Not delivered: Claude Code is too old for skillsets.' }),
      });
    }
    if (!expected.length) return;
    if (!ctx.running) {
      if (row?.detail !== 'stopped' || changed) this.#save(workspaceId, { status: 'not_verified', detail: 'stopped', observed_at: ctx.now.toISOString(), plugins: '[]' });
      return;
    }
    const age = row?.observed_at ? ctx.now.getTime() - new Date(row.observed_at).getTime() : Infinity;
    const due =
      changed ||
      !row?.status ||
      (row.attempts ?? 0) > 0 ||
      row.detail === 'stopped' ||
      ((row.status === 'not_verified' || row.status === 'error') && age >= RECHECK_MS);
    if (due) void this.verify(workspaceId);
  }

  /** Runs the check now (also from "Check again"). Resolves when it's recorded. */
  async verify(workspaceId: string): Promise<void> {
    if (this.#running.has(workspaceId)) return;
    const row = this.#row(workspaceId);
    const expected = json<Expected[]>(row?.expected, []);
    if (!expected.length) return;
    const { target, name } = splitId(workspaceId);
    const access = this.runtimes(target)?.delivery;
    if (!access) return;
    this.#running.add(workspaceId);
    const now = new Date();
    try {
      const state = await access.state(name);
      if (!state.running) {
        this.#save(workspaceId, { status: 'not_verified', detail: 'stopped', observed_at: now.toISOString(), plugins: '[]' });
        return;
      }
      let stdout = '';
      let timedOut = false;
      try {
        const r = await access.run(name, verifyScript(expected.map((e) => e.prefix)), { user: 'node', timeoutMs: COMMAND_TIMEOUT_MS * (expected.length + 1) });
        stdout = r.stdout;
      } catch (e) {
        timedOut = /timed out/i.test((e as Error).message);
        if (!timedOut) throw e;
      }
      const attempts = row?.attempts ?? 0;
      const results: PluginResult[] = timedOut
        ? expected.map((e) => ({ poolId: e.poolId, revision: e.revision, prefix: e.prefix, status: 'not_verified' as const, message: 'Verification timed out.', skills: [], folder: null }))
        : judge(stdout, expected);
      const status = results.reduce<Status>((worst, r) => (RANK[r.status] > RANK[worst] ? r.status : worst), 'verified');
      // FR23: a mismatch or timeout is retried once at the next reconcile before it's reported.
      if ((status === 'mismatch' || timedOut) && attempts === 0) {
        this.#save(workspaceId, { attempts: 1 });
        return;
      }
      const detail = timedOut ? 'timed out' : status === 'not_verified' ? 'no session' : null;
      this.#save(workspaceId, {
        status,
        detail,
        method: 'details',
        observed_at: now.toISOString(),
        attempts: 0,
        plugins: JSON.stringify(results),
        skills: JSON.stringify([...new Set(results.flatMap((r) => r.skills.map((s) => `${r.prefix}:${s}`)))].sort()),
      });
      this.#event(workspaceId, status, results);
      if (results.some((r) => r.status === 'error')) this.#maybePause(results.filter((r) => r.status === 'error'));
    } catch (e) {
      this.#save(workspaceId, { status: 'error', detail: clip((e as Error).message, 200), observed_at: now.toISOString() });
    } finally {
      this.#running.delete(workspaceId);
    }
  }

  #event(workspaceId: string, status: Status, results: PluginResult[]) {
    if (!this.store.writable) return;
    this.store
      .db!.prepare('INSERT INTO delivery_events (at, workspace_id, kind, details) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), workspaceId, 'skills_verified', JSON.stringify({ status, plugins: results.map((r) => ({ prefix: r.prefix, revision: r.revision, status: r.status })) }));
  }

  /**
   * FR23: when 2 workspaces, or 10% of those the revision reached (whichever is more), report a load
   * error for a set's current revision, its rollout pauses. The rest keep their revision.
   */
  #maybePause(errors: PluginResult[]) {
    const db = this.store.db;
    if (!db) return;
    for (const e of errors) {
      const pool = db.prepare("SELECT current_revision FROM pools WHERE id = ? AND type = 'skillset'").get(e.poolId) as { current_revision: number } | undefined;
      if (!pool || pool.current_revision !== e.revision) continue;
      const paused = db.prepare('SELECT rollout_paused_at FROM pool_revisions WHERE pool_id = ? AND revision = ?').get(e.poolId, e.revision) as { rollout_paused_at: string | null } | undefined;
      if (!paused || paused.rollout_paused_at) continue;
      const rows = db.prepare("SELECT plugins FROM skill_inventory WHERE status = 'error'").all() as { plugins: string }[];
      const failing = rows.filter((r) => json<PluginResult[]>(r.plugins, []).some((p) => p.poolId === e.poolId && p.revision === e.revision && p.status === 'error')).length;
      const reached = (db.prepare('SELECT count(*) AS n FROM assignments WHERE pool_id = ? AND delivered_revision = ?').get(e.poolId, e.revision) as { n: number }).n;
      if (failing >= Math.max(2, Math.ceil(0.1 * Number(reached)))) {
        try {
          this.service().pauseRollout(e.poolId, `Load error on ${failing} workspaces`);
        } catch (err) {
          console.error(`[skills] pausing ${e.poolId} failed: ${(err as Error).message}`);
        }
      }
    }
  }
}
