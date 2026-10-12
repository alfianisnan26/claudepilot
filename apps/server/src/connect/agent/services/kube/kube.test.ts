// T-KUBE (docs/prd/targets-connect.md §19.3): the Kubernetes proxy against an in-process fake API server, no cluster, no kubeconfig.
// Path and namespace confinement, label-selector injection, secrets by name, the portal's Authorization and impersonation headers dropped
// and the service account's token set, the local bearer, the token re-read, exec as a WebSocket with channel subprotocols, watches that
// stream, limits; then `KubernetesRuntime` over the loopback (list, create, scale, exec, shell, usage, remove) without ever creating a
// namespace. The default test needs nothing real: the fake's URL, the token file and the CA are injected.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { KubernetesRuntime } from '../../../../workspaces/kubernetes.js';
import { KubeSecretIdentityStore } from '../../identity.kube.js';
import { parseIdentity } from '../../identity.js';
import { LOCAL_TOKEN, NAMESPACE, startKubeRig, type KubeRig } from '../../testkit/kubeRig.js';
import { generateNodeKeyPair } from '../../../tunnel/auth.js';

let rig: KubeRig;
const base = `/api/v1/namespaces/${NAMESPACE}`;
const apps = `/apis/apps/v1/namespaces/${NAMESPACE}`;
const MANAGED = { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'w1' };

before(async () => {
  rig = await startKubeRig();
  rig.fake.deployments.set('ws-w1', { metadata: { name: 'ws-w1', labels: MANAGED }, spec: { replicas: 1, template: { metadata: { labels: MANAGED } } } } as never);
  rig.fake.pods.set('ws-w1-7d9f6c-aaaa', { metadata: { name: 'ws-w1-7d9f6c-aaaa', labels: MANAGED }, status: { phase: 'Running' } } as never);
  rig.fake.pods.set('other-pod', { metadata: { name: 'other-pod', labels: {} } } as never);
  rig.fake.deployments.set('other', { metadata: { name: 'other', labels: {} }, spec: { replicas: 1 } } as never);
});
after(() => rig.stop());

const refused = (a: { status: number; json: () => { kind: string; message: string; reason: string } }, rule: string, code = 403) => {
  assert.equal(a.status, code, JSON.stringify(a.json()));
  assert.equal(a.json().kind, 'Status');
  if (code === 403) assert.equal(a.json().message, `denied by claudepilot policy (${rule})`);
};
const fakeSaw = (n: number, pattern: RegExp = /./) => rig.fake.requests.slice(n).filter((r) => pattern.test(r.url));

describe('what the portal needs is allowed, with the service account’s token', () => {
  it('lists, reads, scales and deletes workspace objects, and the API server sees only its own token', async () => {
    assert.equal((await rig.request('GET', '/version')).status, 200);
    assert.equal((await rig.request('GET', `${base}/pods?limit=1`)).status, 200);
    assert.equal((await rig.request('GET', `${base}/pods/ws-w1-7d9f6c-aaaa`)).status, 200);
    assert.equal((await rig.request('GET', `${apps}/deployments/ws-w1`)).status, 200);
    assert.equal((await rig.request('GET', `${apps}/deployments/ws-nothing`)).status, 404, 'a missing object is the API server’s 404');
    const scaled = await rig.request('PUT', `${apps}/deployments/ws-w1/scale`, { body: { metadata: { name: 'ws-w1', namespace: NAMESPACE }, spec: { replicas: 0 } } });
    assert.equal(scaled.status, 200, scaled.text);
    assert.equal(rig.fake.pods.has('ws-w1-7d9f6c-aaaa'), false, 'the fake took the pod down');
    assert.equal((await rig.request('PUT', `${apps}/deployments/ws-w1/scale`, { body: { metadata: { name: 'ws-w1' }, spec: { replicas: 1 } } })).status, 200);
    const last = rig.fake.requests.at(-1)!;
    assert.equal(last.headers.authorization, `Bearer ${rig.fake.token}`, 'the API server got the service account’s token');
    assert.ok(rig.fake.requests.every((r) => !JSON.stringify(r.headers).includes(LOCAL_TOKEN)), 'the portal’s local bearer never left the agent');
  });

  it('creates and deletes a claim and a deployment by name, and reads pod metrics', async () => {
    const claim = { metadata: { name: 'ws-w2-home', labels: { 'claudepilot.managed': 'true' } }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } };
    assert.equal((await rig.request('POST', `${base}/persistentvolumeclaims`, { body: claim })).status, 201);
    assert.equal((await rig.request('GET', `${base}/persistentvolumeclaims/ws-w2-home`)).status, 200);
    const dep = { metadata: { name: 'ws-w2', labels: { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'w2' } }, spec: { replicas: 1, template: { metadata: { labels: { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'w2' } } } } };
    assert.equal((await rig.request('POST', `${apps}/deployments`, { body: dep })).status, 201);
    assert.equal((await rig.request('GET', `/apis/metrics.k8s.io/v1beta1/namespaces/${NAMESPACE}/pods?labelSelector=claudepilot.managed%3Dtrue`)).status, 200);
    assert.equal((await rig.request('DELETE', `${apps}/deployments/ws-w2?propagationPolicy=Foreground`)).status, 200);
    assert.equal((await rig.request('DELETE', `${base}/persistentvolumeclaims/ws-w2-home`)).status, 200);
  });
});

