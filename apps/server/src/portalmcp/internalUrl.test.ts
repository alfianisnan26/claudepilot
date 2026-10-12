import assert from 'node:assert/strict';
import { test } from 'node:test';
import { internalUrlResolver } from './internalUrl.js';
import { PortalMcpModule } from './module.js';
import { portalMcpHarness } from './testkit.js';

// How an agent's session reaches the portal (PRD §12.6), and what a lockdown's allowlist must admit for it.

const runtime = (kind: string, stdout = '172.18.0.1\n', code = 0) => ({ target: { kind }, delivery: { run: async () => ({ code, stdout, stderr: '' }) } });

test('the address: configured, or worked out per target, remembered, and never guessed for Kubernetes', async () => {
  let asked = 0;
  const runtimes: Record<string, unknown> = {
    docker: { target: { kind: 'docker' }, delivery: { run: async () => (asked++, { code: 0, stdout: 'warming up\n172.18.0.1\n', stderr: '' }) } },
    local: runtime('local'),
    k8s: runtime('kubernetes'),
    broken: runtime('docker', 'not an address', 0),
    failing: runtime('docker', '', 1),
  };
  const resolve = internalUrlResolver({ workspaces: { runtimeFor: (t: string) => runtimes[t] } as never, port: 3105, configured: null });
  assert.equal(resolve.known('docker/api'), null, 'nothing is known before it is asked');
  assert.equal(await resolve('docker/api'), 'http://172.18.0.1:3105/mcp', 'a Docker workspace reaches the portal at its default gateway');
  assert.equal(resolve.known('docker/api'), 'http://172.18.0.1:3105/mcp');
  assert.equal(await resolve('docker/api'), 'http://172.18.0.1:3105/mcp');
  assert.equal(asked, 1, 'asked once, then remembered');
  assert.equal(await resolve('local/me'), 'http://127.0.0.1:3105/mcp');
  assert.equal(await resolve('k8s/pod'), null, 'Kubernetes: the operator says');
  assert.equal(await resolve('broken/x'), null, 'output that is not an address is not used');
  assert.equal(await resolve('failing/x'), null);
  assert.equal(await resolve('nothing/x'), null, 'an unknown target');
  assert.equal(resolve.known('failing/x'), null);

  const fixed = internalUrlResolver({ workspaces: { runtimeFor: () => null } as never, port: 3105, configured: 'https://portal.internal:8443/' });
  assert.equal(await fixed('k8s/pod'), 'https://portal.internal:8443/mcp', 'PORTAL_INTERNAL_URL wins everywhere');
  assert.equal(fixed.known('anything/at-all'), 'https://portal.internal:8443/mcp');
});

test('an enrolled target: its workspaces reach the portal at the target\'s portal address, even over PORTAL_INTERNAL_URL', async () => {
  const runtimes: Record<string, unknown> = { 'cx3-dock': { target: { kind: 'docker' }, portalUrl: 'https://pilot.example.com/' }, 'cx3-box': { target: { kind: 'local' }, portalUrl: 'http://172.18.0.1:3213' } };
  const resolve = internalUrlResolver({ workspaces: { runtimeFor: (t: string) => runtimes[t] } as never, port: 3105, configured: 'https://portal.internal:8443' });
  assert.equal(await resolve('cx3-dock/w1'), 'https://pilot.example.com/mcp');
  assert.equal(resolve.known('cx3-box/cx3-box'), 'http://172.18.0.1:3213/mcp');
  assert.equal(await resolve('docker/x'), 'https://portal.internal:8443/mcp');
});

test('lockdown allowlist: the portal endpoint is admitted by its exact address, for workspaces that opted in, once the address is known', async () => {
  const h = await portalMcpHarness();
  try {
    let known: string | null = null;
    const resolved: string[] = [];
    const m = new PortalMcpModule(h.store, { agentHost: { alive: () => true, url: async (ws) => (resolved.push(ws), 'http://172.18.0.1:3105/mcp'), known: () => known } });
    m.settings.update({ enabled: true });
    const changed: string[] = [];
    m.onAgentAddress = (ws) => void changed.push(ws);

    assert.deepEqual(m.agentMatchers('docker/api'), [], 'not opted in: nothing admitted, nothing worked out');
    assert.deepEqual(resolved, []);
    m.agents.setEnabled('docker/api', true);
    assert.deepEqual(changed, ['docker/api'], 'the opt-in changes the allowlist, so a new compile is asked for');
    assert.deepEqual(m.agentMatchers('docker/api'), [], 'the address is not known yet');
    assert.deepEqual(m.agentMatchers('docker/api'), [], 'asking again meanwhile does not start it twice');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(resolved, ['docker/api'], 'worked out in the background, once');
    assert.deepEqual(changed, ['docker/api', 'docker/api'], 'and a new compile is asked for when it is known');

    known = 'http://172.18.0.1:3105/mcp';
    assert.deepEqual(m.agentMatchers('docker/api'), [{ serverUrl: 'http://172.18.0.1:3105/mcp' }]);
    assert.deepEqual(m.agentMatchers('docker/web'), [], 'another workspace did not opt in');
    m.settings.update({ enabled: false });
    assert.deepEqual(m.agentMatchers('docker/api'), [], 'MCP off: nothing admitted');
    m.settings.update({ enabled: true });
    m.agents.setEnabled('docker/api', true);
    assert.equal(changed.length, 2, 'turning on what is on changes nothing');
    m.agents.setEnabled('docker/api', false);
    assert.deepEqual(m.agentMatchers('docker/api'), [], 'opted out: no longer admitted');
    assert.equal(changed.length, 3);
  } finally {
    h.done();
  }
});
