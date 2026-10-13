// T-STATIC (PRD §13.5, §19.3): the Kubernetes manifest's golden file and structure test, and kubeconform on it (Docker image, opt-in
// with CLAUDEPILOT_DOCKER_TESTS=1). No kubectl, no cluster: `kubectl apply --dry-run=client` needs an API server for discovery.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadAll } from 'js-yaml';
import { FETCHER } from './fetcher.js';
import { buildManifest, ROLE_RULES, type ManifestInput } from './manifest.js';
import { BUNDLE_FIXTURE, CONFIG_FIXTURE, enrollment, targetRecord } from './testkit.js';

type Doc = { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string> }; [k: string]: unknown };
const TOKEN = `cpen_${'C'.repeat(43)}`;
const input = (over: Partial<ManifestInput> = {}): ManifestInput => ({
  enrollment: enrollment(),
  target: targetRecord('kubernetes', { settings: { namespace: 'cx4-ns' } }),
  options: {},
  bundle: BUNDLE_FIXTURE,
  config: CONFIG_FIXTURE,
  token: TOKEN,
  ...over,
});

test('the manifest is its golden file', () => {
  const text = buildManifest(input({ token: '<token>' }));
  const file = new URL('./testdata/manifest-kubernetes.yaml', import.meta.url);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(file, text);
  assert.equal(text, readFileSync(file, 'utf8'), 'UPDATE_GOLDEN=1 to accept a change');
});

test('the manifest’s structure: namespaced objects, the Role of §13.5, restricted pods, labels, the token only in its Secret', () => {
  const text = buildManifest(input());
  const docs = loadAll(text) as Doc[];
  assert.deepEqual(
    docs.map((d) => `${d.apiVersion} ${d.kind}`),
    ['v1 Namespace', 'v1 ServiceAccount', 'rbac.authorization.k8s.io/v1 Role', 'rbac.authorization.k8s.io/v1 RoleBinding', 'v1 Secret', 'apps/v1 Deployment'],
  );
  // The installer drops the Namespace by cutting at the first `---` line when the namespace exists.
  const rest = text.slice(text.indexOf('\n---\n') + 5);
  assert.equal((loadAll(rest) as Doc[])[0]!.kind, 'ServiceAccount');
  const [ns, ...objects] = docs;
  assert.equal(ns!.metadata.name, 'cx4-ns');
  assert.equal(ns!.metadata.labels?.['claudepilot.managed'], 'true');
  assert.equal(ns!.metadata.labels?.['pod-security.kubernetes.io/enforce'], 'baseline', 'the API server refuses privileged pods there too (T6)');
  for (const d of objects) {
    assert.equal(d.metadata.namespace, 'cx4-ns', `${d.kind} is namespaced`);
    assert.equal(d.metadata.labels?.['app.kubernetes.io/part-of'], 'claudepilot-connect');
    assert.equal(d.metadata.labels?.['claudepilot.connect/target'], 'cx4-lab');
    assert.equal(d.metadata.labels?.['claudepilot.managed'], undefined, 'never a workspace');
  }
  const role = docs.find((d) => d.kind === 'Role') as Doc & { rules: { apiGroups: string[]; resources: string[]; verbs: string[] }[] };
  assert.deepEqual(role.rules.map((r) => [r.apiGroups[0], r.resources, r.verbs]), ROLE_RULES);
  assert.ok(!role.rules.some((r) => r.verbs.includes('*') || r.resources.includes('*')));
  assert.ok(!docs.some((d) => /Cluster/.test(d.kind)), 'no cluster-scoped RBAC');
  const secret = docs.find((d) => d.kind === 'Secret') as Doc & { stringData: { token: string } };
  assert.equal(secret.stringData.token, TOKEN);
  assert.equal(text.split(TOKEN).length, 2, 'the token appears once, in the Secret');

  const dep = docs.find((d) => d.kind === 'Deployment') as Doc & { spec: any };
  assert.equal(dep.spec.replicas, 1);
  assert.equal(dep.spec.strategy.type, 'Recreate');
  const pod = dep.spec.template.spec;
  assert.equal(dep.spec.template.metadata.labels['claudepilot.managed'], undefined);
  // A new command is a new template, so applying it restarts the agent with the new token (T6: a revoked node could not be enrolled again).
  assert.equal(dep.spec.template.metadata.annotations['claudepilot.connect/enrollment'], input().enrollment.id);
  assert.notEqual(buildManifest(input({ enrollment: { ...input().enrollment, id: 'en_other0000000' } })), text);
  assert.deepEqual(pod.securityContext, { runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534, fsGroup: 65534, seccompProfile: { type: 'RuntimeDefault' } });
  for (const c of [...pod.initContainers, ...pod.containers]) {
    assert.deepEqual(c.securityContext, { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    assert.deepEqual(c.resources, { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } });
    assert.equal(c.image, CONFIG_FIXTURE.baseImage);
  }
  const [fetch] = pod.initContainers;
  assert.deepEqual(fetch.command, ['node', '-e', FETCHER, '$(PILOT_BUNDLE_URL)', '$(PILOT_BUNDLE_SHA256)', '/agent/agent.mjs']);
  const env: Record<string, any> = Object.fromEntries((pod.containers[0].env as { name: string; value?: string; valueFrom?: any }[]).map((e) => [e.name, e]));
  assert.equal(env.PILOT_MODE.value, 'kubernetes');
  assert.equal(env.PILOT_KUBE_NAMESPACE.valueFrom.fieldRef.fieldPath, 'metadata.namespace');
  assert.deepEqual(env.PILOT_ENROLL_TOKEN.valueFrom.secretKeyRef, { name: 'claudepilot-agent-enroll', key: 'token', optional: true });
  assert.equal(env.PILOT_BUNDLE_SHA256.value, BUNDLE_FIXTURE.sha256);
  assert.equal(env.PILOT_ALLOW_HTTP, undefined);
});

test('a private CA adds a ConfigMap and NODE_EXTRA_CA_CERTS; a plain-http lab portal sets PILOT_ALLOW_HTTP', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
  const docs = loadAll(
    buildManifest(input({ options: { privateCa: true }, config: { ...CONFIG_FIXTURE, caPem: pem }, target: targetRecord('kubernetes', { portalUrl: 'http://10.0.0.5:3000' }) })),
  ) as (Doc & { spec?: any; data?: Record<string, string> })[];
  assert.equal(docs.find((d) => d.kind === 'ConfigMap')!.data!['ca.pem'], pem);
  const agent = docs.find((d) => d.kind === 'Deployment')!.spec.template.spec.containers[0];
  const names = (agent.env as { name: string }[]).map((e) => e.name);
  assert.ok(names.includes('NODE_EXTRA_CA_CERTS') && names.includes('PILOT_CA') && names.includes('PILOT_ALLOW_HTTP'));
});

test('kubeconform accepts the manifest (Docker image, CLAUDEPILOT_DOCKER_TESTS=1)', { skip: process.env.CLAUDEPILOT_DOCKER_TESTS !== '1' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx4-kc-'));
  try {
    writeFileSync(join(dir, 'm.yaml'), buildManifest(input({ options: { privateCa: true }, config: { ...CONFIG_FIXTURE, caPem: 'x' } })));
    const out = execFileSync('docker', ['run', '--rm', '--name', 'cx4-kubeconform', '-v', `${dir}:/m:ro`, 'ghcr.io/yannh/kubeconform:latest', '-strict', '-summary', '/m/m.yaml'], {
      encoding: 'utf8',
    });
    assert.match(out, /Valid: 7, Invalid: 0, Errors: 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
