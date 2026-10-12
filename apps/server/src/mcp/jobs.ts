import type { McpVerifyResult } from '@portal/contracts';
import type { StepResult, WorkspaceStep, WorkspaceSteps } from '../delivery/steps.js';
import { MARKETPLACE_NAME } from '../delivery/types.js';
import type { Store } from '../store/store.js';
import type { Compiled } from './kind.js';
import { NPM_REGISTRY, VERIFY_TESTED_CLAUDE } from './spec.js';

/**
 * What the MCP set type runs inside a workspace after a delivery (MCP set PRD A4): FR16's verify,
 * §12's npm pre-installs, and FR13b's stop of a revoked version's processes. All through the
 * run-in-workspace step, as the workspace user, never inside a reconcile. None of it reads or prints
 * a secret: the verify starts no server, installs see no credential, and the kill prints only PIDs.
 */

/** §12: an install gets five minutes. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** One `claude plugin details` takes about a second; a few plugins and a slow start fit in this. */
const VERIFY_TIMEOUT_MS = 90_000;
/** A verify that couldn't tell is tried again after this long. */
const VERIFY_RETRY_MS = 10 * 60_000;
/** A failed install is retried after this, doubling, up to the cap; Retry in the UI goes at once. */
const INSTALL_BACKOFF_MS = 15 * 60_000;
const INSTALL_BACKOFF_MAX_MS = 6 * 60 * 60_000;
/** An install found "installing" this long after it started is stale (a portal restart mid-install). */
const INSTALLING_STALE_MS = INSTALL_TIMEOUT_MS + 60_000;
/** A version nobody's sets use any more leaves the workspace after this (§12). */
const UNUSED_INSTALL_MS = 14 * 24 * 60 * 60_000;
const ERROR_MAX = 400;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const tail = (s: string, max = ERROR_MAX) => {
  const t = s.trim();
  return t.length > max ? `…${t.slice(-(max - 1))}` : t;
};

