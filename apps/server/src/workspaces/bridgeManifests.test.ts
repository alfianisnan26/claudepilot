// deploy/k3s-bridge (epic PILOT-1131, D4; T-3699): the cp-bridge's RBAC is never wider than the portal's own account in each workspace
// namespace (the Role `claudepilot-workspaces`), its one Secret right is the identity Secret by name in the namespace it serves, nothing is
// cluster-scoped, nothing dials in, the pod is locked down; the image takes the committed agent bundle with its hash checked
// (extract-agent.mjs), and the build Job keeps the build rules. Reads files only: no cluster (the rig dry run is on the ticket).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAll } from 'js-yaml';
import { PILOT_AGENT, PILOT_AGENT_SHA256 } from '../connect/agent.generated.js';
import { tempDirectory } from '../store/testTmp.js';
import { parseKubeTargets } from './kubeTargets.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const BRIDGE = 'deploy/k3s-bridge';
const SA = { kind: 'ServiceAccount', name: 'cp-bridge', namespace: 'isnan-cp-bridge' };

type Rule = { apiGroups: string[]; resources: string[]; verbs: string[]; resourceNames?: string[]; nonResourceURLs?: string[] };
type Doc = { kind: string; metadata: { name: string; namespace?: string }; rules?: Rule[]; roleRef?: { kind: string; name: string }; subjects?: { kind: string; name: string; namespace?: string }[]; spec?: Record<string, unknown>; automountServiceAccountToken?: boolean };
const docs = (path: string) => loadAll(readFileSync(join(REPO, path), 'utf8')).filter(Boolean) as Doc[];

/** Every (group, resource, verb, name) a rule list grants, as strings; a `*` anywhere stays a `*` (and is refused below). */
const grants = (rules: Rule[]): Set<string> =>
  new Set(rules.flatMap((r) => r.apiGroups.flatMap((g) => r.resources.flatMap((res) => r.verbs.flatMap((v) => (r.resourceNames?.length ? r.resourceNames : ['*any']).map((n) => `${g}|${res}|${v}|${n}`))))));

/** What `rules` grants that `base` does not. A name-limited grant is covered by the same unlimited one in base. */
function wider(rules: Rule[], base: Rule[]): string[] {
  const b = grants(base);
  return [...grants(rules)].filter((g) => !b.has(g) && !b.has(g.replace(/\|[^|]*$/, '|*any')));
}

/** The portal's `claudepilot-workspaces` Role in each workspace namespace (the `kubernetes` target and every PORTAL_K8S_TARGETS entry). */
function portalRoles(): Map<string, Rule[]> {
  const portal = docs('deploy/k3s/portal.yaml').find((d) => d.kind === 'Deployment')!;
  const env = (portal.spec as { template: { spec: { containers: { env?: { name: string; value?: string }[] }[] } } }).template.spec.containers.flatMap((c) => c.env ?? []);
  const oldNs = env.find((e) => e.name === 'PORTAL_K8S_NAMESPACE')!.value!;
  const namespaces = [oldNs, ...parseKubeTargets(env.find((e) => e.name === 'PORTAL_K8S_TARGETS')?.value, { namespaces: [oldNs] }).map((t) => t.namespace)];
  const roles = [...docs('deploy/k3s/rbac.yaml'), ...docs('deploy/k3s/workspace-orgs.yaml')].filter((d) => d.kind === 'Role' && d.metadata.name === 'claudepilot-workspaces');
  return new Map(namespaces.map((ns) => [ns, roles.find((r) => r.metadata.namespace === ns)!.rules!]));
}

const bridgeDeployment = () => docs(`${BRIDGE}/bridge.yaml`).find((d) => d.kind === 'Deployment')!;
type Ctr = { image: string; env?: { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string }; fieldRef?: unknown } }[]; envFrom?: unknown[]; securityContext?: Record<string, unknown>; volumeMounts?: unknown[] };
type PodSpec = { serviceAccountName?: string; automountServiceAccountToken?: boolean; hostNetwork?: boolean; hostPID?: boolean; hostIPC?: boolean; securityContext: Record<string, unknown>; containers: Ctr[]; initContainers?: Ctr[]; volumes?: Record<string, unknown>[] };
const podOf = (d: Doc) => (d.spec as { template: { spec: PodSpec } }).template.spec;
const servedNamespace = () => podOf(bridgeDeployment()).containers[0]!.env!.find((e) => e.name === 'PILOT_KUBE_NAMESPACE')!.value!;

test('wider(): a rule list wider than the base is caught (the check is not empty)', () => {
  const base: Rule[] = [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }];
  assert.deepEqual(wider(base, base), []);
  assert.deepEqual(wider([{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'delete'] }], base), ['|pods|delete|*any']);
  assert.deepEqual(wider([{ apiGroups: [''], resources: ['secrets'], verbs: ['get'] }], base), ['|secrets|get|*any']);
  assert.deepEqual(wider([{ apiGroups: ['*'], resources: ['pods'], verbs: ['get'] }], base), ['*|pods|get|*any']);
  assert.deepEqual(wider([{ apiGroups: [''], resources: ['pods'], verbs: ['get'], resourceNames: ['ws-a'] }], base), [], 'a name-limited subset is not wider');
});

