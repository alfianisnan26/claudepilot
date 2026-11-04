// T-3720 (PILOT-1162, G1): one cp-bridge serves several workspace namespaces. Each namespace is its own kube target on the one connection:
// the open request names the namespace, the agent refuses one it does not serve, and the stream's proxy forwards only that namespace's
// paths, so a stream opened for B never reaches A (not even the agent's own namespace). Against the in-process fake: no cluster.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { collectingLogger } from '../../log.js';
import { startKubeRig, LOCAL_TOKEN, type KubeRig } from '../../testkit/kubeRig.js';
import { streamPair } from '../../testkit/streams.js';
import { createService, streamNamespace } from './index.js';
import { classifyKube } from './rules.js';

const HOME = 'ns-a';
const B = 'ns-b';
const MANAGED = { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'w1' };

const refused = (a: { status: number; json: () => { kind: string; message: string } }, rule: string) => {
  assert.equal(a.status, 403, a.status === 403 ? '' : JSON.stringify(a.json()));
  assert.equal(a.json().kind, 'Status');
  assert.equal(a.json().message, `denied by claudepilot policy (${rule})`);
};

describe('a stream opened for namespace B', () => {
  let rig: KubeRig;
  before(async () => {
    // The fake API server holds B's objects; the agent's own namespace is A and it also serves B.
    rig = await startKubeRig({ namespace: B, service: { namespace: HOME, namespaces: [B] }, open: { namespace: B } });
    rig.fake.deployments.set('ws-w1', { metadata: { name: 'ws-w1', labels: MANAGED }, spec: { replicas: 1, template: { metadata: { labels: MANAGED } } } } as never);
  });
  after(() => rig.stop());

  it('serves B', async () => {
    const res = await rig.request('GET', `/apis/apps/v1/namespaces/${B}/deployments`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json().items.map((d: { metadata: { name: string } }) => d.metadata.name), ['ws-w1']);
  });

  it('refuses a request for A, the agent’s own namespace, or any other; the API server never sees them', async () => {
    const n = rig.fake.requests.length;
    refused(await rig.request('GET', `/apis/apps/v1/namespaces/${HOME}/deployments`), 'namespace');
    refused(await rig.request('GET', `/api/v1/namespaces/${HOME}/pods`), 'namespace');
    refused(await rig.request('DELETE', `/apis/apps/v1/namespaces/${HOME}/deployments/ws-w1`), 'namespace');
    refused(await rig.request('GET', '/api/v1/namespaces/ns-c/pods'), 'namespace');
    assert.deepEqual(rig.fake.requests.slice(n).map((r) => r.url), []);
    // The refusals are counted under the namespace of the stream that sent them (PILOT-1172), and a report empties the counters.
    assert.deepEqual(rig.service.report!().denied, [{ rule: 'namespace', count: 4, namespace: B }]);
    assert.deepEqual(rig.service.report!(), {});
  });

  it('the refusal names the stream’s namespace, not “own namespace” (PILOT-1172)', () => {
    const r = classifyKube('GET', `/api/v1/namespaces/${HOME}/pods`, B);
    assert.ok('rule' in r && r.rule === 'namespace');
    assert.equal((r as { message: string }).message, `This stream serves namespace ${B} only.`);
  });
});

// Decision (PILOT-1172, on the ticket): an open that names no namespace falls back to the agent's own namespace only on an agent that serves
// that one namespace (every kube-mode agent before T-3720, with a portal before T-3720). An agent that serves several refuses it: it never guesses.
describe('a stream opened without a namespace, on an agent that serves one namespace (a portal from before T-3720)', () => {
  let rig: KubeRig;
  before(async () => {
    rig = await startKubeRig({ namespace: HOME, service: { namespace: HOME } });
  });
  after(() => rig.stop());

  it('is the agent’s own namespace, and any other is refused on it', async () => {
    assert.equal(await rig.service.accept!(undefined), null);
    assert.equal((await rig.request('GET', `/api/v1/namespaces/${HOME}/pods`)).status, 200);
    refused(await rig.request('GET', `/api/v1/namespaces/${B}/pods`), 'namespace');
  });
});