/** npm package folder under the launcher's working directory, as the launcher looks for it. */
const npmFolder = (pkg: string, version: string) => `npm/${pkg}@${version}`;
const NPM_REF = /^npm:((?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Pre-installs one pinned npm package into the fixed folder (§12), atomically: the launcher never sees half of one. */
export function installScript(pkg: string, version: string, allowScripts: boolean): string {
  const folder = npmFolder(pkg, version);
  return [
    'set -e',
    // `docker exec` runs with umask 0000: without this, the packages the launcher runs would be world-writable.
    'umask 077',
    // No npm settings from the environment: the registry and the user config are fixed below.
    `for v in $(env | sed -n 's/^\\(npm_config_[A-Za-z0-9_]*\\)=.*/\\1/ip'); do unset "$v"; done`,
    'd="$HOME/.cache/claudepilot/mcp"',
    'mkdir -p "$d/npm"',
    'cd "$d"',
    `[ -f package.json ] || printf '%s\\n' '{"name":"claudepilot-mcp","private":true}' > package.json`,
    `p=${q(folder)}`,
    `if [ -f "$p/node_modules/${pkg}/package.json" ]; then echo already installed; exit 0; fi`,
    'rm -rf "$p.tmp"',
    'mkdir -p "$p.tmp"',
    [
      'npm install --prefix "$p.tmp" --no-save',
      ...(allowScripts ? [] : ['--ignore-scripts']),
      `--registry ${NPM_REGISTRY} --userconfig /dev/null --no-audit --no-fund --update-notifier=false --loglevel=error`,
      q(`${pkg}@${version}`),
    ].join(' '),
    'rm -rf "$p"',
    'mv "$p.tmp" "$p"',
    'echo installed',
  ].join('\n');
}

/**
 * Stops a revoked version's processes (FR13b, §10.4 step 4): finds them by the launcher's marker in
 * `/proc/<pid>/environ` (the launcher's arguments are gone after exec), prints only their PIDs, sends
 * SIGTERM, then SIGKILL to whatever is left after 5 s. The environment never leaves the pipe into grep.
 */
export function killScript(target: string): string {
  return [
    `t=${q(`CLAUDEPILOT_MCP_TARGET=${target}`)}`,
    'pids=',
    'for d in /proc/[0-9]*; do',
    '  [ "${d#/proc/}" = "$$" ] && continue',
    '  if tr \'\\0\' \'\\n\' < "$d/environ" 2>/dev/null | grep -qxF -- "$t"; then pids="$pids ${d#/proc/}"; fi',
    'done',
    'echo "found:$pids"',
    '[ -n "$pids" ] || exit 0',
    'kill -TERM $pids 2>/dev/null || true',
    'i=0',
    'while [ $i -lt 5 ]; do',
    '  left=',
    // Exited but not yet reaped by its parent (state Z) counts as stopped.
    '  for p in $pids; do s=$(sed \'s/.*) //\' "/proc/$p/stat" 2>/dev/null | cut -c1); [ -n "$s" ] && [ "$s" != Z ] && left="$left $p"; done',
    '  [ -n "$left" ] || break',
    '  sleep 1',
    '  i=$((i + 1))',
    'done',
    'if [ -n "$left" ]; then kill -KILL $left 2>/dev/null || true; echo "killed:$left"; fi',
    'exit 0',
  ].join('\n');
}

/** Runs `claude plugin details` for each plugin, with markers to split the output (FR16). */
export function verifyScript(plugins: string[]): string {
  return [
    'cd "$HOME" 2>/dev/null || cd /',
    'echo "<<<cp-version>>>$(claude --version 2>/dev/null | head -n 1)"',
    ...plugins.flatMap((p) => [
      `echo ${q(`<<<cp-plugin>>>${p}`)}`,
      `CLAUDEPILOT_VERIFY=1 timeout 60 claude plugin details ${q(`${p}@${MARKETPLACE_NAME}`)} 2>&1`,
      'echo "<<<cp-exit>>>$?"',
    ]),
  ].join('\n');
}

export interface VerifyOutcome {
  result: McpVerifyResult;
  servers: string[];
  detail: string | null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reads one plugin's `claude plugin details` text (FR16). It prints text only and takes no flags, so
 * this is gated on the Claude Code version the layout was seen on, and says "Not verified" otherwise.
 */
export function parseDetails(text: string, expected: { plugin: string; version: string; servers: string[] }, claudeVersion: string | null): VerifyOutcome {
  const v = /(\d+\.\d+\.\d+)/.exec(claudeVersion ?? '')?.[1] ?? null;
  if (!v || !VERIFY_TESTED_CLAUDE.includes(v))
    return { result: 'not_verified', servers: [], detail: `Not verified: its output is known for Claude Code ${VERIFY_TESTED_CLAUDE.join(', ')} only.` };
  if (/Marketplace '?claudepilot'? not found/i.test(text))
    return { result: 'not_registered', servers: [], detail: 'Not verified yet: Claude Code registers the portal’s plugins at the first session in this workspace.' };
  if (/^Plugin ".*" not found/m.test(text) || /Could not load details/.test(text)) {
    const first = text.split('\n').find((l) => l.trim()) ?? '';
    return { result: 'not_loaded', servers: [], detail: tail(first.replace(/^[✘✗×]\s*/, ''), 300) || 'Claude Code doesn’t list the plugin.' };
  }
  const line = /^\s*MCP servers \((\d+)\)(.*)$/m.exec(text);
  if (!line) return { result: 'not_verified', servers: [], detail: 'Not verified: Claude Code printed something unexpected.' };
  const listed = line[2]!
    .replace(/\(.*\)\s*$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const head = new RegExp(`^${esc(expected.plugin)} (\\S+)`, 'm').exec(text)?.[1] ?? null;
  const missing = expected.servers.filter((s) => !listed.includes(s));
  const extra = listed.filter((s) => !expected.servers.includes(s));
  const problems = [
    ...(head && head !== expected.version ? [`Claude Code reads ${head}; the portal delivered ${expected.version}.`] : []),
    ...(missing.length ? [`Not listed: ${missing.join(', ')}.`] : []),
    ...(extra.length ? [`Also listed: ${extra.join(', ')}.`] : []),
  ];
  return { result: problems.length ? 'mismatch' : 'ok', servers: listed, detail: problems.length ? problems.join(' ') : null };
}

/** Splits the verify step's output into each plugin's text. */
export function splitVerify(stdout: string): { version: string | null; plugins: Map<string, string> } {
  const version = /<<<cp-version>>>(.*)/.exec(stdout)?.[1]?.trim() || null;
  const plugins = new Map<string, string>();
  const re = /<<<cp-plugin>>>(\S+)\n([\s\S]*?)<<<cp-exit>>>/g;
  for (const m of stdout.matchAll(re)) plugins.set(m[1]!, m[2]!);
  return { version, plugins };
}

interface InstallRow {
  package_ref: string;
  state: 'installing' | 'installed' | 'failed';
  last_used_at: string | null;
  attempts: number;
  updated_at: string;
}

export class McpJobs {
  /** Something a status page shows changed. */
  onChange: () => void = () => {};
  /** The OAuth status check (§13.3), queued with the verify; set by McpSets. */
  authSteps: (compiled: Compiled, now: Date) => WorkspaceStep[] = () => [];

  constructor(
    private readonly store: Store,
    private readonly steps: WorkspaceSteps,
  ) {}

  /** After a successful reconcile of a running workspace: what to run there now. */
  afterDelivery(compiled: Compiled, ctx: { now: Date; running: boolean }) {
    if (!ctx.running || !this.store.writable) return;
    const ws = compiled.workspaceId;
    const steps: WorkspaceStep[] = [...this.#kills(compiled), ...this.#verify(compiled, ctx.now), ...this.authSteps(compiled, ctx.now), ...this.#installs(compiled, ctx.now)];
    if (steps.length) this.steps.enqueue(ws, steps);
  }

  /* ---------- FR13b: stop a revoked version's processes ---------- */

  #kills(c: Compiled): WorkspaceStep[] {
    const db = this.store.db!;
    const pending = db
      .prepare("SELECT DISTINCT target FROM mcp_delivery WHERE workspace_id = ? AND state = 'revoked' AND target LIKE '%:%' AND killed_at IS NULL")
      .all(c.workspaceId) as { target: string }[];
    return pending
      .filter((r) => /^(?:npm|cmd|pypi):/.test(r.target))
      .map((r) => ({
        owner: 'mcpset',
        key: `kill:${r.target}`,
        label: `stop ${r.target}`,
        script: killScript(r.target),
        timeoutMs: 30_000,
        done: (res: StepResult) => {
          if (res.code !== 0) return; // tried again after the next reconcile
          const found = /found:([\d ]*)/.exec(res.stdout)?.[1]?.trim() ?? '';
          const at = new Date().toISOString();
          db.prepare("UPDATE mcp_delivery SET killed_at = ? WHERE workspace_id = ? AND target = ? AND state = 'revoked' AND killed_at IS NULL").run(at, c.workspaceId, r.target);
          db.prepare('INSERT INTO delivery_events (at, workspace_id, kind, details) VALUES (?, ?, ?, ?)').run(
            at,
            c.workspaceId,
            'mcp_revoked_stopped',
            JSON.stringify({ target: r.target, pids: found ? found.split(/\s+/).map(Number) : [] }),
          );
          this.onChange();
        },
      }));
  }

  /* ---------- FR16: verify ---------- */

  #verify(c: Compiled, now: Date): WorkspaceStep[] {
    const db = this.store.db!;
    const rows = new Map(
      (db.prepare('SELECT plugin, hash12, result, at FROM mcp_verify WHERE workspace_id = ?').all(c.workspaceId) as { plugin: string; hash12: string; result: McpVerifyResult; at: string }[]).map(
        (r) => [r.plugin, r],
      ),
    );
    // Plugins no longer delivered here have nothing to verify.
    for (const plugin of rows.keys()) if (!c.plugins.some((p) => p.plugin === plugin)) db.prepare('DELETE FROM mcp_verify WHERE workspace_id = ? AND plugin = ?').run(c.workspaceId, plugin);
    const due = c.plugins.filter((p) => {
      const last = rows.get(p.plugin);
      if (!last || last.hash12 !== p.hash12) return true;
      return (last.result === 'not_registered' || last.result === 'not_loaded' || last.result === 'failed') && now.getTime() - Date.parse(last.at) >= VERIFY_RETRY_MS;
    });
    if (!due.length) return [];
    return [
      {
        owner: 'mcpset',
        key: 'verify',
        label: 'verify',
        script: verifyScript(due.map((p) => p.plugin)),
        timeoutMs: VERIFY_TIMEOUT_MS,
        done: (res) => {
          const at = new Date().toISOString();
          const { version, plugins } = splitVerify(res.stdout);
          const upsert = db.prepare(
            `INSERT INTO mcp_verify (workspace_id, plugin, hash12, result, servers, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (workspace_id, plugin) DO UPDATE SET hash12 = excluded.hash12, result = excluded.result, servers = excluded.servers,
               detail = excluded.detail, at = excluded.at`,
          );
          for (const p of due) {
            const text = plugins.get(p.plugin);
            const outcome: VerifyOutcome =
              res.code === null || text === undefined
                ? { result: 'failed', servers: [], detail: res.skipped ? `Not run: ${res.skipped}.` : tail(res.stderr || 'The verify step failed.', 300) }
                : parseDetails(text, { plugin: p.plugin, version: p.version, servers: p.servers }, version);
            upsert.run(c.workspaceId, p.plugin, p.hash12, outcome.result, JSON.stringify(outcome.servers), outcome.detail, at);
          }
          this.onChange();
        },
      },
    ];
  }

  /* ---------- §12: pre-install ---------- */

  #installs(c: Compiled, now: Date): WorkspaceStep[] {
    const db = this.store.db!;
    const at = now.toISOString();
    const rows = new Map(
      (db.prepare('SELECT package_ref, state, last_used_at, attempts, updated_at FROM mcp_installs WHERE workspace_id = ?').all(c.workspaceId) as unknown as InstallRow[]).map((r) => [
        r.package_ref,
        r,
      ]),
    );
    const wanted = new Map(c.servers.filter((s) => s.install && (s.state === 'delivered' || s.state === 'pending_start')).map((s) => [s.install!.ref, s.install!]));
    const steps: WorkspaceStep[] = [];
    for (const [ref, install] of wanted) {
      const row = rows.get(ref);
      const age = row ? now.getTime() - Date.parse(row.updated_at) : Infinity;
      if (row?.state === 'installed') {
        // Marked used at most hourly: unused versions leave after 14 days.
        if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) > 60 * 60_000)
          db.prepare('UPDATE mcp_installs SET last_used_at = ? WHERE workspace_id = ? AND package_ref = ?').run(at, c.workspaceId, ref);
        continue;
      }
      if (row?.state === 'installing' && (age < INSTALLING_STALE_MS || this.steps.queued(c.workspaceId, 'mcpset').includes(`install:${ref}`))) continue;
      if (row?.state === 'failed' && age < Math.min(INSTALL_BACKOFF_MAX_MS, INSTALL_BACKOFF_MS * 2 ** Math.max(0, row.attempts - 1))) continue;
      db.prepare(
        `INSERT INTO mcp_installs (workspace_id, package_ref, state, attempts, last_used_at, updated_at) VALUES (?, ?, 'installing', 1, ?, ?)
         ON CONFLICT (workspace_id, package_ref) DO UPDATE SET state = 'installing', attempts = attempts + 1, last_used_at = excluded.last_used_at, updated_at = excluded.updated_at`,
      ).run(c.workspaceId, ref, at, at);
      steps.push({
        owner: 'mcpset',
        key: `install:${ref}`,
        label: `install ${ref}`,
        script: installScript(install.pkg, install.version, install.allowScripts),
        timeoutMs: INSTALL_TIMEOUT_MS,
        done: (res) => {
          const done = new Date().toISOString();
          if (res.code === 0)
            db.prepare("UPDATE mcp_installs SET state = 'installed', installed_at = ?, error = NULL, updated_at = ? WHERE workspace_id = ? AND package_ref = ?").run(
              done,
              done,
              c.workspaceId,
              ref,
            );
          else {
            const why = res.skipped ? `Not run: ${res.skipped}.` : res.timedOut ? 'Took longer than 5 minutes.' : tail(`${res.stderr}\n${res.stdout}`) || `npm exited ${res.code}.`;
            db.prepare("UPDATE mcp_installs SET state = 'failed', error = ?, updated_at = ? WHERE workspace_id = ? AND package_ref = ?").run(why, done, c.workspaceId, ref);
          }
          this.onChange();
        },
      });
    }
    // Versions no set here uses any more, untouched for 14 days, leave the home volume.
    for (const [ref, row] of rows) {
      if (wanted.has(ref) || !row.last_used_at || now.getTime() - Date.parse(row.last_used_at) < UNUSED_INSTALL_MS) continue;
      const m = NPM_REF.exec(ref);
      if (!m) continue;
      steps.push({
        owner: 'mcpset',
        key: `remove:${ref}`,
        label: `remove ${ref}`,
        script: `rm -rf -- "$HOME/.cache/claudepilot/mcp/"${q(npmFolder(m[1]!, m[2]!))}`,
        timeoutMs: 60_000,
        done: (res) => {
          if (res.code === 0) db.prepare('DELETE FROM mcp_installs WHERE workspace_id = ? AND package_ref = ?').run(c.workspaceId, ref);
        },
      });
    }
    return steps;
  }

  /** Retry: failed installs go again at the next delivery, and the verify runs again. */
  retry(workspaceId: string, what: 'installs' | 'verify') {
    const db = this.store.db;
    if (!db || !this.store.writable) return;
    if (what === 'installs') db.prepare("UPDATE mcp_installs SET updated_at = '1970-01-01T00:00:00.000Z', attempts = 0 WHERE workspace_id = ? AND state = 'failed'").run(workspaceId);
    else db.prepare('DELETE FROM mcp_verify WHERE workspace_id = ?').run(workspaceId);
  }
}
