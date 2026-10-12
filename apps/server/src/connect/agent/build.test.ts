// The generated bundle (docs/prd/targets-connect.md §11.1): it equals a fresh build of the source (a sync test, like cp-ci's), it imports nothing
// but Node's built-ins, `ws` and `tar-stream` (hygiene), the build id is its own hash, and the bundle really runs: as a separate process it
// enrolls (token on stdin), connects to a hub, serves a command and leaves on SIGTERM.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CONNECT_AGENT_VERSION } from '@portal/contracts';
import { PILOT_AGENT, PILOT_AGENT_BUILD, PILOT_AGENT_SHA256 } from '../agent.generated.js';
import { buildAgent } from './build.js';
import { openPortal, type Portal } from './testkit/portalRig.js';
import { parseResult, RECORD, RecordParser } from '../tunnel/records.js';

describe('the generated bundle', () => {
  it('equals a fresh build, and its constants are its own hash', () => {
    const fresh = buildAgent();
    assert.equal(PILOT_AGENT, fresh.text, 'run: npm run gen:connect-agent -w @portal/server');
    assert.equal(PILOT_AGENT_SHA256, createHash('sha256').update(PILOT_AGENT, 'utf8').digest('hex'));
    assert.equal(PILOT_AGENT_BUILD, PILOT_AGENT_SHA256.slice(0, 12));
    assert.ok(PILOT_AGENT.startsWith('#!/usr/bin/env node\n'));
  });

  it('imports only Node built-ins, ws’s optional add-ons, and the pty package at run time; bundles only the agent, the tunnel library, the contract’s connect.ts, ws and tar-stream', () => {
    const { metafile } = buildAgent();
    const out = Object.values(metafile.outputs)[0]!;
    const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));
    const unexpected = out.imports.filter((i) => {
      if (i.path.startsWith('node:')) return false;
      if (builtins.has(i.path)) return false;
      if ((i.path === 'bufferutil' || i.path === 'utf-8-validate') && i.kind === 'require-call') return false; // ws's optional add-ons, guarded by try/catch
      if (i.path === '@lydell/node-pty' && i.kind === 'dynamic-import') return false; // loaded at run time from <dir>/node_modules when present
      return true;
    });
    assert.deepEqual(unexpected, [], 'the bundle imports something it must not');
    assert.ok(out.imports.some((i) => i.path === '@lydell/node-pty' && i.kind === 'dynamic-import'), 'the pty package stays a run-time import');

    const allowedSource = [/^src\/connect\/agent\//, /^src\/connect\/tunnel\//, /^src\/connect\/seams\.ts$/, /^src\/workspaces\/(hostexec|runtime)\.ts$/, /^\.\.\/\.\.\/packages\/contracts\/src\/connect\.ts$/];
    const allowedPackages = new Set(['ws', 'tar-stream', 'streamx', 'fast-fifo', 'b4a', 'text-decoder', 'events-universal']);
    const stray: string[] = [];
    for (const input of Object.keys(metafile.inputs)) {
      if (input.includes('node_modules/')) {
        const rest = input.slice(input.lastIndexOf('node_modules/') + 'node_modules/'.length);
        const name = rest.startsWith('@') ? rest.split('/').slice(0, 2).join('/') : rest.split('/')[0]!;
        if (!allowedPackages.has(name)) stray.push(input);
      } else if (!allowedSource.some((re) => re.test(input))) stray.push(input);
    }
    assert.deepEqual(stray, [], 'something outside the allowed set was bundled (a dependency, or a server module the agent must not carry)');
  });
});

