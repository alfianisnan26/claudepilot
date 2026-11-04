// PILOT-1142: the rig e2e's preflight, its rendering of the bridge into a rig, and the skip it gives with no rig.
//   node --test tools/qa/bridge-rig.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { enrollSecret, median, renderBridge, rigPreflight } from './bridge-rig-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const bridgeYaml = readFileSync(join(root, 'deploy/k3s-bridge/bridge.yaml'), 'utf8');
const ns = 'dev-rig-cp-bridge';
const image = 'registry.int.isnan.me/cp-bridge:0123456789ab';

/** A fake kubectl: answers by the first matching rule; records every call. */
const fake = (rules) => {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    for (const [re, out] of rules) if (re.test(args.join(' '))) return out;
    return { code: 0, stdout: 'yes' };
  };
  return { run, calls };
};
const RIG_OK = [[/^get namespace/, { code: 0, stdout: 'true' }]];

describe('rigPreflight', () => {
  test('a namespace that is not a rig name is refused before any kubectl call', () => {
    for (const bad of ['isnan-pilot-ws-isnan', 'isnan-cp-bridge', 'default', 'dev-rig-', 'dev-rig-UP', '', undefined]) {
      const k = fake(RIG_OK);
      assert.ok(rigPreflight({ ns: bad, kubeconfig: '/tmp/k', image }, k.run).fatal, String(bad));
      assert.equal(k.calls.length, 0);
    }
  });

  test('no kubeconfig, or no image: a skip that says what to set', () => {
    const k = fake(RIG_OK);
    assert.match(rigPreflight({ ns, kubeconfig: '', image }, k.run).skip, /BRIDGE_RIG_KUBECONFIG/);
    assert.match(rigPreflight({ ns, kubeconfig: '/tmp/k', image: '' }, k.run).skip, /BRIDGE_RIG_IMAGE/);
    assert.equal(k.calls.length, 0);
  });

  test("the operator's own ~/.kube/config is refused, never used", () => {
    const k = fake(RIG_OK);
    assert.match(rigPreflight({ ns, kubeconfig: '/home/x/.kube/config', image, home: '/home/x' }, k.run).fatal, /\.kube\/config/);
    assert.match(rigPreflight({ ns, kubeconfig: '/home/x/.kube/../.kube/config', image, home: '/home/x' }, k.run).fatal, /\.kube\/config/);
    assert.equal(k.calls.length, 0);
  });

  test('a rig that is not there is a skip; a namespace without the rig label is refused', () => {
    assert.match(rigPreflight({ ns, kubeconfig: '/tmp/k', image }, fake([[/^get namespace/, { code: 1, stdout: '' }]]).run).skip, /dev-rig\.sh create/);
    assert.match(rigPreflight({ ns, kubeconfig: '/tmp/k', image }, fake([[/^get namespace/, { code: 0, stdout: '' }]]).run).fatal, /not labelled/);
  });

  test('each missing right is a skip that names it; all rights is ok', () => {
    for (const right of ['create deployments', 'delete deployments', 'create secrets', 'create pods/exec']) {
      const r = rigPreflight({ ns, kubeconfig: '/tmp/k', image }, fake([...RIG_OK, [new RegExp(`^auth can-i ${right} `), { code: 1, stdout: 'no' }]]).run);
      assert.ok(r.skip?.includes(right), `${right}: ${JSON.stringify(r)}`);
    }
    const k = fake(RIG_OK);
    assert.deepEqual(rigPreflight({ ns, kubeconfig: '/tmp/k', image }, k.run), { ok: true });
    assert.ok(k.calls.every((c) => c.includes(ns)), 'every check is scoped to the rig namespace');
  });
});

describe('renderBridge', () => {
  const portalUrl = 'http://10.42.0.7:3417';
  const out = renderBridge(bridgeYaml, { ns, image, portalUrl });

  test('the rig namespace, the image and the scratch portal; no live namespace and no further namespaces', () => {
    assert.match(out, /^\s+namespace: dev-rig-cp-bridge$/m);
    assert.ok(out.includes(`image: ${image}`));
    assert.match(out, /- name: PILOT_URL\n\s+value: "http:\/\/10\.42\.0\.7:3417"/);
    assert.match(out, /- name: PILOT_KUBE_NAMESPACE\n\s+value: "dev-rig-cp-bridge"/);
    assert.doesNotMatch(out, /PILOT_KUBE_NAMESPACES/);
    assert.doesNotMatch(out.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /isnan-(claudepilot|pilot-ws|cp-bridge)/);
    assert.match(out, /- name: PILOT_ALLOW_HTTP\n\s+value: "1"\n\s+- name: PILOT_MODE/);
  });

  test('an https portal gets no PILOT_ALLOW_HTTP', () => {
    assert.doesNotMatch(renderBridge(bridgeYaml, { ns, image, portalUrl: 'https://scratch.example' }), /PILOT_ALLOW_HTTP/);
  });

  test('refuses a live namespace, and a manifest that would keep one', () => {
    assert.throws(() => renderBridge(bridgeYaml, { ns: 'isnan-cp-bridge', image, portalUrl }), /not a rig/);
    const extra = bridgeYaml.replace('  replicas: 1', '  replicas: 1\n  # x\n  serviceName: isnan-pilot-ws-konfersi');
    assert.throws(() => renderBridge(extra, { ns, image, portalUrl }), /live namespace/);
  });
});

test('the enroll Secret is one JSON manifest for stdin, in the rig, with the token only as data', () => {
  const token = `t${'k'.repeat(5)}${Date.now()}`;
  const s = JSON.parse(enrollSecret(ns, token));
  assert.equal(s.kind, 'Secret');
  assert.equal(s.metadata.namespace, ns);
  assert.equal(s.metadata.name, 'cp-bridge-enroll');
  assert.deepEqual(s.stringData, { token });
});

test('median', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('with no rig, the script skips with a reason and exits 0, touching nothing', () => {
  const r = spawnSync(process.execPath, [join(here, 'bridge-rig.mjs')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: '/nonexistent-home', BRIDGE_RIG_KUBECONFIG: '' },
    timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^SKIP: no rig kubeconfig/);
});

test('a live namespace makes the script refuse with exit 2', () => {
  const r = spawnSync(process.execPath, [join(here, 'bridge-rig.mjs')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: '/nonexistent-home', BRIDGE_RIG_NS: 'isnan-pilot-ws-isnan', BRIDGE_RIG_KUBECONFIG: '/tmp/none' },
    timeout: 30_000,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED: BRIDGE_RIG_NS must be a rig namespace/);
});