describe('the local bearer, and what is dropped', () => {
  it('refuses a request without this connection’s bearer, and the API server never sees it', async () => {
    const n = rig.fake.requests.length;
    for (const bearer of [null, 'wrong', rig.fake.token, '']) {
      const a = await rig.request('GET', `${base}/pods`, { bearer });
      refused(a, 'auth', 401);
    }
    rig.setLocalToken(null);
    refused(await rig.request('GET', `${base}/pods`), 'auth', 401);
    rig.setLocalToken(LOCAL_TOKEN);
    assert.equal(fakeSaw(n).length, 0);
    assert.ok((rig.service.report!().denied ?? []).some((d) => d.rule === 'auth' && d.count >= 5));
  });

  it('drops Authorization, Impersonate-* and X-Remote-* and everything else it does not know', async () => {
    const n = rig.fake.requests.length;
    const a = await rig.request('GET', `${base}/pods`, {
      headers: {
        'Impersonate-User': 'system:admin', 'Impersonate-Group': 'system:masters', 'Impersonate-Extra-scopes': 'x', 'Impersonate-Uid': '0',
        'X-Remote-User': 'root', 'X-Remote-Group': 'system:masters', 'X-Remote-Extra-a': 'b', 'X-Forwarded-For': '1.2.3.4', Cookie: 'a=b', 'X-Anything': 'secret-canary',
      },
    });
    assert.equal(a.status, 200);
    const sent = rig.fake.requests.slice(n)[0]!.headers;
    assert.equal(sent.authorization, `Bearer ${rig.fake.token}`);
    for (const h of Object.keys(sent)) assert.ok(!/^(impersonate|x-remote|x-forwarded|x-anything|cookie)/i.test(h), `${h} reached the API server`);
  });

  it('re-reads the service account token from its file at most every 60 s (bound tokens rotate)', async () => {
    let now = 1_000_000;
    const local = await startKubeRig({ service: { now: () => now } });
    try {
      assert.equal((await local.request('GET', '/version')).status, 200);
      writeFileSync(local.tokenFile, 'rotated-token\n');
      local.fake.token = 'rotated-token';
      assert.equal((await local.request('GET', '/version')).status, 401, 'within 60 s the cached token is still sent, and the API server (now expecting the new one) refuses it');
      now += 61_000;
      assert.equal((await local.request('GET', '/version')).status, 200, 'after 60 s the new token is read');
    } finally {
      await local.stop();
    }
  });
});