describe('the bundle as a program', () => {
  let dir: string;
  let file: string;
  let portal: Portal | undefined;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cx2-bundle-'));
    file = join(dir, 'agent.mjs');
    writeFileSync(file, PILOT_AGENT);
  });
  after(async () => {
    await portal?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[], env: Record<string, string> = {}, input?: string) =>
    spawnSync(process.execPath, [file, ...args], { env: { PATH: process.env.PATH!, HOME: dir, ...env }, input, encoding: 'utf8', timeout: 20_000 });

  /** The same, without blocking this process: the portal under test lives in it and must be able to answer. */
  const runAsync = (args: string[], env: Record<string, string> = {}, input?: string) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn(process.execPath, [file, ...args], { env: { PATH: process.env.PATH!, HOME: dir, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      c.stdout.on('data', (d: Buffer) => (stdout += d));
      c.stderr.on('data', (d: Buffer) => (stderr += d));
      c.on('close', (status) => resolve({ status, stdout, stderr }));
      c.stdin.end(input);
    });

  it('prints its version, with the build it computed from its own file', () => {
    const r = run(['version']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `pilot-agent ${CONNECT_AGENT_VERSION} (build ${PILOT_AGENT_BUILD}, protocol 1)`);
    assert.match(run(['help']).stdout, /enroll \[--token-stdin\]/);
    assert.equal(run(['nonsense']).status, 2);
  });

  it('runs through a symlink, a relative path and a chain of links: the installer starts `current.mjs`, a link to `bundle/<build>/agent.mjs`, and it must not exit silently', () => {
    const var_ = join(dir, 'var');
    mkdirSync(join(var_, 'bundle', PILOT_AGENT_BUILD), { recursive: true });
    writeFileSync(join(var_, 'bundle', PILOT_AGENT_BUILD, 'agent.mjs'), PILOT_AGENT);
    const current = join(var_, 'current.mjs');
    symlinkSync(join('bundle', PILOT_AGENT_BUILD, 'agent.mjs'), current); // relative, like `ln -s bundle/<build>/agent.mjs current.mjs`
    const chained = join(dir, 'chained.mjs');
    symlinkSync(current, chained);
    const expected = `pilot-agent ${CONNECT_AGENT_VERSION} (build ${PILOT_AGENT_BUILD}, protocol 1)`;
    const via = (script: string, args: string[], cwd: string, env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [script, ...args], { cwd, env: { PATH: process.env.PATH!, HOME: dir, ...env }, encoding: 'utf8', timeout: 20_000 });
    for (const [what, script, cwd] of [
      ['an absolute symlink', current, dir],
      ['a relative path to the symlink', './current.mjs', var_],
      ['a relative path going up from another folder', '../current.mjs', join(var_, 'bundle')],
      ['a link to a link', chained, tmpdir()],
      ['the real file', join(var_, 'bundle', PILOT_AGENT_BUILD, 'agent.mjs'), dir],
    ] as const) {
      const r = via(script, ['version'], cwd);
      assert.equal(r.status, 0, `${what}: ${r.stderr}`);
      assert.equal(r.stdout.trim(), expected, `${what} printed nothing or something else`);
    }
    // The commands the installer uses all do their work (or say why not) through the link: none of them is a silent exit 0.
    const help = via(current, ['help'], dir);
    assert.match(help.stdout, /enroll \[--token-stdin\]/);
    const noToken = via(current, ['enroll', '--token-stdin'], dir, { PILOT_MODE: 'host', PILOT_DATA_DIR: join(dir, 'none'), PILOT_URL: 'http://127.0.0.1:1', PILOT_ALLOW_HTTP: '1' });
    assert.equal(noToken.status, 12, 'enroll with no token on stdin says so and exits 12');
    assert.match(noToken.stderr, /No token/);
    const identity = via(current, ['identity'], dir, { PILOT_MODE: 'host', PILOT_DATA_DIR: join(dir, 'none') });
    assert.equal(identity.status, 1);
    assert.match(identity.stderr, /not enrolled/);
    const noMode = via(current, ['run'], dir);
    assert.equal(noMode.status, 10, '`run` without a configuration says so (exit 10) instead of exiting 0');
    assert.match(noMode.stderr, /PILOT_MODE/);
  });

  it('says plainly when it is not enrolled or misconfigured, and never takes a token as an argument', () => {
    const idle = run(['identity'], { PILOT_MODE: 'host', PILOT_DATA_DIR: join(dir, 'none') });
    assert.equal(idle.status, 1);
    assert.match(idle.stderr, /not enrolled/);
    assert.equal(run(['identity'], {}).status, 10, 'no mode: a configuration error (the installer’s exit 10)');
    const argToken = ['cpen_', 'arguments_are_ignored'].join('');
    const noToken = run(['enroll', '--token', argToken], { PILOT_MODE: 'host', PILOT_DATA_DIR: join(dir, 'none'), PILOT_URL: 'http://127.0.0.1:1' });
    assert.equal(noToken.status, 12);
    assert.match(noToken.stderr, /No token/);
    assert.equal(`${noToken.stdout}${noToken.stderr}`.includes(argToken), false);
    const unreachable = run(['enroll', '--token-stdin'], { PILOT_MODE: 'host', PILOT_DATA_DIR: join(dir, 'none'), PILOT_URL: 'http://127.0.0.1:1', PILOT_ALLOW_HTTP: '1' }, `cpen_${'B'.repeat(43)}\n`);
    assert.equal(unreachable.status, 11);
    assert.equal(`${unreachable.stdout}${unreachable.stderr}`.includes('B'.repeat(43)), false, 'the token is not echoed');
  });

  it('enrolls with the token on stdin, connects, serves a command and leaves on SIGTERM (a separate process against the real hub)', async (ctx) => {
    portal = await openPortal();
    const t = portal.target({ id: 'bundle1' });
    const dataDir = join(dir, 'agent');
    const home = join(dir, 'home');
    mkdirSync(home);
    const env = { PILOT_MODE: 'host', PILOT_URL: portal.origin, PILOT_DATA_DIR: dataDir, PILOT_HOME: home, PILOT_ALLOW_HTTP: '1', PILOT_LOG_LEVEL: 'info' };

    const enrolled = await runAsync(['enroll', '--token-stdin'], env, `${t.token}\r\n`);
    assert.equal(enrolled.status, 0, enrolled.stderr);
    assert.match(enrolled.stdout, /Enrolled as nd_[0-9a-f]+ \(target bundle1\)\. Key fingerprint [0-9a-f]{32}\./);
    assert.equal(`${enrolled.stdout}${enrolled.stderr}`.includes(t.token), false);
    const again = await runAsync(['enroll', '--token-stdin'], env, `${t.token}\n`);
    assert.equal(again.status, 0);
    assert.match(again.stderr, /already enrolled/);
    const who = await runAsync(['identity'], env);
    const nodeId = /node (nd_\w+)/.exec(who.stdout)![1]!;
    assert.match(who.stdout, /fingerprint [0-9a-f]{32}/);
    assert.equal(who.stdout.includes('privateKey'), false);

    const child = spawn(process.execPath, [file, 'run'], { env: { PATH: process.env.PATH!, HOME: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const logs: string[] = [];
    child.stdout.on('data', (c: Buffer) => logs.push(c.toString()));
    child.stderr.on('data', (c: Buffer) => logs.push(c.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      const start = Date.now();
      while (!portal.hub.hub.isConnected(nodeId)) {
        if (Date.now() - start > 15_000) throw new Error(`the bundle did not connect; its log:\n${logs.join('')}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(portal.hub.hub.connection(nodeId)!.hello.agentBuild, PILOT_AGENT_BUILD, 'the agent reports the hash of its own file as its build');

      // T-PERF: the idle agent's memory (budget: 100 MB resident), read from the kernel for the running process.
      await new Promise((r) => setTimeout(r, 1500));
      const rssKb = Number(/VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${child.pid}/status`, 'utf8'))?.[1]);
      ctx.diagnostic(`idle resident memory of the bundle: ${(rssKb / 1024).toFixed(1)} MB`);
      assert.ok(rssKb > 0 && rssKb < 100 * 1024, `the idle agent uses ${(rssKb / 1024).toFixed(1)} MB (budget 100)`);

      const stream = await portal.hub.hub.link({ id: nodeId, targetId: 'bundle1' }).open('host', { op: 'exec', argv: ['sh', '-c', 'echo from the bundle; pwd'] });
      const parser = new RecordParser();
      const text: Buffer[] = [];
      let result: unknown = null;
      stream.on('data', (c: Buffer) => {
        for (const r of parser.push(c)) {
          if (r.kind === RECORD.data) text.push(r.payload);
          if (r.kind === RECORD.result) result = parseResult(r.payload);
        }
      });
      stream.on('end', () => stream.end());
      const t0 = Date.now();
      while (!result && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(result, { code: 0 });
      assert.equal(Buffer.concat(text).toString(), `from the bundle\n${home}\n`);

      child.kill('SIGTERM');
      assert.equal(await exited, 0, `a graceful exit; its log:\n${logs.join('')}`);
      const gone = Date.now();
      while (portal.hub.hub.isConnected(nodeId) && Date.now() - gone < 5000) await new Promise((r) => setTimeout(r, 20));
      assert.equal(portal.hub.hub.isConnected(nodeId), false);
      assert.equal(logs.join('').includes(t.token), false, 'the token is nowhere in the bundle’s output');
      assert.equal(readFileSync(join(dataDir, 'identity.json'), 'utf8').includes(t.token), false);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
