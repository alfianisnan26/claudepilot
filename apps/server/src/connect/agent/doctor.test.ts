// T-AGENT: `pilot-agent doctor` (docs/prd/targets-connect.md §11.8). Every check of CONNECT_DOCTOR_CHECKS appears once, in the contract's vocabulary,
// with what it saw and, when it fails, what to do. Run against the real hub, the fake Docker daemon and the fake Kubernetes API server.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CONNECT_DOCTOR_CHECKS } from '@portal/contracts';
import { runAgent } from './client.js';
import { formatReport, reportFailed, runDoctor, RBAC_NEEDS } from './doctor.js';
import { FileIdentityStore } from './identity.js';
import { collectingLogger } from './log.js';
import { agentConfig } from './testkit/agentConfig.js';
import { FakeDocker } from './testkit/fakeDocker.js';
import { FakeKube } from './testkit/fakeKube.js';
import { openPortal, type Portal } from './testkit/portalRig.js';
import { withTimeout } from '../testkit.js';
import { writeFileSync } from 'node:fs';

let portal: Portal;
let dir: string;
before(async () => {
  portal = await openPortal();
  dir = mkdtempSync(join(tmpdir(), 'cx2-doctor-'));
  mkdirSync(join(dir, 'home'));
});
after(async () => {
  await portal.close();
  rmSync(dir, { recursive: true, force: true });
});

const byId = (r: Awaited<ReturnType<typeof runDoctor>>) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

describe('doctor on a host agent', () => {
  it('reports every check once, each ok, failed or skipped, in the contract’s vocabulary', async () => {
    const t = portal.target({ id: 'doc-host' });
    const config = agentConfig({ dataDir: join(dir, 'host'), home: join(dir, 'home'), url: portal.origin, enrollToken: t.token, headers: { 'X-Secret-Header': 'canary-header-value' } });
    const h = runAgent({ config, log: collectingLogger().logger, build: 'eeeeeeeeeeee' });
    try {
      await h.whenConnected();
      const report = await runDoctor({ config, build: 'eeeeeeeeeeee', net: { headers: config.headers }, store: new FileIdentityStore(config.dataDir) });
      assert.deepEqual(report.checks.map((c) => c.id), [...CONNECT_DOCTOR_CHECKS]);
      assert.equal(report.agentBuild, 'eeeeeeeeeeee');
      assert.equal(report.protocol, 1);
      const c = byId(report);
      assert.equal(c['portal.dns']!.ok, true);
      assert.equal(c['portal.tcp']!.ok, true);
      assert.equal(c['portal.tls']!.ok, null, 'plain http: nothing to verify');
      assert.equal(c['portal.health']!.ok, true, JSON.stringify(c['portal.health']));
      assert.equal(c['portal.websocket']!.ok, true, JSON.stringify(c['portal.websocket']));
      assert.equal(c['portal.proxy']!.detail, 'direct, no proxy');
      assert.equal(c.clock!.ok, true);
      assert.equal(c.identity!.ok, true);
      assert.match(c.identity!.detail, /fingerprint [0-9a-f]{32}/);
      assert.equal(c['docker.socket']!.ok, null);
      assert.equal(c['docker.api']!.ok, null);
      assert.equal(c['docker.policy']!.ok, null);
      assert.equal(c['kube.api']!.ok, null);
      assert.equal(c['kube.rbac']!.ok, null);
      assert.equal(c['host.pty']!.ok, true);
      assert.equal(c.disk!.ok, true);
      assert.ok(typeof c['host.tools']!.ok === 'boolean');
      assert.equal(JSON.stringify(report).includes('canary-header-value'), false, 'a header value is never in the report');
      assert.equal(JSON.stringify(report).includes('privateKey'), false);
      const text = formatReport(report);
      assert.match(text, /^pilot-agent 0\.1\.0 \(build eeeeeeeeeeee, protocol 1\)\n/);
      assert.match(text, /ok   portal\.health/);
    } finally {
      await withTimeout(h.stop(), 'the agent to stop');
    }
  });

  it('says what to do when the portal can’t be reached, the identity is missing or readable by others, and the pty library is absent', async () => {
    const config = agentConfig({ dataDir: join(dir, 'broken'), home: join(dir, 'home'), url: 'http://127.0.0.1:1' });
    const store = new FileIdentityStore(config.dataDir);
    const report = await runDoctor({ config, build: '000000000000', net: {}, store });
    const c = byId(report);
    assert.equal(c['portal.tcp']!.ok, false);
    assert.match(c['portal.tcp']!.hint!, /firewall|address|proxy/i);
    assert.equal(c['portal.health']!.ok, false);
    assert.equal(c['portal.websocket']!.ok, false);
    assert.equal(c.identity!.ok, false);
    assert.match(c.identity!.hint!, /Enroll/);
    assert.equal(reportFailed(report), true);
    assert.match(formatReport(report), /FAIL portal\.tcp[^\n]*\n\s+-> /);

    // An identity that anyone can read.
    const keys = (await import('../tunnel/auth.js')).generateNodeKeyPair();
    await store.save({ node: 'nd_0123456789ab', target: 'x', portalUrl: 'http://127.0.0.1:1', portalId: null, privateKey: keys.privateKey, publicKey: keys.publicKey, enrolledAt: new Date().toISOString() });
    chmodSync(join(config.dataDir, 'identity.json'), 0o644);
    const loose = byId(await runDoctor({ config, build: '000000000000', net: {}, store }));
    assert.equal(loose.identity!.ok, false);
    assert.match(loose.identity!.hint!, /chmod 600/);
    writeFileSync(join(config.dataDir, 'identity.json'), '{broken');
    assert.match(byId(await runDoctor({ config, build: '000000000000', net: {}, store })).identity!.detail, /not valid JSON/);
  });

  it('host tools: names what is missing and where to get it', async () => {
    const config = agentConfig({ dataDir: join(dir, 'tools'), home: join(dir, 'home'), url: portal.origin });
    const none = byId(await runDoctor({ config, build: '0', net: {}, store: new FileIdentityStore(config.dataDir), path: '/nonexistent' }));
    assert.equal(none['host.tools']!.ok, false);
    assert.match(none['host.tools']!.detail, /tmux/);
    assert.match(none['host.tools']!.hint!, /package manager|brew/);
  });
});

