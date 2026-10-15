// Test kit for delivery into Kubernetes workspaces (kubernetesDelivery.ts), on the in-process fake API server (connect/agent/testkit/fakeKube.ts):
// no cluster, no kubeconfig (KUBERNETES SAFETY RULE). Three kinds of pod answer the exec:
// - `localPod`: runs the exec's argv for real on this machine with a stand-in `sudo` first on PATH (it runs the command as the caller, or
//   refuses, or is missing), so the wrapper scripts themselves are what is tested; delivery is pointed at a temporary folder.
// - `memoryPod`: decodes the delivery protocol (counted payload, script, archive, path) and keeps the files in memory, running the handful of
//   commands the delivery engine sends (the reconciler's end-to-end test).
// - `dockerPod`: `docker exec -i -u 1000:1000` into a throwaway container of the real workspace image: uid 1000, root-owned /etc/claude-code,
//   the image's sudo (CLAUDEPILOT_DOCKER_TESTS=1 only).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { KubeConfig } from '@kubernetes/client-node';
import { extract } from 'tar-stream';
import type { ExecIo, FakeKube } from '../connect/agent/testkit/fakeKube.js';
import { pluginDir, treeHash } from '../delivery/marketplace.js';
import { MANIFEST_PATH, type Manifest } from '../delivery/types.js';
import { KubernetesRuntime } from './kubernetes.js';
import { PUT_INNER, READ_INNER, RUN_INNER } from './kubernetesDelivery.js';

/** A KubernetesRuntime on the fake (its namespace, its token), as an enrolled cluster would make one: never `loadFromDefault()`. */
export function kubeRuntimeOn(fake: FakeKube, delivery?: { roots?: readonly string[]; pollMs?: number }, { targetId = 'kd-kube', ...extra }: { fitCheck?: boolean; targetId?: string } = {}): KubernetesRuntime {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'fake', server: fake.url, skipTLSVerify: true }],
    users: [{ name: 'portal', token: fake.token }],
    contexts: [{ name: 'fake', cluster: 'fake', user: 'portal' }],
    currentContext: 'fake',
  });
  return new KubernetesRuntime(
    { namespace: fake.namespace, image: 'claudepilot-workspace:latest', storage: '1Gi', ...(delivery ? { delivery } : {}), ...extra },
    { kubeConfig: kc, manageNamespace: false, target: { id: targetId, label: 'Kube', where: 'fake' } },
  );
}

/** One exec as the delivery protocol says it: who it runs as, which inner script, and the payload cut at its counts. */
export interface DeliveryExec {
  user: string;
  kind: 'run' | 'put' | 'read' | 'other';
  argv: string[];
  first: Buffer;
  second: Buffer;
}

/** Collects an exec's stdin up to the payload's count (argv[5]) and splits it at argv[7]. */
function decode(io: ExecIo, fn: (e: DeliveryExec) => void) {
  const argv = io.command;
  const inner = argv[6];
  const kind = inner === RUN_INNER ? 'run' : inner === PUT_INNER ? 'put' : inner === READ_INNER ? 'read' : 'other';
  const total = Number(argv[5] ?? 0);
  const firstLength = Number(argv[7] ?? 0);
  const chunks: Buffer[] = [];
  let got = 0;
  const done = () => {
    const all = Buffer.concat(chunks).subarray(0, total);
    fn({ user: argv[4] ?? '', kind, argv, first: all.subarray(0, firstLength), second: all.subarray(firstLength) });
  };
  if (total === 0) return void setImmediate(done);
  io.onStdin((d) => {
    if (got >= total) return;
    chunks.push(d);
    got += d.length;
    if (got >= total) done();
  });
}

/**
 * Runs each exec's argv here, as this user, in `cwd`, with `bin` first on PATH. `sudo`: `ok` runs the command after `-n` (as the caller: owners
 * are not checked this way), `refused` says a password is required, `missing` leaves no sudo on a PATH of only the tools the wrapper needs.
 */