test('deploy/k3s-bridge/rbac.yaml: in every workspace namespace exactly the portal’s Role, bound to the bridge only', () => {
  const portal = portalRoles();
  assert.deepEqual([...portal.keys()].sort(), ['isnan-claudepilot-workspaces', 'isnan-pilot-ws-isnan', 'isnan-pilot-ws-kohilabs', 'isnan-pilot-ws-konfersi']);
  const all = docs(`${BRIDGE}/rbac.yaml`);
  const roles = all.filter((d) => d.kind === 'Role' && d.metadata.name === 'cp-bridge-workspaces');
  assert.deepEqual(roles.map((r) => r.metadata.namespace).sort(), [...portal.keys()].sort(), 'one Role per workspace namespace, no other namespace');
  for (const role of roles) {
    const base = portal.get(role.metadata.namespace!)!;
    assert.deepEqual(wider(role.rules!, base), [], `${role.metadata.namespace}: grants nothing the portal's Role does not`);
    assert.deepEqual(role.rules, base, `${role.metadata.namespace}: a copy of the portal's Role`);
  }
  for (const b of all.filter((d) => d.kind === 'RoleBinding')) {
    assert.equal(b.roleRef?.kind, 'Role', `${b.metadata.namespace}/${b.metadata.name}: binds a Role, never a ClusterRole`);
    assert.ok(all.some((r) => r.kind === 'Role' && r.metadata.name === b.roleRef!.name && r.metadata.namespace === b.metadata.namespace), `${b.metadata.name}: its Role is here`);
    assert.deepEqual(b.subjects, [SA], `${b.metadata.namespace}/${b.metadata.name}: the bridge's account only`);
  }
});

test('deploy/k3s-bridge/rbac.yaml: the only Secret right is the identity Secret by name (plus create), in the namespace the bridge serves', () => {
  const all = docs(`${BRIDGE}/rbac.yaml`);
  const identity = all.filter((d) => d.kind === 'Role' && d.metadata.name === 'cp-bridge-identity');
  assert.deepEqual(identity.map((r) => r.metadata.namespace), [servedNamespace()]);
  assert.deepEqual(identity[0]!.rules, [
    { apiGroups: [''], resources: ['secrets'], resourceNames: ['claudepilot-agent-identity'], verbs: ['get', 'update'] },
    { apiGroups: [''], resources: ['secrets'], verbs: ['create'] },
  ]);
  assert.equal(podOf(bridgeDeployment()).containers[0]!.env!.find((e) => e.name === 'PILOT_IDENTITY_SECRET')?.value, 'claudepilot-agent-identity');
  const roles = all.filter((d) => d.kind === 'Role');
  assert.deepEqual(roles.map((r) => r.metadata.name).sort(), [...Array(4).fill('cp-bridge-workspaces'), 'cp-bridge-identity'].sort(), 'no other Role');
  for (const r of roles.flatMap((x) => x.rules!)) {
    for (const f of [r.apiGroups, r.resources, r.verbs]) assert.ok(!f.includes('*'), `no wildcard: ${JSON.stringify(r)}`);
    assert.equal(r.nonResourceURLs, undefined);
  }
  const sa = all.find((d) => d.kind === 'ServiceAccount')!;
  assert.deepEqual({ kind: sa.kind, name: sa.metadata.name, namespace: sa.metadata.namespace }, SA);
  assert.equal(sa.automountServiceAccountToken, false, 'only the bridge pod mounts the token');
});

test('deploy/k3s-bridge: nothing cluster-scoped but its Namespace (the coordinator’s), no Service or Ingress, no Secret in git', () => {
  const files = readdirSync(join(REPO, BRIDGE)).filter((f) => f.endsWith('.yaml'));
  assert.deepEqual(files.sort(), ['bridge.yaml', 'namespace.yaml', 'rbac.yaml']);
  const kinds = files.flatMap((f) => docs(`${BRIDGE}/${f}`).map((d) => `${f}:${d.kind}`)).sort();
  assert.deepEqual(kinds, ['bridge.yaml:Deployment', 'namespace.yaml:Namespace', ...Array(5).fill('rbac.yaml:Role'),...Array(5).fill('rbac.yaml:RoleBinding'), 'rbac.yaml:ServiceAccount'].sort());
});