describe('doctor on a docker agent', () => {
  it('checks the socket, the API, and the policy’s own self-test', async () => {
    const fake = await FakeDocker.start();
    try {
      const config = agentConfig({ mode: 'docker', dataDir: join(dir, 'dock'), url: portal.origin, dockerSocket: fake.socketPath, images: ['claudepilot-workspace:latest'] });
      const c = byId(await runDoctor({ config, build: '0', net: {}, store: new FileIdentityStore(config.dataDir) }));
      assert.equal(c['docker.socket']!.ok, true);
      assert.equal(c['docker.api']!.ok, true);
      assert.match(c['docker.api']!.detail, /Docker 27\.3\.1/);
      assert.equal(c['docker.policy']!.ok, true);
      assert.equal(c['host.tools']!.ok, null);
      assert.equal(c['host.pty']!.ok, null);
      // The self-test used no daemon: the fake saw only the API check.
      assert.deepEqual([...new Set(fake.requests.map((r) => r.url.split('?')[0]))].sort(), ['/info', '/version']);

      fake.info.OSType = 'windows';
      assert.match(byId(await runDoctor({ config, build: '0', net: {}, store: new FileIdentityStore(config.dataDir) }))['docker.api']!.hint!, /Linux containers/);
      fake.info.OSType = 'linux';
      fake.info.SecurityOptions = ['name=seccomp,profile=builtin', 'name=rootless'];
      assert.match(byId(await runDoctor({ config, build: '0', net: {}, store: new FileIdentityStore(config.dataDir) }))['docker.api']!.detail, /rootless/i);
    } finally {
      await fake.stop();
    }
  });

  it('a missing socket says so and what to do', async () => {
    const config = agentConfig({ mode: 'docker', dataDir: join(dir, 'nodock'), url: portal.origin, dockerSocket: join(dir, 'nope.sock') });
    const c = byId(await runDoctor({ config, build: '0', net: {}, store: new FileIdentityStore(config.dataDir) }));
    assert.equal(c['docker.socket']!.ok, false);
    assert.match(c['docker.socket']!.hint!, /Is Docker running\?|Docker Desktop/);
    assert.equal(c['docker.api']!.ok, false);
  });
});

describe('doctor on a kubernetes agent', () => {
  it('checks the API server and every verb the connector’s Role must grant', async () => {
    const fake = await FakeKube.start();
    const tokenFile = join(dir, 'sa-token');
    writeFileSync(tokenFile, `${fake.token}\n`);
    try {
      const config = agentConfig({ mode: 'kubernetes', dataDir: join(dir, 'kube'), url: portal.origin, kubeNamespace: fake.namespace });
      const kube = { server: fake.url, tokenFile, caFile: null };
      const ok = byId(await runDoctor({ config, build: '0', net: {}, store: new FileIdentityStore(config.dataDir), kube }));
      assert.equal(ok['kube.api']!.ok, true);
      assert.match(ok['kube.api']!.detail, /v1\.30\.1/);
      assert.equal(ok['kube.rbac']!.ok, true, JSON.stringify(ok['kube.rbac']));
      const asked = fake.requests.filter((r) => r.url.includes('selfsubjectaccessreviews'));
      assert.equal(asked.length, RBAC_NEEDS.reduce((n, r) => n + r.verbs.length, 0));
      assert.equal(JSON.parse(asked[0]!.body.toString()).spec.resourceAttributes.namespace, fake.namespace);

      fake.rbac = (a) => !(a.verb === 'delete' && a.resource === 'secrets') && a.subresource !== 'exec';
      const missing = byId(await runDoctor({ config, build: '0', net: {}, store: new FileIdentityStore(config.dataDir), kube }));
      assert.equal(missing['kube.rbac']!.ok, false);
      assert.match(missing['kube.rbac']!.detail, /delete secrets/);
      assert.match(missing['kube.rbac']!.detail, /create pods\/exec/);
      assert.match(missing['kube.rbac']!.hint!, /manifest/);
    } finally {
      await fake.stop();
    }
  });

  it('outside a cluster it says so', async () => {
    const config = agentConfig({ mode: 'kubernetes', dataDir: join(dir, 'kube2'), url: portal.origin, kubeNamespace: 'x' });
    const saved = process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_HOST;
    try {
      const c = byId(await runDoctor({ config, build: '0', net: {}, store: new FileIdentityStore(config.dataDir) }));
      assert.equal(c['kube.api']!.ok, false);
      assert.match(c['kube.api']!.detail, /Not running in a cluster/);
    } finally {
      if (saved !== undefined) process.env.KUBERNETES_SERVICE_HOST = saved;
    }
  });
});
