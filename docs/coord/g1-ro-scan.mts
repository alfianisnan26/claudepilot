// G1: runs the REAL repos scan pipeline over a folder through a throwaway container with NO network and a READ-ONLY mount, printing counts only.
//   - the owner's pool:  RO_IMG=<a local image with git and jq> node --import tsx --disable-warning=ExperimentalWarning g1-ro-scan.mts   (uses COORD/ro-mount.sh konfersi-universe)
//   - a dry run here:    RO_LOCAL=/some/folder RO_IMG=claudepilot-workspace:latest [RO_USER=0:0] node --import tsx ... g1-ro-scan.mts   (docker run on the dev container's own daemon)
// The host script is written into /dev/shm of the container (the root file system is read-only); git runs with safe.directory=* through the
// environment, because the mounted files belong to another user. Run it from /workspaces/claudepilot/apps/server.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CP_SESSION } from '/workspaces/claudepilot/apps/server/src/chat/host.ts';
import { Store } from '/workspaces/claudepilot/apps/server/src/store/store.ts';
import { generateSecretKey, parseSecretKey } from '/workspaces/claudepilot/apps/server/src/store/secretBox.ts';
import { ReposService } from '/workspaces/claudepilot/apps/server/src/repos/service.ts';

const COORD = '/tmp/claude-1000/-workspaces-claudepilot/cad07383-74ea-4f0a-88e5-fc51c5b7a125/scratchpad/coord';
const IMG = process.env.RO_IMG ?? 'node:22-bookworm-slim';
const LOCAL = process.env.RO_LOCAL;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
let calls = 0;

const run = (args: string[]): Promise<{ code: number | null; out: string }> =>
  new Promise((resolve, reject) => {
    calls++;
    const cmd = [
      `cat > /dev/shm/cp-session <<'EOF_CP_SCRIPT_END'`,
      CP_SESSION.replace(/\n$/, ''),
      `EOF_CP_SCRIPT_END`,
      `TMPDIR=/dev/shm CLAUDEPILOT_FILES_ROOT=/c GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null sh /dev/shm/cp-session ${args.map(q).join(' ')}`,
    ].join('\n');
    const child = LOCAL
      ? spawn('docker', ['run', '--rm', '--network', 'none', '--read-only', ...(process.env.RO_USER ? ['--user', process.env.RO_USER] : []), '-v', `${LOCAL}:/c:ro`, '-w', '/c', IMG, 'sh', '-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(`${COORD}/ro-mount.sh`, ['konfersi-universe', cmd], { env: { ...process.env, IMG }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });

const dir = mkdtempSync(join(tmpdir(), 'gt-roscan-'));
const store = await Store.open({ dataDir: dir, secretKey: parseSecretKey(generateSecretKey()) });
const repos = new ReposService({
  store,
  host: { ensure: async () => undefined, run: async (_ws, args) => run(args) },
  workspaces: async () => [{ id: 'docker/ro', name: 'ro', running: true }],
  sessions: { list: () => [], onEvent: () => () => undefined },
  scrub: (_ws, t) => t,
  notify: () => undefined,
  config: { auto: false, scanBudgetMs: 600_000 },
});
const t0 = Date.now();
try {
  const w = await repos.scanWorkspace('docker/ro', { actor: 'ui' });
  const kinds: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const errors: Record<string, number> = {};
  let maxDepth = 0;
  for (const n of w.repos) {
    kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
    maxDepth = Math.max(maxDepth, n.depth);
    for (const r of n.attention.reasons) reasons[r] = (reasons[r] ?? 0) + 1;
    if (n.error) errors[n.error] = (errors[n.error] ?? 0) + 1;
  }
  // aggregates only: no names, no paths, no commit text
  const hosts = new Set<string>();
  const remoteCounts: Record<string, number> = {};
  let withFilters = 0;
  let withStash = 0;
  let onBranch = 0;
  let withUpstream = 0;
  const fetchAgeDays: number[] = [];
  for (const n of w.repos) {
    const st = n.state;
    if (!st) continue;
    const k = String(Math.min(st.remotes.length, 2));
    remoteCounts[k] = (remoteCounts[k] ?? 0) + 1;
    for (const r of st.remotes) {
      const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^:/]+)/i.exec(r.url);
      if (m) hosts.add(m[1]!);
    }
    if (st.filters > 0) withFilters++;
    if (st.stash > 0) withStash++;
    if (st.branch) onBranch++;
    if (st.upstream) withUpstream++;
    if (st.fetchedAt) fetchAgeDays.push(Math.round((Date.now() - Date.parse(st.fetchedAt)) / 86_400_000));
  }
  fetchAgeDays.sort((a, b) => a - b);
  const extra = { remotesPerRepo: remoteCounts, distinctRemoteHosts: [...hosts].sort(), withFilters, withStash, onBranch, withUpstream, neverFetched: w.repos.filter((n) => n.state && !n.state.fetchedAt).length, fetchAgeDaysMedian: fetchAgeDays.length ? fetchAgeDays[Math.floor(fetchAgeDays.length / 2)] : null, fetchAgeDaysMax: fetchAgeDays.length ? fetchAgeDays[fetchAgeDays.length - 1] : null };
  console.log(JSON.stringify({ extra, seconds: Math.round((Date.now() - t0) / 100) / 10, hostCalls: calls, scan: { ms: w.scan.ms, truncated: w.scan.truncated, error: w.scan.error }, nodes: w.repos.length, kinds, maxDepth, summary: w.summary, attentionReasons: reasons, errors, events: repos.events({ limit: 200 }).events.length }, null, 1));
} finally {
  repos.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
