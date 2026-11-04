// PILOT-1142 (T-3700): the phase-1 exit check of the Cloudflare migration, on a rig. A scratch portal with Kubernetes OFF reaches a
// cluster only through the cp-bridge (the Connect agent in kube mode, deploy/k3s-bridge/bridge.yaml) running in a rig namespace; through
// it, the script creates a workspace, runs commands in it over the shell socket (timing each round trip), and deletes it. It then times
// the same command by `kubectl exec` straight to the pod, for the "through the bridge vs direct" number (plan risk 8).
//
//   BRIDGE_RIG_KUBECONFIG=<the rig account's kubeconfig> BRIDGE_RIG_IMAGE=registry.int.isnan.me/cp-bridge:<sha> \
//     node tools/qa/bridge-rig.mjs              [BRIDGE_RIG_NS=dev-rig-cp-bridge] [BRIDGE_RIG_PORT=3417] [BRIDGE_RIG_EXECS=10]
//
// Without the rig (no kubeconfig, no image, no rig namespace or no rights in it) it prints `SKIP: <why>` and exits 0: the rig is the
// coordinator's to make (T-3700, FOR THE COORDINATOR). It exits 2, touching nothing, when the namespace is not a rig name, is not labelled
// as a rig, or the kubeconfig is ~/.kube/config. It never names a live namespace. What it made (the bridge Deployment and its enroll Secret,
// the workspace, the scratch portal) it removes in `finally`; the rig namespace itself stays for `scripts/dev-rig.sh delete`.
// Not yet here (the rest of T-3700, once a rig exists): Skillset and Secrets delivery, chat-once, and a bridge restart mid-tail.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrollSecret, median, renderBridge, rigPreflight } from './bridge-rig-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ns = process.env.BRIDGE_RIG_NS ?? 'dev-rig-cp-bridge';
const kubeconfig = process.env.BRIDGE_RIG_KUBECONFIG ?? '';
const image = process.env.BRIDGE_RIG_IMAGE ?? '';
const port = Number(process.env.BRIDGE_RIG_PORT ?? 3417);
const execs = Math.max(3, Math.min(50, Number(process.env.BRIDGE_RIG_EXECS ?? 10)));
const code = String(10_000_000 + (randomBytes(4).readUInt32BE() % 89_999_999));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// kubectl on the rig kubeconfig only; `input` goes on stdin (the enroll Secret), never in argv.
const kubectl = (args, input) => {
  const r = spawnSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8', input, timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const must = (r, what) => {
  if (r.code !== 0) throw new Error(`${what}: ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
};

const pre = rigPreflight({ ns, kubeconfig, image }, (args) => (kubeconfig ? kubectl(args) : { code: 1, stdout: '' }));
if (pre.fatal) {
  console.error(`REFUSED: ${pre.fatal}`);
  process.exit(2);
}
if (pre.skip) {
  console.log(`SKIP: ${pre.skip}`);
  process.exit(0);
}

// The pod address a pod in the rig can dial (the scratch portal listens on every interface of this workspace pod).
const podIp = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
if (!podIp) {
  console.log('SKIP: this workspace has no non-loopback IPv4 address for the rig to dial');
  process.exit(0);
}
const portalUrl = `http://${podIp}:${port}`;
const base = `http://localhost:${port}`;
const scratch = (cmd, env = {}) =>
  spawnSync('/home/node/work/claudepilot/scripts/scratch-portal.sh', [cmd, String(port), code], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, cwd: root });

const results = { ns, image, portalUrl, steps: [] };
const step = (name, ok, detail = '') => {
  results.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

let cookie = '';
const api = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Cookie: `portal_session=${cookie}`, Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: r.status, data: json?.data, error: json?.error };
};
const until = async (what, fn, ms) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(1000);
  }
};