export function localPod(fake: FakeKube, dir: string, sudo: 'ok' | 'refused' | 'missing' = 'ok') {
  const bin = join(dir, `bin-${sudo}`);
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'sudo.log');
  if (sudo === 'ok') writeFileSync(join(bin, 'sudo'), `#!/bin/sh\necho "$*" >> '${log}'\n[ "$1" = -n ] && shift\nexec "$@"\n`);
  if (sudo === 'refused') writeFileSync(join(bin, 'sudo'), '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n');
  if (sudo !== 'missing') chmodSync(join(bin, 'sudo'), 0o755);
  else for (const tool of ['sh', 'id', 'head', 'wc', 'cat', 'tar']) symlinkSync(`/usr/bin/${tool}`.replace('/usr/bin/sh', '/bin/sh'), join(bin, tool));
  const PATH = sudo === 'missing' ? bin : `${bin}:/usr/local/bin:/usr/bin:/bin`;
  const execs: string[][] = [];
  fake.onExec = (io) => {
    execs.push(io.command);
    const child = spawn(io.command[0]!, io.command.slice(1), { cwd: dir, env: { PATH, HOME: dir, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => undefined); // the command stops reading once it has its bytes
    io.onStdin((d) => void child.stdin.write(d));
    child.stdout.on('data', (d: Buffer) => io.stdout(d));
    child.stderr.on('data', (d: Buffer) => io.stderr(d));
    child.on('close', (code) => io.exit(code ?? 1));
  };
  return { execs, sudoLog: log };
}

/** A pod of the real workspace image: each exec is `docker exec -i -u 1000:1000` into `container` (stdin never closed, as the API's isn't). */
export function dockerPod(fake: FakeKube, container: string) {
  const execs: DeliveryExec[] = [];
  fake.onExec = (io) => {
    decode(io, (e) => execs.push(e));
    const child = spawn('docker', ['exec', '-i', '-u', '1000:1000', '-w', '/home/node', container, ...io.command], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => undefined);
    io.onStdin((d) => void child.stdin.write(d));
    child.stdout.on('data', (d: Buffer) => io.stdout(d));
    child.stderr.on('data', (d: Buffer) => io.stderr(d));
    child.on('close', (code) => io.exit(code ?? 1));
  };
  return { execs };
}

const unquote = (s: string) => s.replace(/'\\''/g, "'");
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * A pod whose files live in memory, served through the real protocol: `put` archives are unpacked with their owners and modes, `read`
 * answers a file or exit 3, and `run` executes what the delivery engine sends (the applied-state read, the move script, the readable check);
 * anything else exits 127, so a new kind of command shows up as a failure here instead of passing unseen.
 */
export function memoryPod(fake: FakeKube) {
  const files = new Map<string, { content: string; mode: number; uid: number; gid: number }>();
  const dirs = new Map<string, { mode: number; uid: number; gid: number }>();
  const execs: DeliveryExec[] = [];
  const within = (root: string) => (p: string) => p === root || p.startsWith(`${root}/`);
  const removeTree = (root: string) => {
    for (const k of [...files.keys()]) if (within(root)(k)) files.delete(k);
    for (const d of [...dirs.keys()]) if (within(root)(d)) dirs.delete(d);
  };
  const moveTree = (from: string, to: string) => {
    for (const [k, v] of [...files]) if (within(from)(k)) (files.delete(k), files.set(to + k.slice(from.length), v));
    for (const [d, v] of [...dirs]) if (within(from)(d)) (dirs.delete(d), dirs.set(to + d.slice(from.length), v));
  };
  const tree = (dir: string) =>
    dirs.has(dir) ? treeHash([...files].filter(([k]) => k.startsWith(`${dir}/`)).map(([k, v]) => ({ path: k.slice(dir.length + 1), content: v.content, mode: v.mode }))) : null;

  const applied = (script: string) => {
    const raw = files.get(MANIFEST_PATH)?.content ?? '';
    let out = `${raw}<<<cp-hashes>>>\n`;
    if (raw) {
      const m = JSON.parse(raw) as Manifest;
      for (const p of Object.keys(m.files)) out += `${files.has(p) ? sha256(files.get(p)!.content) : '-'} ${p}\n`;
      if (script.includes('CP_TREES=1 ')) {
        out += '<<<cp-trees>>>\n';
        for (const p of m.plugins ?? []) out += `${tree(pluginDir(p.name, p.treeHash)) ?? '-'} ${pluginDir(p.name, p.treeHash)}\n`;
      }
    }
    return `${out}<<<cp-claude>>>\n<<<cp-version>>>\n2.1.296 (Claude Code)\n`;
  };

  const run = (script: string, stdin: string): { code: number; out: string; err: string } => {
    if (script.includes('<<<cp-hashes>>>')) return { code: 0, out: applied(script), err: '' };
    if (script.startsWith('while IFS= read -r f; do [ -r "$f" ]')) {
      const missing = stdin.split('\n').filter((p) => p && !files.has(p));
      return { code: 0, out: missing.map((p) => `${p}\n`).join(''), err: '' };
    }
    for (const line of script.split('\n')) {
      let m: RegExpExecArray | null;
      if (line === 'set -e') continue;
      if ((m = /^mv -f '([^']*)' '([^']*)'$/.exec(line))) {
        const [from, to] = [unquote(m[1]!), unquote(m[2]!)];
        if (!files.has(from)) return { code: 1, out: '', err: `mv: ${from}: No such file` };
        files.set(to, files.get(from)!);
        files.delete(from);
      } else if ((m = /^mv -T -- '([^']*)' '([^']*)'$/.exec(line))) moveTree(m[1]!, m[2]!);
      else if ((m = /^if \[ -e '([^']*)' \]; then mv -T -- '([^']*)' '([^']*)'; fi$/.exec(line))) {
        if (dirs.has(m[1]!)) moveTree(m[2]!, m[3]!);
      } else if ((m = /^rm -rf -- '([^']*)'$/.exec(line))) removeTree(m[1]!);
      else if ((m = /^rmdir --ignore-fail-on-non-empty -- '([^']*)' 2>\/dev\/null \|\| true$/.exec(line))) {
        const dir = m[1]!;
        if (![...dirs.keys(), ...files.keys()].some((p) => p.startsWith(`${dir}/`))) dirs.delete(dir);
      } else if ((m = /^rm -f '([^']*)'$/.exec(line))) files.delete(m[1]!);
      else if ((m = /^for x in '([^']*)'\/\.\*\.cp-tmp; do/.exec(line))) {
        for (const d of [...dirs.keys()]) if (dirname(d) === m[1] && basename(d).startsWith('.') && d.endsWith('.cp-tmp')) removeTree(d);
      } else return { code: 127, out: '', err: `memoryPod: unexpected command: ${line.slice(0, 200)}` };
    }
    return { code: 0, out: '', err: '' };
  };

  const put = async (archive: Buffer) => {
    const ex = extract();
    const done = (async () => {
      for await (const entry of ex) {
        const h = entry.header;
        const path = `/${h.name.replace(/\/$/, '')}`;
        const chunks: Buffer[] = [];
        for await (const c of entry) chunks.push(c as Buffer);
        const meta = { mode: (h.mode ?? 0) & 0o7777, uid: h.uid ?? -1, gid: h.gid ?? -1 };
        if (h.type === 'directory') dirs.set(path, meta);
        else files.set(path, { content: Buffer.concat(chunks).toString('utf8'), ...meta });
      }
    })();
    ex.end(archive);
    await done;
  };

  fake.onExec = (io) =>
    decode(io, (e) => {
      execs.push(e);
      void (async () => {
        if (e.kind === 'run') {
          const r = run(e.first.toString('utf8'), e.second.toString('utf8'));
          if (r.out) io.stdout(r.out);
          if (r.err) io.stderr(r.err);
          return io.exit(r.code);
        }
        if (e.kind === 'put') {
          await put(e.second);
          return io.exit(0);
        }
        if (e.kind === 'read') {
          const f = files.get(e.first.toString('utf8'));
          if (!f) return io.exit(3);
          io.stdout(f.content);
          return io.exit(0);
        }
        io.stderr('memoryPod: not a delivery exec');
        io.exit(127);
      })().catch((err: unknown) => (io.stderr(String(err)), io.exit(1)));
    });
  return { files, dirs, execs };
}
