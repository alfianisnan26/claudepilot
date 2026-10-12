// The bundle on the OLDEST Node it supports (docs/prd/targets-connect.md §11.1: Node 22.13 or newer), opt-in with CLAUDEPILOT_DOCKER_TESTS=1: the generated
// `agent.mjs` runs in a `node:22.13.0-slim` container on the host network (the dev container's own DinD: the container shares this machine's loopback),
// enrolls with the token on stdin against the real hub of this process, connects, runs a command and leaves on `docker stop`. One short-lived container.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PILOT_AGENT } from '../agent.generated.js';
import { openPortal, type Portal } from './testkit/portalRig.js';
import { parseResult, RECORD, RecordParser } from '../tunnel/records.js';

const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const IMAGE = process.env.CX2_NODE_MIN_IMAGE ?? 'node:22.13.0-slim';
const NAME = 'cx2-node-min';

describe('the bundle on Node 22.13', { skip: enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 (Docker and the node:22.13.0-slim image are needed)' }, () => {
  let portal: Portal;
  let dir: string;
  before(async () => {
    portal = await openPortal();
    dir = mkdtempSync(join(tmpdir(), 'cx2-nodemin-'));
    mkdirSync(join(dir, 'bundle'), { mode: 0o755 });
    mkdirSync(join(dir, 'state', 'home'), { recursive: true });
    chmodSync(join(dir, 'state'), 0o777); // the container runs as uid 1000, not as this user
    chmodSync(join(dir, 'state', 'home'), 0o777);
    writeFileSync(join(dir, 'bundle', 'agent.mjs'), PILOT_AGENT, { mode: 0o644 });
  });
  after(async () => {
    try {
      execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
    } catch {
      // gone already
    }
    await portal?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints its version, enrolls, connects, serves a host command and says bye on SIGTERM', async () => {
    const version = execFileSync('docker', ['run', '--rm', '-v', `${join(dir, 'bundle')}:/agent:ro`, IMAGE, 'node', '/agent/agent.mjs', 'version'], { encoding: 'utf8' });
    assert.match(version, /^pilot-agent 0\.1\.0 \(build [0-9a-f]{12}, protocol 1\)\n$/);

    const t = portal.target({ id: 'node-min' });
    const env = ['-e', 'PILOT_MODE=host', '-e', `PILOT_URL=${portal.origin}`, '-e', 'PILOT_DATA_DIR=/state', '-e', 'PILOT_HOME=/state/home', '-e', 'PILOT_ALLOW_HTTP=1'];
    const common = ['--network', 'host', '--user', '1000:1000', '-v', `${join(dir, 'bundle')}:/agent:ro`, '-v', `${join(dir, 'state')}:/state`, ...env];
    const enroll = spawn('docker', ['run', '--rm', '-i', '--name', `${NAME}-enroll`, ...common, IMAGE, 'node', '/agent/agent.mjs', 'enroll', '--token-stdin']);
    let enrollOut = '';
    enroll.stdout.on('data', (d: Buffer) => (enrollOut += d));
    enroll.stderr.on('data', (d: Buffer) => (enrollOut += d));
    enroll.stdin.end(`${t.token}\n`);
    const code = await new Promise<number | null>((resolve) => enroll.on('close', resolve));
    assert.equal(code, 0, enrollOut);
    assert.match(enrollOut, /Enrolled as nd_[0-9a-f]+ \(target node-min\)/);

    const run = spawn('docker', ['run', '--rm', '--name', NAME, ...common, IMAGE, 'node', '/agent/agent.mjs', 'run']);
    let log = '';
    run.stdout.on('data', (d: Buffer) => (log += d));
    run.stderr.on('data', (d: Buffer) => (log += d));
    const nodeId = /Enrolled as (nd_[0-9a-f]+)/.exec(enrollOut)![1]!;
    const start = Date.now();
    while (!portal.hub.hub.isConnected(nodeId)) {
      if (Date.now() - start > 60_000) throw new Error(`no connection from the Node 22.13 container; its log:\n${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const stream = await portal.hub.hub.link({ id: nodeId, targetId: 'node-min' }).open('host', { op: 'exec', argv: ['sh', '-c', 'echo node=$(node --version)'] });
    const parser = new RecordParser();
    const text: Buffer[] = [];
    let result: unknown = null;
    stream.on('data', (c: Buffer) => parser.push(c).forEach((r) => (r.kind === RECORD.data && text.push(r.payload), r.kind === RECORD.result && (result = parseResult(r.payload)))));
    stream.on('end', () => stream.end());
    const t0 = Date.now();
    while (!result && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(result, { code: 0 });
    assert.equal(Buffer.concat(text).toString().trim(), 'node=v22.13.0');
    assert.equal(portal.hub.hub.connection(nodeId)!.hello.os, 'linux');

    execFileSync('docker', ['stop', '-t', '10', NAME], { stdio: 'ignore' });
    const exited = Date.now();
    while (portal.hub.hub.isConnected(nodeId) && Date.now() - exited < 10_000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(portal.hub.hub.isConnected(nodeId), false);
    assert.equal(log.includes(t.token), false, 'the token is not in the container’s log');
  });
});
