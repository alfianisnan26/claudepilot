// scripts/ws-resources.sh: the narrow door for a workspace's CPU and memory, against a fake kubectl that serves a node, its pods and one Deployment.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO, 'scripts/ws-resources.sh');
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const deployment = (over: { managed?: boolean; container?: string } = {}) => ({
  metadata: { name: 'ws-box', labels: over.managed === false ? {} : { 'claudepilot.managed': 'true' } },
  spec: { template: { spec: { containers: [{ name: over.container ?? 'workspace', resources: { requests: { cpu: '250m', memory: '1Gi' }, limits: { cpu: '4', memory: '8Gi' } } }] } } },
});
const pod = (ns: string, cpu: string, memory: string, labels: Record<string, string> = {}) => ({
  metadata: { namespace: ns, labels },
  spec: { nodeName: 'n1', containers: [{ resources: { requests: { cpu, memory } } }] },
  status: { phase: 'Running' },
});

function world(opts: { otherCpu?: string; managed?: boolean; container?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-wsres-'));
  roots.push(root);
  mkdirSync(join(root, 'bin'));
  const w = (f: string, v: unknown) => writeFileSync(join(root, f), JSON.stringify(v));
  w('deploy.json', deployment(opts));
  w('node.json', { status: { allocatable: { cpu: '8', memory: '16Gi' } } });
  w('pods.json', { items: [pod('isnan-claudepilot-workspaces', '250m', '1Gi', { 'claudepilot.workspace': 'box' }), pod('other', opts.otherCpu ?? '3', '4Gi')] });
  const kubectl = `#!/usr/bin/env bash
args="$*"
case "$args" in
  *"get deploy ws-box -o json"*) cat "${root}/deploy.json" ;;
  *"get deploy "*) exit 1 ;;
  *"get pods -l claudepilot.workspace=box"*) printf n1 ;;
  *"get node n1 -o json"*) cat "${root}/node.json" ;;
  *"get pods -A -o json"*) cat "${root}/pods.json" ;;
  *" patch "*) printf '%s\\n' "$args" >> "${root}/patched" ;;
  *) echo "unexpected kubectl $args" >&2; exit 9 ;;
esac
`;
  writeFileSync(join(root, 'bin/kubectl'), kubectl);
  chmodSync(join(root, 'bin/kubectl'), 0o755);
  const run = (...a: string[]) => {
    const r = spawnSync('bash', [SCRIPT, ...a], { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { run, patched: () => (existsSync(join(root, 'patched')) ? readFileSync(join(root, 'patched'), 'utf8') : '') };
}

test('a dry run says what changes and whether it fits, and patches nothing', () => {
  const w = world();
  const r = w.run('box', '--cpu-request', '1', '--memory-request', '2Gi');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /cpu request 250m -> 1, limit 4 -> 4; {2}memory request 1Gi -> 2Gi/);
  assert.match(r.out, /fit on n1: the other pods request 3000m and 4096Mi, this one would ask 1000m and 2048Mi, the node can allocate 8000m and 16384Mi/);
  assert.match(r.out, /dry run: nothing changed/);
  assert.equal(w.patched(), '');
});

test('--apply patches the workspace container\'s resources and one annotation, nothing else', () => {
  const w = world();
  const r = w.run('box', '--cpu-request', '1', '--memory-request', '2Gi', '--apply');
  assert.equal(r.code, 0, r.out);
  const line = w.patched();
  assert.match(line, /-n isnan-claudepilot-workspaces patch deploy ws-box --type=strategic -p /);
  const body = JSON.parse(line.slice(line.indexOf('-p ') + 3)) as { metadata: { annotations: Record<string, string> }; spec: { template: { spec: { containers: { name: string; resources: Record<string, Record<string, string>> }[] } } } };
  assert.deepEqual(Object.keys(body), ['metadata', 'spec']);
  assert.deepEqual(Object.keys(body.metadata.annotations), ['claudepilot.resources-changed']);
  assert.deepEqual(body.spec.template.spec.containers, [{ name: 'workspace', resources: { requests: { cpu: '1', memory: '2Gi' } } }], 'limits are left out when not asked');
});

test('refused: a request that does not fit the node (nothing is patched, exit 3)', () => {
  const w = world({ otherCpu: '7500m' });
  const r = w.run('box', '--cpu-request', '1', '--apply');
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /does not fit on n1/);
  assert.equal(w.patched(), '');
});

test('refused: a request above the limit, a bad quantity, a bad name, a Deployment that is not a managed workspace', () => {
  const w = world();
  assert.match(w.run('box', '--cpu-request', '5', '--apply').out, /request 5 is above the limit 4/);
  assert.match(w.run('box', '--memory-request', '9Gi', '--apply').out, /memory request 9Gi is above the limit 8Gi/);
  assert.match(w.run('box', '--memory-request', '2GB', '--apply').out, /not a memory quantity/);
  assert.match(w.run('box', '--cpu-request', '1; rm -rf /', '--apply').out, /not a CPU quantity/);
  assert.match(w.run('Box;x', '--cpu-request', '1').out, /is not a workspace name/);
  assert.match(w.run('nope', '--cpu-request', '1').out, /no Deployment ws-nope/);
  assert.match(w.run('box').out, /nothing to change/);
  assert.match(world({ managed: false }).run('box', '--cpu-request', '1').out, /not labelled claudepilot\.managed=true/);
  assert.match(world({ container: 'sidecar' }).run('box', '--cpu-request', '1').out, /not "workspace"/);
  assert.equal(w.patched(), '');
});
