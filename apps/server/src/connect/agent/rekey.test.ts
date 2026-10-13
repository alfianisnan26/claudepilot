// T-AGENT: key rotation (docs/prd/targets-connect.md §10.4) against the real hub, with a crash injected at every step. The agent makes a new key,
// saves it as `identity.next.json`, proves it with the OLD key, and moves it over `identity.json` only after the portal said yes. Whichever step the
// process dies at, a restart must end up connected with a key the portal accepts, and the files must say which one it is.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { runAgent, type AgentHandle, type RunAgentOptions } from './client.js';
import { fingerprintOf, FileIdentityStore } from './identity.js';
import { collectingLogger } from './log.js';
import { agentConfig } from './testkit/agentConfig.js';
import { openPortal, stopAgents, type Portal } from './testkit/portalRig.js';
import { until, withTimeout } from '../testkit.js';
import { writeLine } from '../tunnel/lines.js';

let portal: Portal;
let dir: string;
const agents: AgentHandle[] = [];

before(async () => {
  portal = await openPortal();
});
after(() => portal.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cx2-rekey-'));
  mkdirSync(join(dir, 'home'));
});
afterEach(async () => {
  await stopAgents(agents);
  rmSync(dir, { recursive: true, force: true });
});

const start = (over: Partial<RunAgentOptions> & { token?: string } = {}) => {
  const log = collectingLogger();
  const { token, ...rest } = over;
  const h = runAgent({ config: agentConfig({ dataDir: join(dir, 'agent'), home: join(dir, 'home'), url: portal.origin, enrollToken: token ?? null }), log: log.logger, build: 'cccccccccccc', ...rest });
  agents.push(h);
  return { h, log };
};
const files = () => ({ current: new FileIdentityStore(join(dir, 'agent')), next: join(dir, 'agent', 'identity.next.json') });
const keyOf = (node: string) => portal.core.registry.requireNode(node).keyFingerprint;

describe('rotating the node key', () => {
  it('rotates on request: a new key, saved after the portal says yes, the old one kept by the portal for the grace; the next connect uses the new one', async () => {
    const t = portal.target({ id: 'rot-ok' });
    const { h } = start({ token: t.token });
    await h.whenConnected();
    const node = h.identity()!.node;
    const before = fingerprintOf(h.identity()!);
    const rekeyed = new Promise<string>((resolve) => h.events.once('rekeyed', (e) => resolve(e.fingerprint)));
    await withTimeout(portal.hub.hub.rotate(node), 'the rotate notice to be sent');
    const fp = await withTimeout(rekeyed, "the agent's rekeyed event");
    assert.notEqual(fp, before);
    assert.equal(fingerprintOf((await files().current.load())!), fp, 'identity.json holds the new key');
    assert.equal(existsSync(files().next), false, 'nothing is left pending');
    assert.equal(keyOf(node), fp, 'the portal shows the same fingerprint');
    assert.ok(portal.events('rot-ok').some((e) => e.type === 'node.rotated'));
    // A cut connection comes back with the new key.
    portal.hub.hub.connection(node)!.ws.terminate();
    await until(() => !portal.hub.hub.isConnected(node), 'the hub to drop the cut connection');
    await until(() => portal.hub.hub.isConnected(node), 'the agent to come back with the new key');
    await h.whenConnected();
    assert.equal(h.identity()!.node, node);
  });

  it('a refused rotation changes nothing and removes what it saved', async () => {
    const t = portal.target({ id: 'rot-no' });
    const { h, log } = start({ token: t.token });
    await h.whenConnected();
    const node = h.identity()!.node;
    const before = keyOf(node);
    // The portal asked for nothing: the agent is told to rotate anyway (a rogue or stale notice), and the hub refuses.
    const control = portal.hub.hub.connection(node)!.control!;
    await writeLine(control, { t: 'notice', level: 'info', message: 'rotate', action: 'rotate' });
    await until(() => /rekey\.refused/.test(log.text()), 'rekey.refused in the log');
    assert.equal(keyOf(node), before);
    assert.equal(fingerprintOf(h.identity()!), before);
    await until(() => !existsSync(files().next), 'identity.next.json to be removed');
    assert.equal(h.connected(), true);
  });

  for (const [step, expectNew, why] of [
    ['saved-next', false, 'the portal never heard of the new key: the restart tries it, is told bad_signature, drops it and goes back to the old key'],
    ['rekey-sent', true, 'the portal stored the new key: the restart finds identity.next.json, authenticates with it and promotes it'],
    ['answered', true, 'the answer was read but the files were not moved: the restart promotes the new key'],
    ['promoted', true, 'the files were moved: nothing is pending, the restart simply uses the new identity'],
  ] as const) {
    it(`survives a crash at "${step}": ${why}`, async () => {
      const t = portal.target({ id: `rot-${step}` });
      const first = start({ token: t.token });
      await first.h.whenConnected();
      const node = first.h.identity()!.node;
      const oldFp = fingerprintOf(first.h.identity()!);
      let died = false;
      // Restart the agent on the same files, with a hook that dies at `step`; wait for the portal to have what the step implies, then die.
      await first.h.stop();
      await until(() => !portal.hub.hub.isConnected(node), 'the first agent to be gone from the hub');
      const crashing = start({
        rotationHook: async (s) => {
          if (s !== step) return;
          if (step !== 'saved-next') await until(() => keyOf(node) !== oldFp, 'the portal to store the new key');
          died = true;
          throw new Error('crash');
        },
      });
      await crashing.h.whenConnected();
      await withTimeout(portal.hub.hub.rotate(node), 'the rotate notice to be sent');
      await until(() => died, `the crash at "${step}"`);
      await withTimeout(crashing.h.done, 'the crashed agent to be done');
      assert.equal(crashing.h.state(), 'stopped', 'the agent died without cleaning up');

      // Restart: whatever is on disk, it must connect, and the files and the portal must agree on the key.
      const again = start();
      await again.h.whenConnected();
      await until(() => portal.hub.hub.isConnected(node), 'the restarted agent on the hub');
      const fp = fingerprintOf(again.h.identity()!);
      assert.equal(existsSync(files().next), false, 'no rotation is left pending');
      assert.equal(fingerprintOf((await files().current.load())!), fp);
      if (expectNew) {
        assert.notEqual(fp, oldFp, 'the identity is the new one');
        assert.equal(keyOf(node), fp);
      } else {
        assert.equal(fp, oldFp, 'the identity is still the old one');
        assert.equal(keyOf(node), oldFp);
      }
      assert.equal(readFileSync(join(dir, 'agent', 'identity.json'), 'utf8').includes('"privateKey"'), true);
      assert.equal(again.log.text().includes(JSON.parse(readFileSync(join(dir, 'agent', 'identity.json'), 'utf8')).privateKey), false, 'the key is not in the log');
    });
  }
});