test('deploy/k3s-bridge/bridge.yaml: one stateless replica, nobody, read-only, no escalation, the enrollment token from a Secret by name', () => {
  const d = bridgeDeployment();
  assert.equal(d.metadata.namespace, SA.namespace);
  const spec = d.spec as { replicas: number; strategy: { type: string } };
  assert.equal(spec.replicas, 1);
  assert.equal(spec.strategy.type, 'Recreate', 'never two agents with one identity');
  const pod = podOf(d);
  assert.equal(pod.serviceAccountName, SA.name);
  assert.ok(!pod.hostNetwork && !pod.hostPID && !pod.hostIPC);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.runAsUser, 65534);
  assert.deepEqual(pod.securityContext.seccompProfile, { type: 'RuntimeDefault' });
  assert.equal(pod.initContainers, undefined, 'the bundle is in the image: no fetch at start');
  assert.ok((pod.volumes ?? []).every((v) => Object.keys(v).sort().join() === 'emptyDir,name'), 'emptyDir volumes only (stateless)');
  assert.equal(pod.containers.length, 1);
  const c = pod.containers[0]!;
  assert.match(c.image, /^registry\.int\.isnan\.me\/cp-bridge:/);
  assert.deepEqual(c.securityContext, { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] } });
  assert.equal(c.envFrom, undefined);
  const env = new Map(c.env!.map((e) => [e.name, e]));
  assert.equal(env.get('PILOT_MODE')?.value, 'kubernetes');
  assert.deepEqual(env.get('PILOT_ENROLL_TOKEN')?.valueFrom, { secretKeyRef: { name: 'cp-bridge-enroll', key: 'token', optional: true } });
  const refs = c.env!.flatMap((e) => (e.valueFrom?.secretKeyRef ? [e.valueFrom.secretKeyRef.name] : []));
  assert.deepEqual(refs, ['cp-bridge-enroll', 'cp-bridge-headers'], 'no other Secret');
  assert.ok(c.env!.every((e) => e.value === undefined || !/token|secret|key/i.test(e.name) || e.name === 'PILOT_IDENTITY_SECRET'), 'no credential as a literal value');
});

test('deploy/k3s-build/bridge-job.yaml: kaniko like the portal build, no token, no Secret, cp-bridge:<tag>; k3s-build.sh knows it', () => {
  const job = docs('deploy/k3s-build/bridge-job.yaml').find((d) => d.kind === 'Job')!;
  assert.equal(job.metadata.name, 'claudepilot-build-bridge');
  const pod = podOf(job);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.ok(!pod.serviceAccountName && !pod.volumes && !pod.hostNetwork);
  const [k] = pod.containers as (Ctr & { args: string[] })[];
  assert.equal(k!.image, docs('deploy/k3s-build/portal-job.yaml').map(podOf)[0]!.containers[0]!.image, 'the same kaniko as the portal build');
  assert.equal(k!.env, undefined, 'no env, so no Secret');
  assert.ok(k!.args.includes('--dockerfile=deploy/k3s-build/bridge.Dockerfile'));
  assert.ok(k!.args.includes('--destination=registry.isnan-registry.svc.cluster.local:5000/cp-bridge:TAG'));
  assert.ok(k!.args.includes('--context=git://github.com/alfianisnan26/claudepilot.git#refs/heads/main#COMMIT'));
  const dockerfile = readFileSync(join(REPO, 'deploy/k3s-build/bridge.Dockerfile'), 'utf8');
  assert.match(dockerfile, /^USER 65534:65534$/m);
  assert.match(dockerfile, /^RUN node extract-agent\.mjs agent\.generated\.ts agent\.mjs$/m);
  const instructions = dockerfile.split('\n').filter((l) => !l.startsWith('#')).join('\n');
  assert.doesNotMatch(instructions, /npm|NODE_AUTH_TOKEN|^ARG /m, 'no package install, no token');
  const build = readFileSync(join(REPO, 'scripts/k3s-build.sh'), 'utf8');
  assert.match(build, /portal\|workspace\|workspace-dev\|browser\|bridge/);
  assert.match(build, /bridge\) echo cp-bridge ;;/);
});

test('deploy/k3s-bridge/extract-agent.mjs: writes the committed bundle byte for byte, and refuses a hash that does not match', () => {
  const dir = tempDirectory('bridge-extract');
  const script = join(REPO, BRIDGE, 'extract-agent.mjs');
  const src = join(REPO, 'apps/server/src/connect/agent.generated.ts');
  const out = join(dir, 'agent.mjs');
  const said = execFileSync(process.execPath, [script, src, out], { encoding: 'utf8' });
  assert.equal(readFileSync(out, 'utf8'), PILOT_AGENT);
  assert.match(said, new RegExp(`^agent\\.mjs ${PILOT_AGENT_SHA256.slice(0, 12)} `));

  const bad = join(dir, 'bad.generated.ts');
  writeFileSync(bad, readFileSync(src, 'utf8').replace(PILOT_AGENT_SHA256, '0'.repeat(64)));
  const r = spawnSync(process.execPath, [script, bad, join(dir, 'bad.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /checksum mismatch/);
  const none = spawnSync(process.execPath, [script, join(REPO, 'package.json'), join(dir, 'none.mjs')], { encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /not agent\.generated\.ts/);
});