describe('confinement', () => {
  it('refuses another namespace, cluster-scoped paths and resources outside the list, and the API server never sees them', async () => {
    const n = rig.fake.requests.length;
    const cases: [string, string, string][] = [
      ['GET', '/api/v1/namespaces/kube-system/pods', 'namespace'],
      ['GET', '/api/v1/namespaces/kube-system/secrets/x', 'namespace'],
      ['GET', '/apis/apps/v1/namespaces/default/deployments', 'namespace'],
      ['GET', '/api/v1/namespaces', 'path'],
      ['GET', '/api/v1/nodes', 'path'],
      ['GET', '/api/v1/pods', 'path'],
      ['GET', '/api/v1/secrets', 'path'],
      ['GET', '/apis/rbac.authorization.k8s.io/v1/clusterroles', 'path'],
      ['GET', '/api', 'path'],
      ['GET', '/apis', 'path'],
      ['GET', '/openapi/v2', 'path'],
      ['GET', '/metrics', 'path'],
      ['GET', '/healthz', 'path'],
      ['GET', `${base}/serviceaccounts`, 'resource'],
      ['GET', `${base}/configmaps`, 'resource'],
      ['GET', `${base}/events`, 'resource'],
      ['GET', `${base}/pods/ws-w1-7d9f6c-aaaa/log`, 'resource'],
      ['GET', `${base}/services`, 'resource'],
      ['GET', `/apis/apps/v1/namespaces/${NAMESPACE}/statefulsets`, 'resource'],
      ['GET', `/apis/apps/v1/namespaces/${NAMESPACE}/daemonsets`, 'resource'],
      ['POST', `${base}/pods`, 'method'],
      ['DELETE', `${base}/pods`, 'method'],
      ['DELETE', `${base}/pods/ws-w1-7d9f6c-aaaa`, 'method'],
      ['DELETE', `${apps}/deployments`, 'method'],
      ['DELETE', `${base}/persistentvolumeclaims`, 'method'],
      ['PUT', `${base}/persistentvolumeclaims/ws-w1-home`, 'method'],
      ['GET', `${base}/secrets`, 'method'],
      ['POST', `${base}/pods/ws-w1-7d9f6c-aaaa/exec?command=sh&container=workspace`, 'upgrade'],
      ['GET', `${base}/pods/ws-w1-7d9f6c-aaaa/exec?command=sh&container=workspace`, 'upgrade'],
      ['GET', `${base}/pods/kube-proxy-x`, 'name'],
      ['GET', `${base}/pods/ws-w1-7d9f6c-aaaa/status`, 'resource'],
      ['GET', `${apps}/deployments/agent`, 'name'],
      ['PATCH', `${apps}/deployments/claudepilot-agent`, 'name'],
      ['DELETE', `${apps}/deployments/claudepilot-agent`, 'name'],
      ['GET', `${base}/persistentvolumeclaims/data`, 'name'],
      ['GET', `${base}/persistentvolumeclaims/ws-w1`, 'name'],
      ['DELETE', `${base}/persistentvolumeclaims/ws-w1-claudepilot`, 'name'],
      ['GET', `${base}/secrets/claudepilot-agent-identity`, 'name'],
      ['GET', `${base}/secrets/claudepilot-agent-enroll`, 'name'],
      ['DELETE', `${base}/secrets/ws-w1`, 'name'],
      ['GET', `${apps}/deployments/ws-w1/status`, 'resource'],
      ['GET', '/api/v1/watch/namespaces/' + NAMESPACE + '/pods', 'path'],
      ['GET', `/api/v1/namespaces/${NAMESPACE}/pods/..%2f..%2fsecrets`, 'path'],
      ['GET', `${base}/pods/../secrets`, 'path'],
      ['GET', `${base}//pods`, 'path'],
      ['GET', `http://evil/api/v1/namespaces/${NAMESPACE}/pods`, 'path'],
      ['TRACE', '/version', 'method'],
      ['OPTIONS', `${base}/pods`, 'method'],
    ];
    for (const [m, p, rule] of cases) {
      const a = await rig.request(m, p);
      refused(a, rule, rule === 'upgrade' ? 403 : 403);
    }
    assert.equal(fakeSaw(n).length, 0, fakeSaw(n).map((r) => `${r.method} ${r.url}`).join(', '));
  });

  it('only lets a workspace object be created, replaced or addressed under a workspace name, in the connector’s namespace', async () => {
    const n = rig.fake.requests.length;
    const meta = (name: string, extra: object = {}) => ({ metadata: { name, ...extra }, spec: {} });
    refused(await rig.request('POST', `${base}/persistentvolumeclaims`, { body: meta('data') }), 'name');
    refused(await rig.request('POST', `${base}/persistentvolumeclaims`, { body: meta('ws-x-home', { namespace: 'kube-system' }) }), 'namespace');
    refused(await rig.request('POST', `${apps}/deployments`, { body: meta('claudepilot-agent') }), 'name');
    refused(await rig.request('POST', `${apps}/deployments`, { body: {} }), 'name');
    refused(await rig.request('POST', `${base}/secrets`, { body: meta('claudepilot-agent-identity') }), 'name');
    refused(await rig.request('PUT', `${apps}/deployments/ws-w1`, { body: meta('ws-other') }), 'name');
    refused(await rig.request('POST', `${apps}/deployments`, { rawBody: '{not json' }), 'body');
    refused(await rig.request('POST', `${apps}/deployments`, { body: meta('ws-z'), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), 'body');
    assert.equal(fakeSaw(n).length, 0);
    // The secrets the delivery engine will use are by name: a create, a read, an update and a delete of `ws-*-claudepilot`.
    const secret = { metadata: { name: 'ws-w1-claudepilot' }, data: { a: 'Yg==' } };
    assert.equal((await rig.request('POST', `${base}/secrets`, { body: secret })).status, 201);
    assert.equal((await rig.request('GET', `${base}/secrets/ws-w1-claudepilot`)).status, 200);
    assert.equal((await rig.request('PATCH', `${base}/secrets/ws-w1-claudepilot`, { body: { data: { a: 'Yw==' } }, headers: { 'Content-Type': 'application/merge-patch+json' } })).status, 200);
    assert.equal((await rig.request('DELETE', `${base}/secrets/ws-w1-claudepilot`)).status, 200);
  });
});

describe('what an object may contain: nothing that leaves the workspace’s sandbox', () => {
  const dep = (podSpec: Record<string, unknown>, name = 'ws-body') => ({
    metadata: { name, labels: { 'claudepilot.managed': 'true' } },
    spec: { replicas: 1, template: { metadata: { labels: { 'claudepilot.managed': 'true' } }, spec: { containers: [{ name: 'workspace', image: 'ghcr.io/example/claudepilot-workspace:latest' }], ...podSpec } } },
  });
  const container = (extra: Record<string, unknown>) => dep({ containers: [{ name: 'workspace', image: 'ghcr.io/example/claudepilot-workspace:latest', ...extra }] });

  it('refuses a pod that asks for the host, privileges, another identity or a volume it must not have, on create, replace and patch, and the API server never sees it', async () => {
    const n = rig.fake.requests.length;
    const bad: [string, unknown][] = [
      ['a privileged container', container({ securityContext: { privileged: true } })],
      ['an init container that is privileged', dep({ initContainers: [{ name: 'i', image: 'x', securityContext: { privileged: true } }] })],
      ['privilege escalation', container({ securityContext: { allowPrivilegeEscalation: true } })],
      ['added capabilities', container({ securityContext: { capabilities: { add: ['SYS_ADMIN'] } } })],
      ['running as root', dep({ securityContext: { runAsUser: 0 } })],
      ['the host network', dep({ hostNetwork: true })],
      ['the host pid namespace', dep({ hostPID: true })],
      ['a shared process namespace', dep({ shareProcessNamespace: true })],
      ['a host path volume', dep({ volumes: [{ name: 'h', hostPath: { path: '/' } }] })],
      ['an nfs volume', dep({ volumes: [{ name: 'n', nfs: { server: 'x', path: '/' } }] })],
      ['a host port', container({ ports: [{ containerPort: 80, hostPort: 80 }] })],
      ['the agent’s service account', dep({ serviceAccountName: 'claudepilot-agent' })],
      ['sysctls', dep({ securityContext: { sysctls: [{ name: 'net.ipv4.ip_forward', value: '1' }] } })],
      ['an unconfined seccomp profile', dep({ securityContext: { seccompProfile: { type: 'Unconfined' } } })],
      ['bidirectional mount propagation', container({ volumeMounts: [{ name: 'home', mountPath: '/h', mountPropagation: 'Bidirectional' }] })],
      ['an unmasked /proc', container({ securityContext: { procMount: 'Unmasked' } })],
      ['a raw block device', container({ volumeDevices: [{ name: 'd', devicePath: '/dev/x' }] })],
    ];
    for (const [what, body] of bad) {
      refused(await rig.request('POST', `${apps}/deployments`, { body }), 'spec');
      refused(await rig.request('PUT', `${apps}/deployments/ws-w1`, { body: { ...(body as object), metadata: { name: 'ws-w1' } } }), 'spec');
      void what;
    }
    // A patch is scanned too: a merge patch that adds a host path, and a JSON patch (which names its target in a path string) altogether.
    refused(await rig.request('PATCH', `${apps}/deployments/ws-w1`, { body: { spec: { template: { spec: { volumes: [{ name: 'h', hostPath: { path: '/etc' } }] } } } }, headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }), 'spec');
    refused(await rig.request('PATCH', `${apps}/deployments/ws-w1`, { body: [{ op: 'add', path: '/spec/template/spec/hostNetwork', value: true }], headers: { 'Content-Type': 'application/json-patch+json' } }), 'spec');
    assert.equal(fakeSaw(n).length, 0, fakeSaw(n).map((r) => `${r.method} ${r.url}`).join(', '));
    assert.ok((rig.service.report!().denied ?? []).some((d) => d.rule === 'spec' && d.count >= bad.length * 2));
  });

  it('refuses a claim bound to somebody’s volume or filled from another, and a secret that mints a credential', async () => {
    const n = rig.fake.requests.length;
    const claim = (spec: object) => ({ metadata: { name: 'ws-c-home' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, ...spec } });
    refused(await rig.request('POST', `${base}/persistentvolumeclaims`, { body: claim({ volumeName: 'pvc-12345' }) }), 'spec');
    refused(await rig.request('POST', `${base}/persistentvolumeclaims`, { body: claim({ dataSource: { kind: 'PersistentVolumeClaim', name: 'ws-other-home' } }) }), 'spec');
    refused(await rig.request('POST', `${base}/persistentvolumeclaims`, { body: claim({ dataSourceRef: { kind: 'VolumeSnapshot', name: 's' } }) }), 'spec');
    refused(await rig.request('POST', `${base}/persistentvolumeclaims`, { body: claim({ volumeMode: 'Block' }) }), 'spec');
    refused(await rig.request('POST', `${base}/secrets`, { body: { metadata: { name: 'ws-s-claudepilot', annotations: { 'kubernetes.io/service-account.name': 'claudepilot-agent' } }, type: 'kubernetes.io/service-account-token' } }), 'spec');
    assert.equal(fakeSaw(n).length, 0);
    assert.equal((await rig.request('POST', `${base}/persistentvolumeclaims`, { body: claim({ storageClassName: 'fast' }) })).status, 201, 'an ordinary claim is fine');
    assert.equal((await rig.request('POST', `${base}/secrets`, { body: { metadata: { name: 'ws-s-claudepilot' }, type: 'Opaque', data: { a: 'Yg==' } } })).status, 201);
    await rig.request('DELETE', `${base}/persistentvolumeclaims/ws-c-home`);
    await rig.request('DELETE', `${base}/secrets/ws-s-claudepilot`);
  });

  it('what KubernetesRuntime really creates passes: a pod security context with uid 1000, a claim volume, an init container, limits, an image pull secret, a merge patch', async () => {
    const ok = dep({
      hostname: 'w',
      terminationGracePeriodSeconds: 5,
      securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
      imagePullSecrets: [{ name: 'pull' }],
      volumes: [{ name: 'home', persistentVolumeClaim: { claimName: 'ws-ok-home' } }, { name: 'scratch', emptyDir: {} }],
      initContainers: [{ name: 'seed-home', image: 'ghcr.io/example/claudepilot-workspace:latest', command: ['sh', '-c', 'true'], volumeMounts: [{ name: 'home', mountPath: '/seed' }] }],
      containers: [{ name: 'workspace', image: 'ghcr.io/example/claudepilot-workspace:latest', env: [{ name: 'TERM', value: 'xterm' }], resources: { limits: { cpu: '1', memory: '512Mi' } }, volumeMounts: [{ name: 'home', mountPath: '/home/node' }], securityContext: { allowPrivilegeEscalation: false, privileged: false, capabilities: { drop: ['ALL'] } } }],
      nodeSelector: { disk: 'ssd' },
    }, 'ws-ok');
    assert.equal((await rig.request('POST', `${apps}/deployments`, { body: ok })).status, 201);
    assert.equal((await rig.request('PATCH', `${apps}/deployments/ws-ok`, { body: { spec: { replicas: 0 } }, headers: { 'Content-Type': 'application/merge-patch+json' } })).status, 200);
    assert.equal((await rig.request('DELETE', `${apps}/deployments/ws-ok`)).status, 200);
  });

  it('with an image allowlist (PILOT_IMAGES on the cluster) only those images run; without one nothing is enforced', async () => {
    const strict = await startKubeRig({ service: { images: ['ghcr.io/example/claudepilot-workspace:latest'] } });
    try {
      const withImage = (image: string, name: string) => ({ metadata: { name, labels: { 'claudepilot.managed': 'true' } }, spec: { replicas: 1, template: { metadata: { labels: { 'claudepilot.managed': 'true' } }, spec: { containers: [{ name: 'workspace', image }] } } } });
      assert.equal((await strict.request('POST', `${apps}/deployments`, { body: withImage('ghcr.io/example/claudepilot-workspace:latest', 'ws-img1') })).status, 201);
      assert.equal((await strict.request('POST', `${apps}/deployments`, { body: withImage('attacker.example/miner:latest', 'ws-img2') })).status, 403);
      assert.equal((await strict.request('POST', `${apps}/deployments`, { body: { ...withImage('x', 'ws-img3'), spec: { template: { spec: { initContainers: [{ name: 'i', image: 'attacker.example/x' }], containers: [{ name: 'workspace', image: 'ghcr.io/example/claudepilot-workspace:latest' }] } } } } })).status, 403);
    } finally {
      await strict.stop();
    }
    const open = withNoImages();
    function withNoImages() {
      return rig;
    }
    assert.equal((await open.request('POST', `${apps}/deployments`, { body: dep({}, 'ws-img4') })).status, 201);
    await open.request('DELETE', `${apps}/deployments/ws-img4`);
  });
});

describe('selectors are injected, lists are only the portal’s', () => {
  it('adds the managed label selector to lists of pods, deployments and claims, and to a watch', async () => {
    for (const path of [`${base}/pods`, `${apps}/deployments`, `${base}/persistentvolumeclaims`]) {
      const n = rig.fake.requests.length;
      const list = (await rig.request('GET', path)).json() as { items: { metadata: { name: string } }[] };
      const names = list.items.map((i) => i.metadata.name);
      assert.ok(!names.includes('other-pod') && !names.includes('other'), `${path}: ${names}`);
      assert.equal(new URL(rig.fake.requests[n]!.url, 'http://x').searchParams.get('labelSelector'), 'claudepilot.managed=true');
    }
    const n = rig.fake.requests.length;
    await rig.request('GET', `${base}/pods?labelSelector=${encodeURIComponent('claudepilot.workspace=w1')}&fieldSelector=${encodeURIComponent('status.phase=Running')}&limit=5&foo=bar`);
    const asked = new URL(rig.fake.requests[n]!.url, 'http://x').searchParams;
    assert.equal(asked.get('labelSelector'), 'claudepilot.workspace=w1,claudepilot.managed=true');
    assert.equal(asked.get('fieldSelector'), 'status.phase=Running');
    assert.equal(asked.get('limit'), '5');
    assert.equal(asked.has('foo'), false, 'an unknown parameter is not forwarded');
    // Asking for everyone's does not work either.
    const sneaky = (await rig.request('GET', `${base}/pods?labelSelector=${encodeURIComponent('claudepilot.managed!=true')}`)).json() as { items: unknown[] };
    assert.equal(sneaky.items.length, 0);
    refused(await rig.request('GET', `${base}/pods?labelSelector=${encodeURIComponent('a=b;c')}`), 'selector');
    refused(await rig.request('GET', `${base}/pods?limit=abc`), 'path');
  });

  it('streams a watch: the first event arrives while the response is still open, and closing it closes the upstream', async () => {
    const events: string[] = [];
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const r = http.request({ host: new URL(rig.loopback).hostname, port: new URL(rig.loopback).port, path: `${base}/pods?watch=true&labelSelector=claudepilot.managed%3Dtrue`, headers: { Authorization: `Bearer ${LOCAL_TOKEN}` }, agent: false }, resolve);
      r.on('error', reject);
      r.end();
    });
    res.on('data', (c: Buffer) => events.push(...c.toString().trim().split('\n')));
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(events.some((l) => (JSON.parse(l) as { type: string }).type === 'ADDED'), 'the existing pod was announced');
    const before = events.length;
    await rig.request('PUT', `${apps}/deployments/ws-w1/scale`, { body: { metadata: { name: 'ws-w1' }, spec: { replicas: 0 } } });
    await rig.request('PUT', `${apps}/deployments/ws-w1/scale`, { body: { metadata: { name: 'ws-w1' }, spec: { replicas: 1 } } });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(events.length > before, 'later events arrived on the same response');
    res.destroy();
    await new Promise((r) => setTimeout(r, 150));
  });
});