const target = 'rig';
const wsName = `e2e-${randomBytes(3).toString('hex')}`;
const made = { bridge: false, secret: false, workspace: false, portal: false };
let failed = false;
try {
  const started = scratch('start', { PORTAL_CONNECT_ALLOW_HTTP: 'true', PORTAL_CONNECT_URL: portalUrl });
  if (started.status !== 0) throw new Error(`scratch portal did not start: ${started.stderr.trim()}`);
  made.portal = true;
  step('scratch portal up, Kubernetes off', true, base);

  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ code }) });
  cookie = /portal_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
  if (!cookie) throw new Error(`sign-in failed: ${login.status}`);
  const scanned = await api('GET', '/api/connect/targets');
  const k8sScanned = (scanned.data ?? []).filter((t) => t.source === 'scanned' && t.kind === 'kubernetes' && t.available);
  step('the portal itself reaches no cluster', k8sScanned.length === 0, `${k8sScanned.length} scanned kubernetes target(s) available`);
  if (k8sScanned.length) throw new Error('the scratch portal has a cluster of its own: the check would not prove the bridge');

  const created = await api('POST', '/api/connect/targets', { kind: 'kubernetes', platform: 'linux', id: target, portalUrl, options: { namespace: ns }, ttlMinutes: 30, maxUses: 1 });
  if (created.status !== 201 || !created.data?.token) throw new Error(`target not made: ${created.status} ${JSON.stringify(created.error)}`);
  must(kubectl(['apply', '-f', '-'], enrollSecret(ns, created.data.token)), 'enroll Secret');
  made.secret = true;
  const manifest = renderBridge(readFileSync(join(root, 'deploy/k3s-bridge/bridge.yaml'), 'utf8'), { ns, image, portalUrl });
  must(kubectl(['apply', '-f', '-'], manifest), 'bridge Deployment');
  made.bridge = true;
  const t0 = Date.now();
  const view = await until('the bridge to connect', async () => {
    const t = await api('GET', `/api/connect/targets/${target}`);
    return t.data?.link === 'connected' && t.data.nodes?.some((n) => n.services?.some((s) => s.name === 'kube' && s.ok)) ? t.data : null;
  }, 180_000);
  step('bridge enrolled and connected', true, `${Math.round((Date.now() - t0) / 1000)} s, node ${view.nodes[0]?.name}, rtt ${view.nodes[0]?.rttMs ?? '?'} ms`);

  const ws = await api('POST', '/api/workspaces', { name: wsName, target });
  if (ws.status >= 300) throw new Error(`workspace not created: ${ws.status} ${JSON.stringify(ws.error)}`);
  made.workspace = true;
  const t1 = Date.now();
  await until('the workspace to run', async () => (await api('GET', `/api/workspaces/${target}/${wsName}`)).data?.status === 'running', 600_000);
  step('workspace created through the bridge', true, `${target}/${wsName} running after ${Math.round((Date.now() - t1) / 1000)} s`);

  const bridged = await shellRoundTrips(`/api/workspaces/${target}/${wsName}/shell`, execs);
  step('exec through the bridge', bridged.length === execs, `${bridged.length}/${execs} round trips, median ${median(bridged)} ms`);

  const pod = must(kubectl(['get', 'pods', '-n', ns, '-l', `claudepilot.workspace=${wsName}`, '-o', 'jsonpath={.items[0].metadata.name}']), 'workspace pod').trim();
  const direct = [];
  for (let i = 0; pod && i < execs; i++) {
    const s = performance.now();
    if (kubectl(['exec', '-n', ns, pod, '--', 'echo', `cp-direct-${i}`]).code === 0) direct.push(Math.round(performance.now() - s));
  }
  step('exec direct (kubectl exec)', direct.length === execs, pod ? `${direct.length}/${execs}, median ${median(direct)} ms (a fresh exec each, so it is an upper bound)` : 'pod not found by label');
  results.latency = { bridgedShellEchoMs: bridged, directKubectlExecMs: direct, medianBridged: median(bridged), medianDirect: median(direct) };

  const del = await api('DELETE', `/api/workspaces/${target}/${wsName}`);
  await until('the workspace to go', async () => (await api('GET', `/api/workspaces/${target}/${wsName}`)).status === 404, 300_000);
  made.workspace = false;
  step('workspace deleted through the bridge', del.status < 300, `DELETE ${del.status}`);
} catch (e) {
  failed = true;
  step('run', false, e instanceof Error ? e.message : String(e));
} finally {
  if (made.workspace) await api('DELETE', `/api/workspaces/${target}/${wsName}`).catch(() => {});
  if (made.bridge) kubectl(['delete', 'deployment', 'cp-bridge', '-n', ns, '--ignore-not-found', '--wait=false']);
  if (made.secret) kubectl(['delete', 'secret', 'cp-bridge-enroll', '-n', ns, '--ignore-not-found']);
  if (made.portal) scratch('stop');
}
if (results.steps.some((s) => !s.ok)) failed = true;
console.log(JSON.stringify({ result: failed ? 'FAIL' : 'PASS', ...results }));
process.exit(failed ? 1 : 0);

// Opens the workspace's shell socket and times `echo <marker>` until the marker comes back, n times on the one shell (the bridge's
// exec stream stays open: this is the round trip a person feels when typing).
async function shellRoundTrips(path, n) {
  const { default: WebSocket } = await import('ws');
  const sock = new WebSocket(`ws://localhost:${port}${path}?cols=120&rows=30`, { headers: { Cookie: `portal_session=${cookie}`, Origin: base } });
  let buf = '';
  sock.on('message', (data, isBinary) => {
    if (isBinary) buf += Buffer.from(data).toString('utf8');
  });
  await new Promise((res, rej) => {
    sock.once('open', res);
    sock.once('error', rej);
  });
  await sleep(1500); // the prompt
  const out = [];
  for (let i = 0; i < n; i++) {
    const marker = `cprt${i}x${randomBytes(3).toString('hex')}`;
    buf = '';
    const s = performance.now();
    // The marker is split so the typed echo of the command line does not match; only the output does.
    sock.send(Buffer.from(`echo ${marker.slice(0, 4)}""${marker.slice(4)}\r`));
    const t0 = Date.now();
    while (!buf.includes(marker) && Date.now() - t0 < 15_000) await sleep(2);
    if (buf.includes(marker)) out.push(Math.round(performance.now() - s));
  }
  sock.close();
  return out;
}
