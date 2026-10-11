import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installScript, killScript, parseDetails, splitVerify, verifyScript } from './jobs.js';
import { headersScript, launcherScript } from './scripts.js';

const CANARY = 'canary-not-a-real-secret-7f3a';

/** A fake workspace on disk: marketplace, secret files, home with an outbox, and a server that prints what it got. */
function lab() {
  const root = mkdtempSync(join(tmpdir(), 'cp-mcp-scripts-'));
  const market = join(root, 'market');
  const secrets = join(root, 'secrets');
  const home = join(root, 'home');
  const folder = join(market, 'plugins', 'cpm-t', 'abcdefabcdef');
  for (const d of [join(market, '.claude-plugin'), join(folder, 'servers'), secrets, join(home, '.claudepilot', 'outbox')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'claudepilot', plugins: [{ name: 'cpm-t', source: './plugins/cpm-t/abcdefabcdef' }] }));
  writeFileSync(join(secrets, 'TOK'), `${CANARY}\n`);
  const server = join(root, 'server.js');
  writeFileSync(
    server,
    `#!/usr/bin/env node\nconst e = process.env;\nconsole.log(JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), TOKEN: e.TOKEN, PLAIN: e.PLAIN, KEYFILE: e.KEYFILE, HOME: e.HOME, PATH: e.PATH, server: e.CLAUDEPILOT_MCP_SERVER, target: e.CLAUDEPILOT_MCP_TARGET, npmRegistry: e.npm_config_registry ?? null }));\n`,
  );
  chmodSync(server, 0o755);
  const launcher = join(root, 'mcp-launch');
  const headers = join(root, 'mcp-headers');
  writeFileSync(launcher, launcherScript({ market, secrets, home }));
  writeFileSync(headers, headersScript({ market, secrets, home }));
  const map = (name: string, value: unknown) => writeFileSync(join(folder, 'servers', `${name}.json`), JSON.stringify(value));
  const outbox = () =>
    existsSync(join(home, '.claudepilot', 'outbox', 'mcp.jsonl'))
      ? readFileSync(join(home, '.claudepilot', 'outbox', 'mcp.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 20_000 });
  return { root, market, secrets, home, folder, server, launcher, headers, map, outbox, run, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('launcher: the server gets the secret file’s value, the markers, PATH and HOME, in the fixed folder, and the launcher is gone (§10.2)', () => {
  const l = lab();
  try {
    const target = `cmd:${l.server}`;
    l.map('s', { target, args: ['--flag'], env: { TOKEN: [{ file: 'TOK' }], PLAIN: [{ text: 'plain-value' }], KEYFILE: [{ path: 'TOK' }] } });
    const r = l.run(l.launcher, ['cpm-t/s', '--', target, '--flag'], { npm_config_registry: 'https://evil.example/' });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepEqual(got.argv, ['--flag']);
    assert.equal(got.TOKEN, CANARY, 'one trailing newline trimmed');
    assert.equal(got.PLAIN, 'plain-value');
    assert.equal(got.KEYFILE, join(l.secrets, 'TOK'));
    assert.equal(got.HOME, l.home);
    assert.match(String(got.PATH), /^\/etc\/claudepilot\/bin:/);
    assert.deepEqual([got.server, got.target, got.npmRegistry], ['cpm-t/s', target, null]);
    assert.equal(got.cwd, join(l.home, '.cache', 'claudepilot', 'mcp'));
    assert.ok(existsSync(join(l.home, '.cache', 'claudepilot', 'mcp', 'package.json')));
    assert.equal(r.stderr.includes(CANARY), false);
    assert.deepEqual(
      l.outbox().map((e) => [e.server, e.phase, e.source, e.reason_class]),
      [['cpm-t/s', 'start', 'command', null]],
    );
    assert.equal(JSON.stringify(l.outbox()).includes(CANARY), false);
  } finally {
    l.done();
  }
});

test('launcher: a stale session (another target or arguments) and a missing secret stop with a reason, never a value', () => {
  const l = lab();
  try {
    const target = `cmd:${l.server}`;
    l.map('s', { target, args: [], env: { TOKEN: [{ file: 'TOK' }], OTHER: [{ file: 'NOPE' }] } });
    const stale = l.run(l.launcher, ['cpm-t/s', '--', target, '--extra']);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /server changed or removed; run \/reload-plugins/);
    const gone = l.run(l.launcher, ['cpm-t/missing', '--', target]);
    assert.match(gone.stderr, /server changed or removed/);
    const missing = l.run(l.launcher, ['cpm-t/s', '--', target]);
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr.trim(), 'claudepilot: secret NOPE missing');
    assert.equal(missing.stdout, '', 'nothing on the protocol channel');
    assert.deepEqual(
      l.outbox().map((e) => [e.phase, e.reason_class]),
      [
        ['fail', 'server_changed'],
        ['fail', 'server_changed'],
        ['fail', 'secret_missing'],
      ],
    );
    assert.equal(JSON.stringify(l.outbox()).includes(CANARY), false);
    const usage = l.run(l.launcher, ['cpm-t/s', target]);
    assert.match(usage.stderr, /usage/);
  } finally {
    l.done();
  }
});

test('launcher: a pre-installed npm package runs from the fixed folder by absolute path (§12)', () => {
  const l = lab();
  try {
    const prefix = join(l.home, '.cache', 'claudepilot', 'mcp', 'npm', '@demo', 'srv@1.0.0', 'node_modules');
    mkdirSync(join(prefix, '@demo', 'srv'), { recursive: true });
    mkdirSync(join(prefix, '.bin'), { recursive: true });
    writeFileSync(join(prefix, '@demo', 'srv', 'package.json'), JSON.stringify({ name: '@demo/srv', version: '1.0.0', bin: { 'demo-srv': 'cli.js' } }));
    writeFileSync(join(prefix, '@demo', 'srv', 'cli.js'), readFileSync(l.server, 'utf8'));
    chmodSync(join(prefix, '@demo', 'srv', 'cli.js'), 0o755);
    symlinkSync('../@demo/srv/cli.js', join(prefix, '.bin', 'demo-srv'));
    l.map('s', { target: 'npm:@demo/srv@1.0.0', args: ['x'], env: { TOKEN: [{ file: 'TOK' }] } });
    const r = l.run(l.launcher, ['cpm-t/s', '--', 'npm:@demo/srv@1.0.0', 'x']);
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepEqual([got.argv, got.TOKEN, got.target], [['x'], CANARY, 'npm:@demo/srv@1.0.0']);
    assert.deepEqual(l.outbox().map((e) => [e.phase, e.source]), [['start', 'preinstalled']]);
  } finally {
    l.done();
  }
});

test('headers helper: prints the headers JSON from the secret files; refuses an old URL and a value that isn’t a header', () => {
  const l = lab();
  try {
    l.map('r', { url: 'https://mcp.example.com/mcp', headers: { Authorization: [{ text: 'Bearer ' }, { file: 'TOK' }], 'X-Org': [{ text: 'acme' }] } });
    const r = l.run(l.headers, ['cpm-t/r'], { CLAUDE_CODE_MCP_SERVER_URL: 'https://mcp.example.com/mcp' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { Authorization: `Bearer ${CANARY}`, 'X-Org': 'acme' });
    const old = l.run(l.headers, ['cpm-t/r'], { CLAUDE_CODE_MCP_SERVER_URL: 'https://old.example.com/mcp' });
    assert.equal(old.status, 1);
    assert.equal(old.stdout, '');
    assert.match(old.stderr, /server changed or removed/);
    writeFileSync(join(l.secrets, 'BAD'), 'two\nlines\n');
    l.map('bad', { url: 'https://x.example/', headers: { Authorization: [{ file: 'BAD' }] } });
    const bad = l.run(l.headers, ['cpm-t/bad']);
    assert.equal(bad.status, 1);
    assert.equal(bad.stderr.includes('two'), false);
    assert.deepEqual(l.outbox().map((e) => [e.source, e.reason_class]), [
      ['remote', 'server_changed'],
      ['remote', 'secret_invalid'],
    ]);
  } finally {
    l.done();
  }
});

test('kill script: finds processes by the launcher marker, prints only PIDs, and stops them (FR13b, §10.4)', async () => {
  const target = `cmd:/opt/test-${process.pid}-${Date.now()}`;
  const victim = spawn('sleep', ['30'], { env: { ...process.env, CLAUDEPILOT_MCP_TARGET: target, SECRETISH: CANARY }, stdio: 'ignore' });
  const bystander = spawn('sleep', ['30'], { env: { ...process.env, CLAUDEPILOT_MCP_TARGET: `${target}-other` }, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const exited = new Promise<string | null>((r) => victim.once('exit', (_c, sig) => r(sig)));
    const r = spawnSync('sh', ['-c', killScript(target)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `found: ${victim.pid}`);
    assert.equal(r.stdout.includes(CANARY), false);
    assert.equal(await exited, 'SIGTERM');
    assert.equal(bystander.exitCode, null, 'other targets keep running');
  } finally {
    victim.kill('SIGKILL');
    bystander.kill('SIGKILL');
  }
});

test('verify: plugin details is parsed only on the Claude Code version it was seen on (FR16)', () => {
  const ok = 'cpm-lab 3.0.0+abcd1234\n  Description: Lab\n  Source: cpm-lab@claudepilot\n\nComponent inventory\n  Skills (0)\n  MCP servers (2)  echo, remote  (tool schemas resolved at runtime; not counted)\n';
  const want = { plugin: 'cpm-lab', version: '3.0.0+abcd1234', servers: ['echo', 'remote'] };
  assert.deepEqual(parseDetails(ok, want, '2.1.296 (Claude Code)'), { result: 'ok', servers: ['echo', 'remote'], detail: null });
  assert.equal(parseDetails(ok, want, '2.1.400 (Claude Code)').result, 'not_verified');
  const missing = parseDetails(ok.replace('(2)  echo, remote', '(1)  echo'), want, '2.1.296');
  assert.deepEqual([missing.result, missing.detail], ['mismatch', 'Not listed: remote.']);
  assert.match(parseDetails(ok.replace('3.0.0+abcd1234', '2.0.0+ffff0000'), want, '2.1.296').detail!, /Claude Code reads 2\.0\.0\+ffff0000/);
  const registered = parseDetails(`✘ Could not load details for "cpm-lab": Marketplace 'claudepilot' not found in configuration. Available marketplaces: anthropic-plugin-directory`, want, '2.1.296');
  assert.equal(registered.result, 'not_registered');
  assert.equal(parseDetails('Plugin "cpm-lab@claudepilot" not found. Run `claude plugin list`…', want, '2.1.296').result, 'not_loaded');
  assert.deepEqual(parseDetails('  MCP servers (0)\n', { ...want, servers: [] }, '2.1.296').servers, []);
  const split = splitVerify(`<<<cp-version>>>2.1.296 (Claude Code)\n<<<cp-plugin>>>cpm-a\nA\n<<<cp-exit>>>0\n<<<cp-plugin>>>cpm-b\nB\n<<<cp-exit>>>1\n`);
  assert.deepEqual([split.version, [...split.plugins]], ['2.1.296 (Claude Code)', [['cpm-a', 'A\n'], ['cpm-b', 'B\n']]]);
  assert.match(verifyScript(['cpm-a']), /CLAUDEPILOT_VERIFY=1 timeout 60 claude plugin details 'cpm-a@claudepilot'/);
});

test('install script: pinned version, public registry, no user config, no install scripts unless approved (§12, Q10)', () => {
  const s = installScript('@upstash/context7-mcp', '4.3.0', false);
  assert.match(s, /npm install --prefix "\$p\.tmp" --no-save --ignore-scripts --registry https:\/\/registry\.npmjs\.org\/ --userconfig \/dev\/null/);
  assert.match(s, /'@upstash\/context7-mcp@4\.3\.0'$/m);
  assert.match(s, /mv "\$p\.tmp" "\$p"/);
  assert.doesNotMatch(installScript('x', '1.0.0', true), /--ignore-scripts/);
});