describe('exec is a WebSocket for a workspace pod only', () => {
  const wsUrl = (pod: string, q = 'command=sh&container=workspace&stdin=true&stdout=true&stderr=true&tty=false') => `${rig.loopback.replace('http', 'ws')}${base}/pods/${pod}/exec?${q}`;
  const dial = (url: string, opts: { token?: string | null; protocols?: string[] } = {}) =>
    new Promise<{ ws: WebSocket; protocol: string } | { error: string }>((resolve) => {
      const ws = new WebSocket(url, opts.protocols ?? ['v4.channel.k8s.io'], { headers: opts.token === null ? {} : { Authorization: `Bearer ${opts.token ?? LOCAL_TOKEN}` }, perMessageDeflate: false, handshakeTimeout: 3000 });
      ws.on('open', () => resolve({ ws, protocol: ws.protocol }));
      ws.on('unexpected-response', (_req, res) => resolve({ error: `HTTP ${res.statusCode}` }));
      ws.on('error', (e) => resolve({ error: e.message }));
    });

  it('upgrades with the channel subprotocol, carries stdin and stdout, and the API server sees the service account’s token', async () => {
    const pod = 'ws-w1-7d9f6c-aaaa';
    rig.fake.pods.set(pod, { metadata: { name: pod, labels: MANAGED }, status: { phase: 'Running' } } as never);
    const n = rig.fake.upgrades.length;
    const got = await dial(wsUrl(pod));
    assert.ok('ws' in got, JSON.stringify(got));
    assert.equal(got.protocol, 'v4.channel.k8s.io');
    const out: string[] = [];
    got.ws.on('message', (d: Buffer) => out.push(`${d[0]}:${d.subarray(1)}`));
    got.ws.send(Buffer.concat([Buffer.from([0]), Buffer.from('hello exit\n')]));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(out.includes('1:hello exit\n'));
    assert.ok(out.some((l) => l.startsWith('3:') && l.includes('Success')), 'the status channel ended it');
    const sent = rig.fake.upgrades[n]!;
    assert.equal(sent.headers.authorization, `Bearer ${rig.fake.token}`);
    assert.equal(sent.headers['sec-websocket-protocol'], 'v4.channel.k8s.io');
    assert.equal(sent.headers.origin, undefined);
  });

  it('refuses the wrong bearer, a pod that is not a workspace’s, another container, and an upgrade anywhere else', async () => {
    const n = rig.fake.upgrades.length;
    const requests = rig.fake.requests.length;
    assert.deepEqual(await dial(wsUrl('ws-w1-7d9f6c-aaaa'), { token: null }), { error: 'HTTP 401' });
    assert.deepEqual(await dial(wsUrl('ws-w1-7d9f6c-aaaa'), { token: 'nope' }), { error: 'HTTP 401' });
    assert.deepEqual(await dial(wsUrl('kube-proxy-abc')), { error: 'HTTP 403' });
    assert.deepEqual(await dial(wsUrl('ws-w1-7d9f6c-aaaa', 'command=sh&container=seed-home&stdin=true')), { error: 'HTTP 403' });
    assert.deepEqual(await dial(wsUrl('ws-w1-7d9f6c-aaaa', 'container=workspace')), { error: 'HTTP 403' }, 'an exec needs a command');
    assert.deepEqual(await dial(`${rig.loopback.replace('http', 'ws')}${base}/pods?watch=true`), { error: 'HTTP 403' });
    assert.deepEqual(await dial(`${rig.loopback.replace('http', 'ws')}/version`), { error: 'HTTP 403' });
    assert.deepEqual(await dial(wsUrl('ws-w1-7d9f6c-aaaa'), { protocols: ['x'.repeat(100)] }), { error: 'HTTP 403' });
    assert.equal(rig.fake.upgrades.length, n);
    assert.equal(rig.fake.requests.length, requests, 'none of it reached the API server');
  });
});