describe('opens on an agent that serves several namespaces', () => {
  let rig: KubeRig;
  before(async () => {
    rig = await startKubeRig({ namespace: HOME, service: { namespace: HOME, namespaces: [B] }, open: { namespace: HOME } });
  });
  after(() => rig.stop());

  it('an open that names no namespace is refused (`denied`), and a stream handed over without one is ended', async () => {
    assert.deepEqual(await rig.service.accept!(undefined), { code: 'denied', message: 'This connector serves several namespaces: the open must name one.' });
    const [portal, agent] = streamPair();
    const n = rig.fake.requests.length;
    rig.service.handle(agent, 'abcd1234', undefined);
    portal.on('error', () => undefined);
    portal.write(`GET /api/v1/namespaces/${HOME}/pods HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${LOCAL_TOKEN}\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(agent.destroyed, true);
    assert.equal(rig.fake.requests.length, n);
    rig.service.report!(); // empty the counters for the next test
  });

  it('the open is accepted for the served namespaces only: an unlisted one, or args with no namespace, is `denied`, counted by the namespace asked for', async () => {
    const accept = rig.service.accept!.bind(rig.service);
    assert.equal(await accept({ namespace: HOME }), null);
    assert.equal(await accept({ namespace: B }), null);
    for (const args of [{ namespace: 'ns-c' }, { namespace: 'ns-c' }, { namespace: 'kube-system' }, { namespace: '' }, { namespace: 5 }, { namespace: 'Bad_NS' }, { op: 'exec', argv: ['id'] }, {}]) {
      assert.deepEqual(await accept(args as never), { code: 'denied', message: 'That namespace is not served by this connector.' }, JSON.stringify(args));
    }
    assert.match(rig.log.text(), /policy\.denied.*namespace/);
    const denied = rig.service.report!().denied ?? [];
    assert.deepEqual(
      [...denied].sort((a, b) => (a.namespace ?? '').localeCompare(b.namespace ?? '')),
      [{ rule: 'namespace', count: 5 }, { rule: 'namespace', count: 1, namespace: 'kube-system' }, { rule: 'namespace', count: 2, namespace: 'ns-c' }],
    );
  });

  it('a stream handed over for an unlisted namespace is ended, never served', async () => {
    const [portal, agent] = streamPair();
    const n = rig.fake.requests.length;
    rig.service.handle(agent, 'abcd1234', { namespace: 'ns-c' } as never);
    portal.on('error', () => undefined);
    portal.write(`GET /api/v1/namespaces/ns-c/pods HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${LOCAL_TOKEN}\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(agent.destroyed, true);
    assert.equal(rig.fake.requests.length, n);
  });
});

describe('the served set', () => {
  it('streamNamespace: no args is the home namespace on a one-namespace agent only; a listed one is itself; anything else is null', () => {
    const served = new Set([HOME, B]);
    assert.equal(streamNamespace(undefined, HOME, new Set([HOME])), HOME);
    assert.equal(streamNamespace(undefined, HOME, served), null);
    assert.equal(streamNamespace({ namespace: B }, HOME, served), B);
    assert.equal(streamNamespace({ namespace: 'ns-c' }, HOME, served), null);
    assert.equal(streamNamespace(null, HOME, served), null);
    assert.equal(streamNamespace({ op: 'read' }, HOME, served), null);
  });

  it('every namespace must be a valid DNS label', () => {
    const base = { server: 'http://127.0.0.1:1', tokenFile: '/nonexistent', caFile: null, namespace: HOME, localToken: () => null, log: collectingLogger().logger };
    assert.throws(() => createService({ ...base, namespaces: ['Bad_Name'] }), /not valid/);
    assert.throws(() => createService({ ...base, namespaces: ['a/../b'] }), /not valid/);
    createService({ ...base, namespaces: [B, B, HOME] }).close();
  });
});
