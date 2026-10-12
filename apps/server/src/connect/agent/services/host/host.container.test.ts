// T-HOST in the Container rig (docs/prd/targets-connect.md §11.6, §19.3), opt-in with CLAUDEPILOT_DOCKER_TESTS=1: the host service as root in a real
// container with the image's `node` user. Commands run as node (uid and gid looked up at start) or root, the agent's own settings are not inherited, a
// terminal works, `put` sets the owner and mode of what it writes, and usage comes from the container's cgroup. One short-lived container, removed after.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const NAME = 'cx2-host-rig';
const IMAGE = process.env.CX2_RIG_IMAGE ?? 'node:22-trixie-slim';

describe('the host service as root in a container', { skip: enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 (a Docker daemon and the node image are needed)' }, () => {
  after(() => {
    try {
      execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  });

  it('switches to the node user, scrubs PILOT_*, sets owners and modes on put, and reads cgroup usage', () => {
    const repo = new URL('../../../../../../..', import.meta.url).pathname.replace(/\/$/, '');
    const stdout = execFileSync(
      'docker',
      ['run', '--rm', '--name', NAME, '--cpus', '1', '--memory', '256m', '-u', '0', '-e', `PILOT_ENROLL_TOKEN=${['cpen_', 'must-not-reach-a-command'].join('')}`, '-v', `${repo}:/repo:ro`, '-w', '/repo/apps/server', IMAGE, 'node', '--import', 'tsx', 'src/connect/agent/testkit/containerProbe.ts'],
      { encoding: 'utf8', timeout: 120_000, env: { ...process.env } },
    );
    const out = JSON.parse(stdout.trim().split('\n').at(-1)!) as {
      uid: number;
      asNode: { text: string; result: { code: number } };
      asRoot: { text: string };
      tty: { text?: string; result?: { code: number }; error?: string };
      put: { code: number; skipped?: unknown[] };
      stat: string;
      read: { text: string };
      usage: { cores: number; memoryBytes: number; memoryTotalBytes: number };
    };
    assert.equal(out.uid, 0, 'the agent runs as root in the container');
    assert.deepEqual(out.asNode.text.split('\n').slice(0, 7), ['1000', '1000', 'node', '/home/node', '/home/node', '0', '1']);
    assert.deepEqual(out.asNode.result, { code: 0 });
    assert.deepEqual(out.asRoot.text.split('\n').slice(0, 3), ['0', '/root', '/root']);
    assert.equal(out.tty.error, undefined, out.tty.error);
    assert.match(out.tty.text ?? '', /node/);
    assert.match(out.tty.text ?? '', /30 100/);
    assert.deepEqual(out.put, { code: 0 });
    assert.equal(out.stat, '1000:1000 600 /home/node/secret.txt\n0:0 644 /etc/claudepilot/by-root\n1000:1000 750 /home/node\n');
    assert.equal(out.read.text, 'hush');
    assert.equal(out.usage.cores, 1, 'cpu.max says one core');
    assert.equal(out.usage.memoryTotalBytes, 256 * 1024 * 1024, 'memory.max says 256 MB');
    assert.ok(out.usage.memoryBytes > 0 && out.usage.memoryBytes < out.usage.memoryTotalBytes);
  });
});