describe('limits and framing', () => {
  it('refuses a header block over 16 KiB, a body over 1 MiB, duplicate Content-Length and Transfer-Encoding with Content-Length', async () => {
    const n = rig.fake.requests.length;
    assert.match(await rig.raw(`GET ${base}/pods HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${LOCAL_TOKEN}\r\nX-Pad: ${'a'.repeat(17 * 1024)}\r\n\r\n`), /HTTP\/1\.1 431/);
    const huge = JSON.stringify({ metadata: { name: 'ws-big', labels: { x: 'y'.repeat(1_100_000) } } });
    refused(await rig.request('POST', `${apps}/deployments`, { rawBody: huge }), 'body');
    assert.match(await rig.raw(`POST ${apps}/deployments HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${LOCAL_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}`), /HTTP\/1\.1 4\d\d/);
    assert.match(await rig.raw(`POST ${apps}/deployments HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${LOCAL_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`), /HTTP\/1\.1 4\d\d/);
    assert.equal(fakeSaw(n).length, 0);
  });
});

describe('KubernetesRuntime over the loopback (A6 in its fake form)', () => {
  it('lists, creates without making a namespace, scales, execs, runs a shell, reads usage and removes', async () => {
    const fresh = await startKubeRig();
    try {
      const rt = new KubernetesRuntime(
        { namespace: NAMESPACE, image: 'ghcr.io/example/claudepilot-workspace:latest', storage: '1Gi' },
        { kubeConfig: fresh.kubeConfig, manageNamespace: false, target: { id: 'kube', label: 'Kube', where: 'fake' } },
      );
      await rt.check();
      assert.deepEqual(await rt.list(), []);
      await rt.create({ name: 'kw1', cpus: 1, memoryMb: 512 }, () => undefined);
      const [w] = await rt.list();
      assert.equal(w!.name, 'kw1');
      assert.equal(w!.status, 'running');
      assert.equal(fresh.fake.seen('POST', '/api/v1/namespaces').length, 0, 'no namespace was created (a namespaced Role could not)');
      assert.ok(fresh.fake.claims.has('ws-kw1-home') && fresh.fake.deployments.has('ws-kw1'));

      await rt.stop('kw1');
      assert.equal((await rt.list())[0]!.status, 'stopped');
      await rt.start('kw1');
      assert.equal((await rt.list())[0]!.status, 'running');

      const [u] = await rt.usage(['kw1']);
      assert.ok(u!.memoryBytes! > 0 && u!.cpuPercent! > 0);

      fresh.fake.onExec = (io) => io.onStdin((d) => (io.stdout(`echo:${d}`), d.toString().includes('bye') && io.exit(7)));
      const session = await rt.exec('kw1', ['cat']);
      const chunks: Buffer[] = [];
      session.onData((d) => chunks.push(d));
      const exited = new Promise<number | null>((resolve) => session.onExit(resolve));
      session.write('say bye\n');
      assert.equal(await exited, 7);
      assert.match(Buffer.concat(chunks).toString(), /echo:say bye/);

      fresh.fake.onExec = (io) => {
        io.onResize((s) => io.stdout(`size ${s.width}x${s.height}\n`));
        io.onStdin((d) => d.toString().includes('exit') && io.exit(0));
      };
      const shell = await rt.shell('kw1', { cols: 100, rows: 30 });
      const out: Buffer[] = [];
      shell.onData((d) => out.push(d));
      await new Promise((r) => setTimeout(r, 200));
      shell.resize(120, 40);
      await new Promise((r) => setTimeout(r, 200));
      assert.match(Buffer.concat(out).toString(), /size 120x40/);
      shell.close();

      await rt.remove('kw1');
      assert.deepEqual(await rt.list(), []);
      assert.equal(fresh.fake.claims.size, 0);
      assert.deepEqual(fresh.service.report!().denied ?? [], [], 'the policy refused none of it');
    } finally {
      await fresh.stop();
    }
  });
});

