// PILOT-1171 (G6c): src/bridge/kubeApi.ts, the checks and the request of each REST call, and the reading of each answer. The calls through a
// live link (BridgeDO's RPCs against a stand-in agent) are in bridge.test.ts; through the real agent, in
// apps/server/src/connect/tunnel/bridgeWorker.test.ts.

import { CONNECT_LIMITS } from '@portal/contracts';
import { describe, expect, it } from 'vitest';
import { kubeCallOf, kubePathProblem, kubeResultOf, kubeStatusFailure, type KubeCall, type KubeOp } from '../src/bridge/kubeApi.js';

const NS = 'claudepilot-workspaces';
const call = (op: KubeOp): KubeCall => {
  const c = kubeCallOf(NS, op);
  if ('ok' in c) throw new Error(`refused: ${c.message}`);
  return c;
};
const refused = (op: unknown, ns = NS) => kubeCallOf(ns, op as KubeOp);
const deployment = (patch: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  metadata: { name: 'ws-0123456789ab', labels: { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'demo' }, ...meta },
  spec: { replicas: 1 },
  ...patch,
});

describe('kubePathProblem: the Worker refuses what is not plain segments (review of PILOT-1170, T-3737 comment 59417)', () => {
  it('passes the paths the portal uses', () => {
    for (const p of [
      '/version',
      `/api/v1/namespaces/${NS}/pods`,
      `/apis/apps/v1/namespaces/${NS}/deployments/ws-0123456789ab/scale`,
      `/apis/metrics.k8s.io/v1beta1/namespaces/${NS}/pods`,
    ])
      expect(kubePathProblem(p), p).toBeNull();
  });

  it('refuses dot segments, plain or percent-encoded in either case', () => {
    for (const p of [
      `/api/v1/namespaces/${NS}/../../secrets`,
      '/api/v1/namespaces/x/pods/..',
      '/./api/v1',
      '/api/v1/.',
      '/api/%2e%2e/v1/secrets',
      '/api/%2E%2E/v1/secrets',
      '/api/.%2e/v1',
      '/api/%2E./v1',
      '/api/v1/namespaces/x/pods%2f..%2fsecrets',
      '/api/%252e%252e/v1',
    ])
      expect(kubePathProblem(p), p).not.toBeNull();
  });

  it('refuses a query string and a fragment: a query is built by the Worker, never passed in', () => {
    for (const p of [`/api/v1/namespaces/${NS}/pods?labelSelector=`, `/api/v1/namespaces/${NS}/pods?watch=true`, '/api/v1?', '/version#x'])
      expect(kubePathProblem(p), p).toMatch(/query/);
  });

  it('refuses anything else that is not origin-form segments', () => {
    const long = `/${'a'.repeat(2048)}`;
    for (const p of ['', '/', 'api/v1', '//api/v1', '/api//v1', '/api/v1/', '/api\\v1', '/api/v 1', '/api/v1/ü', long, 42, null, undefined])
      expect(kubePathProblem(p), String(p).slice(0, 40)).not.toBeNull();
  });
});