describe('the agent’s own identity Secret (outside the portal-facing allowlist)', () => {
  it('writes and reads the identity, keeps a rotation’s next key beside it, and the proxy still refuses the portal that asks for it', async () => {
    const api = rig.service.proxy.api.bind(rig.service.proxy);
    const store = new KubeSecretIdentityStore(api, NAMESPACE, 'claudepilot-agent-identity');
    assert.equal(await store.load(), null);
    const keys = generateNodeKeyPair();
    const identity = { node: 'nd_0123456789ab', target: 'kube', portalUrl: 'https://pilot.example.test', portalId: null, privateKey: keys.privateKey, publicKey: keys.publicKey, enrolledAt: '2026-10-12T09:00:00.000Z' };
    await store.save(identity);
    assert.deepEqual(await store.load(), identity);
    const secret = rig.fake.secrets.get('claudepilot-agent-identity')!;
    assert.equal(secret.metadata.labels!['claudepilot.connect/target'], 'kube');
    assert.equal(secret.metadata.labels!['app.kubernetes.io/part-of'], 'claudepilot-connect');
    assert.ok(parseIdentity(Buffer.from((secret.data as Record<string, string>)['identity.json']!, 'base64').toString()), 'the Secret holds a valid identity');

    const next = generateNodeKeyPair();
    await store.saveNext({ ...identity, privateKey: next.privateKey, publicKey: next.publicKey });
    assert.equal((await store.loadNext())!.publicKey, next.publicKey);
    assert.equal((await store.load())!.publicKey, keys.publicKey, 'the current identity is untouched until promoted');
    assert.equal((await store.promoteNext())!.publicKey, next.publicKey);
    assert.equal((await store.load())!.publicKey, next.publicKey);
    assert.equal(await store.loadNext(), null);
    const after = rig.fake.secrets.get('claudepilot-agent-identity')!.data as Record<string, string>;
    assert.equal('identity.next.json' in after, false);

    refused(await rig.request('GET', `${base}/secrets/claudepilot-agent-identity`), 'name');
  });
});