describe('kubeCallOf: each call is checked and built here', () => {
  it('a list carries the managed selector; `workspace` narrows it', () => {
    expect(call({ op: 'list', kind: 'pods' })).toEqual({
      method: 'GET',
      path: `/api/v1/namespaces/${NS}/pods`,
      query: 'labelSelector=claudepilot.managed%3Dtrue',
    });
    const one = call({ op: 'list', kind: 'deployments', workspace: 'demo' });
    expect(one.path).toBe(`/apis/apps/v1/namespaces/${NS}/deployments`);
    expect(new URLSearchParams(one.query).get('labelSelector')).toBe('claudepilot.managed=true,claudepilot.workspace=demo');
    expect(call({ op: 'list', kind: 'claims' }).path).toBe(`/api/v1/namespaces/${NS}/persistentvolumeclaims`);
    const metrics = call({ op: 'metrics' });
    expect(metrics.path).toBe(`/apis/metrics.k8s.io/v1beta1/namespaces/${NS}/pods`);
    expect(new URLSearchParams(metrics.query).get('labelSelector')).toBe('claudepilot.managed=true');
  });

  it('a list refuses an unknown kind and a workspace label that would widen the selector', () => {
    expect(refused({ op: 'list', kind: 'secrets' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(refused({ op: 'list', kind: '__proto__' })).toMatchObject({ ok: false, code: 'bad_request' });
    for (const workspace of ['a,claudepilot.managed!=true', 'a b', 'A', '', 'x'.repeat(64), 7])
      expect(refused({ op: 'list', kind: 'pods', workspace }), String(workspace)).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('a create is put in the namespace with its apiVersion and kind; the name, the label and the size are checked', () => {
    const c = call({ op: 'create', kind: 'deployment', object: deployment() });
    expect(c).toMatchObject({ method: 'POST', path: `/apis/apps/v1/namespaces/${NS}/deployments`, query: '' });
    expect(JSON.parse(c.body!)).toMatchObject({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'ws-0123456789ab', namespace: NS } });
    const claim = call({
      op: 'create',
      kind: 'claim',
      object: { metadata: { name: 'ws-0123456789ab-home', labels: { 'claudepilot.managed': 'true' } }, spec: {} },
    });
    expect(claim.path).toBe(`/api/v1/namespaces/${NS}/persistentvolumeclaims`);
    expect(JSON.parse(claim.body!)).toMatchObject({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { namespace: NS } });

    const bad: [string, unknown][] = [
      ['a name that is not a workspace’s', deployment({}, { name: 'cp-bridge' })],
      ['a name with a dot segment', deployment({}, { name: 'ws-a/../x' })],
      ['a name with an encoded dot', deployment({}, { name: 'ws-%2e%2e' })],
      ['a name that is not a DNS label', deployment({}, { name: 'ws-0123456789ab-home-' })],
      ['another namespace', deployment({}, { namespace: 'kube-system' })],
      ['no managed label', deployment({}, { labels: { 'claudepilot.workspace': 'demo' } })],
      ['another kind', deployment({ kind: 'DaemonSet' })],
      ['another apiVersion', deployment({ apiVersion: 'extensions/v1beta1' })],
      ['no metadata', { spec: {} }],
      ['not an object', 'ws-a'],
      ['too large', deployment({ spec: { pad: 'x'.repeat(CONNECT_LIMITS.maxJsonBody) } })],
    ];
    for (const [what, object] of bad)
      expect(refused({ op: 'create', kind: 'deployment', object }), what).toMatchObject({ ok: false, code: 'bad_request' });
    expect(refused({ op: 'create', kind: 'claim', object: deployment() })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(refused({ op: 'create', kind: 'secret', object: deployment() })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(refused({ op: 'create', kind: 'toString', object: deployment() })).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('a scale is a PUT of a Scale with 0 or 1 replicas', () => {
    const c = call({ op: 'scale', name: 'ws-0123456789ab', replicas: 0 });
    expect(c).toMatchObject({ method: 'PUT', path: `/apis/apps/v1/namespaces/${NS}/deployments/ws-0123456789ab/scale`, query: '' });
    expect(JSON.parse(c.body!)).toEqual({
      apiVersion: 'autoscaling/v1',
      kind: 'Scale',
      metadata: { name: 'ws-0123456789ab', namespace: NS },
      spec: { replicas: 0 },
    });
    for (const replicas of [2, -1, 0.5, '1', NaN])
      expect(refused({ op: 'scale', name: 'ws-0123456789ab', replicas }), String(replicas)).toMatchObject({ code: 'bad_request' });
    for (const name of ['ws-a/..', '..', 'ws-%2e', 'kube-dns', 'ws-a?x=1'])
      expect(refused({ op: 'scale', name, replicas: 1 }), name).toMatchObject({ code: 'bad_request' });
  });

  it('a delete names one object: a Deployment in the foreground, a claim plainly', () => {
    expect(call({ op: 'delete', kind: 'deployment', name: 'ws-0123456789ab' })).toEqual({
      method: 'DELETE',
      path: `/apis/apps/v1/namespaces/${NS}/deployments/ws-0123456789ab`,
      query: 'propagationPolicy=Foreground',
    });
    expect(call({ op: 'delete', kind: 'claim', name: 'ws-0123456789ab-home' })).toEqual({
      method: 'DELETE',
      path: `/api/v1/namespaces/${NS}/persistentvolumeclaims/ws-0123456789ab-home`,
      query: '',
    });
    expect(refused({ op: 'delete', kind: 'claim', name: 'ws-0123456789ab' })).toMatchObject({ code: 'bad_request' });
    expect(refused({ op: 'delete', kind: 'deployment', name: '../secrets/x' })).toMatchObject({ code: 'bad_request' });
  });

  it('refuses a namespace that is not a DNS label, and a call it does not know', () => {
    for (const ns of ['..', 'a/b', 'Kube', '', '%2e'])
      expect(refused({ op: 'list', kind: 'pods' }, ns), ns).toMatchObject({ code: 'bad_request' });
    expect(refused({ op: 'exec' })).toMatchObject({ code: 'bad_request' });
    expect(refused(null)).toMatchObject({ code: 'bad_request' });
  });
});

describe('kubeResultOf and kubeStatusFailure: the answers', () => {
  const status = (code: number, reason: string, message: string) =>
    JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', code, reason, message });

  it('a Status answer is a kube_status failure with its status, reason and message', () => {
    expect(kubeStatusFailure(409, status(409, 'AlreadyExists', 'deployment ws-a already exists'))).toEqual({
      ok: false,
      code: 'kube_status',
      status: 409,
      reason: 'AlreadyExists',
      message: 'deployment ws-a already exists',
    });
    expect(kubeStatusFailure(502, '<html>bad gateway</html>')).toEqual({
      ok: false,
      code: 'kube_status',
      status: 502,
      reason: null,
      message: 'The Kubernetes API answered 502.',
    });
    expect((kubeStatusFailure(500, status(500, 'x'.repeat(100), 'y'.repeat(1000))) as { message: string }).message).toHaveLength(300);
  });

  it('reads each call’s answer; a missing object on delete is deleted: false', () => {
    const list: KubeOp = { op: 'list', kind: 'pods' };
    expect(kubeResultOf(list, 200, JSON.stringify({ kind: 'PodList', items: [{ metadata: { name: 'ws-a' } }] }))).toEqual({
      ok: true,
      items: [{ metadata: { name: 'ws-a' } }],
    });
    expect(kubeResultOf(list, 200, '{"kind":"PodList"}')).toMatchObject({ ok: false, code: 'bad_response' });
    expect(kubeResultOf(list, 200, 'not json')).toMatchObject({ ok: false, code: 'bad_response' });
    expect(kubeResultOf(list, 403, status(403, 'Forbidden', 'denied'))).toMatchObject({ code: 'kube_status', status: 403, reason: 'Forbidden' });
    const create: KubeOp = { op: 'create', kind: 'deployment', object: deployment() };
    expect(kubeResultOf(create, 201, JSON.stringify({ metadata: { name: 'ws-a', uid: 'u1' } }))).toEqual({
      ok: true,
      object: { metadata: { name: 'ws-a', uid: 'u1' } },
    });
    const scale: KubeOp = { op: 'scale', name: 'ws-0123456789ab', replicas: 1 };
    expect(kubeResultOf(scale, 200, JSON.stringify({ kind: 'Scale', spec: { replicas: 1 } }))).toEqual({ ok: true, replicas: 1 });
    expect(kubeResultOf(scale, 404, status(404, 'NotFound', 'deployment "ws-x" not found'))).toMatchObject({ status: 404, reason: 'NotFound' });
    const del: KubeOp = { op: 'delete', kind: 'deployment', name: 'ws-0123456789ab' };
    expect(kubeResultOf(del, 200, '{"kind":"Status","status":"Success"}')).toEqual({ ok: true, deleted: true });
    expect(kubeResultOf(del, 404, status(404, 'NotFound', 'gone'))).toEqual({ ok: true, deleted: false });
    expect(kubeResultOf(del, 403, status(403, 'Forbidden', 'no'))).toMatchObject({ ok: false, status: 403 });
  });
});
