import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { McpBuiltinAddRequest, McpBuiltinAddResult, McpBuiltinItem, McpBuiltinPreview, McpBuiltinTemplate, McpSetContent } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { compile } from '../../delivery/compile.js';
import { FOUNDATION, type FragmentProvider } from '../../delivery/reconciler.js';
import type { WorkspaceStep, WorkspaceSteps } from '../../delivery/steps.js';
import { References, type SecretName } from '../../pools/references.js';
import { PoolService } from '../../pools/service.js';
import { generateSecretKey, parseSecretKey } from '../../store/secretBox.js';
import { Store } from '../../store/store.js';
import { McpSets } from '../index.js';
import { createMcpRoutes } from '../routes.js';
import { FIXTURE_TEMPLATES } from './fixtures.js';
import { McpBuiltin } from './instantiate.js';
import { BuiltinRegistry, validateTemplate } from './registry.js';
import { BUILTIN_TEMPLATES } from './templates.js';
import { entryKeyFor, fill, paramValue, sampleValues, supports } from './template.js';

// Built-in MCP catalogue (docs/prd/mcp-builtin-catalogue.md): the template rules, preview and Add through the catalog's own
// validation, idempotency, updates, the safeguards that stay on, and what an assigned built-in compiles to.

const WS = 'docker/bc-test-a';
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;
const field = (f: string) => (e: unknown) => isAppError(e) && !!(e.details as Record<string, string> | undefined)?.[f];
const fx = (id: McpBuiltinTemplate['id']): McpBuiltinTemplate => structuredClone(FIXTURE_TEMPLATES.find((t) => t.id === id)!);

async function setup(opts: { templates?: readonly McpBuiltinTemplate[]; dns?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'bc-builtin-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const pools = new PoolService(store, { providers });
  const references = new References();
  const names = new Map<string, Map<string, SecretName>>();
  references.provideSecretNames({ namesFor: (ws) => names.get(ws) ?? new Map() });
  const give = (ws: string, ...list: string[]) => names.set(ws, new Map(list.map((n) => [n, { kind: 'secret', file: true, variable: false }])));
  pools.reconciler = { request: () => Promise.resolve() };
  const steps = { enqueue: (_ws: string, _list: WorkspaceStep[]) => undefined, queued: () => [] } as unknown as WorkspaceSteps;
  const mcp = new McpSets(store, pools, references, () => undefined, { resolveDns: opts.dns === true, steps, templates: opts.templates ?? FIXTURE_TEMPLATES });
  const provider = providers.find((p) => p.type === 'mcpset')!;
  const done = () => (store.close(), rmSync(dataDir, { recursive: true, force: true }));
  return { store, pools, mcp, builtin: mcp.builtin, provider, give, done };
}
type H = Awaited<ReturnType<typeof setup>>;

const GITEA_OAUTH: McpBuiltinAddRequest = { auth: 'oauth', params: { clientId: 'abc-123' } };
const GITEA_TOKEN: McpBuiltinAddRequest = { auth: 'token', params: {} };

function deliver(h: H, ws = WS) {
  const now = new Date();
  const fragments = h.provider.fragments(ws, { running: true, now });
  return compile({ portalId: 'p', generation: 1, fragments: [FOUNDATION, ...fragments], claudeVersion: '2.1.296 (Claude Code)', now });
}
const pluginFile = (b: ReturnType<typeof compile>, plugin: string, path: string) => b.plugins.find((p) => p.name === plugin)?.files.find((f) => f.path.endsWith(`/${path}`))?.content;
const mcpJson = (b: ReturnType<typeof compile>, plugin: string) => JSON.parse(pluginFile(b, plugin, '.mcp.json')!) as { mcpServers: Record<string, Record<string, unknown>> };
const content = (h: H, poolId: string) => h.pools.get(poolId).content as McpSetContent;

/* ---------- Template rules ---------- */

test('the fixtures and every real template pass the start-up validation (FR2)', () => {
  assert.doesNotThrow(() => new BuiltinRegistry(FIXTURE_TEMPLATES));
  assert.doesNotThrow(() => new BuiltinRegistry(BUILTIN_TEMPLATES));
  for (const t of [...FIXTURE_TEMPLATES, ...BUILTIN_TEMPLATES]) assert.deepEqual(validateTemplate(t), [], t.id);
});

test('the registry hands out frozen copies and refuses a template listed twice', () => {
  const registry = new BuiltinRegistry(FIXTURE_TEMPLATES);
  assert.equal(registry.get('gitea')?.name, 'Gitea');
  assert.equal(registry.get('nope'), undefined);
  assert.throws(() => ((registry.list()[0] as McpBuiltinTemplate).name = 'Changed'), TypeError);
  assert.throws(() => new BuiltinRegistry([fx('github'), fx('github')]), /listed twice/);
});

test('a template that breaks a rule names the problem (FR2)', () => {
  const bad = (id: McpBuiltinTemplate['id'], change: (t: McpBuiltinTemplate) => void, expected: RegExp) => {
    const t = fx(id);
    change(t);
    const problems = validateTemplate(t);
    assert.ok(problems.some((p) => expected.test(p)), `${expected} not in ${JSON.stringify(problems)}`);
    assert.throws(() => new BuiltinRegistry([t]), expected);
  };
  bad('gitea', (t) => (t.servers[0]!.url = '{nope}/mcp'), /\{nope\} is not a declared param/);
  bad('gitea', (t) => (t.servers[0]!.url = '{mcpUrl'), /brace that is not a \{param\} placeholder/);
  bad('github', (t) => (t.servers[0]!.url = 'http://api.example.com/mcp'), /must be https/);
  bad('github', (t) => (t.servers[0]!.url = 'https://claude.ai/mcp'), /Anthropic-hosted/);
  bad('github', (t) => (t.servers[0]!.key = 'a-very-long-server-key'), /at most 16/);
  bad('github', (t) => (t.servers[0]!.key = 'workspace'), /keeps for itself/);
  bad('cloudflare', (t) => (t.servers[1]!.key = 'cf-docs'), /listed twice/);
  bad('gitea', (t) => (t.servers[0]!.oauth = { dcr: false }), /needs clientIdParam/);
  bad('gitea', (t) => (t.params[2]!.required = false), /must be required/);
  bad('gitea', (t) => delete t.params[2]!.auth, /must have auth "oauth"/);
  bad('gitea', (t) => (t.params[2]!.kind = 'url'), /must be a text param/);
  bad('gitea', (t) => (t.servers[0]!.oauth!.callbackPort = 80), /callbackPort is 1024 to 65535/);
  bad('gitea', (t) => (t.servers[0]!.oauth!.authServerMetadataUrl = 'http://git.example.com/x'), /authServerMetadataUrl must be https/);
  bad('gitea', (t) => (t.params[0]!.default = 'http://git.example.com'), /Use an https URL/);
  bad('gitea', (t) => (t.servers[0]!.token!.slot = 'bad slot'), /Secrets & env name/);
  bad('github', (t) => (t.servers[0]!.token!.template = 'Bearer'), /\{value\}/);
  bad('github', (t) => (t.servers[0]!.token!.header = 'Content-Type'), /sets Content-Type itself/);
  bad('github', (t) => (t.auth = ['oauth', 'token']), /auth lists oauth but no server offers it/);
  bad('github', (t) => (t.auth = ['oauth']), /offers a token but the template's auth does not list token/);
  bad('gitea', (t) => (t.auth = ['oauth']), /offers a token/);
  bad('cloudflare', (t) => t.servers.forEach((s) => (s.default = false)), /no server is on by default/);
  bad('outline', (t) => t.params.push({ key: 'extra', label: 'Extra', kind: 'text', required: false }), /no server uses it/);
  bad('outline', (t) => (t.params[0]!.key = '1bad'), /key is letters and digits/);
  bad('outline', (t) => (t.params[0]!.label = 'A label of far too many words'), /label is one or two words/);
  bad('outline', (t) => (t.params[0]!.default = 'ftp://x.example.com'), /default is not a valid url/);
  bad('github', (t) => (t.version = 0), /version must be an integer/);
  bad('github', (t) => (t.checkedAt = '12 Oct 2026'), /checkedAt must be a date/);
  bad('github', (t) => (t.summary = 'x'.repeat(161)), /one short line/);
  bad('github', (t) => ((t as { icon: string }).icon = 'gitea'), /icon must equal id/);
  bad('github', (t) => ((t as { id: string }).id = 'bitbucket'), /is not one of/);
  bad('github', (t) => (t.docUrl = 'http://example.com'), /docUrl must be an https URL/);
});

test('template helpers: placeholders, param values and keys (FR5, FR10)', () => {
  assert.equal(fill('{baseUrl}/api/v4/mcp', { baseUrl: 'https://gitlab.example.com/' }), 'https://gitlab.example.com/api/v4/mcp');
  assert.equal(fill('{mcpUrl}', { mcpUrl: 'https://m.example.com/mcp/' }), 'https://m.example.com/mcp/');
  const url = { key: 'u', label: 'U', kind: 'url', required: true } as const;
  const text = { key: 't', label: 'T', kind: 'text', required: true } as const;
  assert.equal(paramValue(url, ' https://Git.Example.com/ '), 'https://git.example.com');
  assert.equal(paramValue(url, 'https://example.com/gitlab'), 'https://example.com/gitlab');
  assert.equal(paramValue(url, ''), '');
  for (const evil of [
    'https://example.com/?next=/api',
    'https://example.com/#x',
    'https://user:pw@example.com',
    'javascript:alert(1)',
    'ftp://example.com',
    'https://exa mple.com',
    'https://example.com/{x}',
    'https://example.com/${X}',
    'https://example.com/\nx',
    'https://example.com/"x"',
    'example.com',
    `https://example.com/${'a'.repeat(300)}`,
  ])
    assert.throws(() => paramValue(url, evil), field('params.u'), evil);
  assert.equal(paramValue(text, 'a1b2-c3.d4_e5~f6@g7:h8+i9=j0'), 'a1b2-c3.d4_e5~f6@g7:h8+i9=j0');
  for (const evil of ['a b', 'a/b', '{x}', '"x"', '-leading', 'a'.repeat(201), 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789', 'api_key=' + 'abcdef0123456789abcdef'])
    assert.throws(() => paramValue(text, evil), field('params.t'), evil);
  assert.throws(() => paramValue(text, 5), field('params.t'));

  assert.equal(entryKeyFor('gitea', ''), 'gitea');
  assert.equal(entryKeyFor('gitea', 'prod'), 'gitea-prod');
  const fitted = entryKeyFor('cf-bindings', 'production');
  assert.ok(fitted.length <= 16 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fitted), fitted);
  assert.equal(entryKeyFor('cf-bindings', 'production'), fitted, 'the same inputs give the same key');
  assert.notEqual(entryKeyFor('cf-bindings', 'production-eu'), fitted);

  const cf = fx('cloudflare');
  assert.deepEqual(cf.servers.map((s) => [s.key, supports(s, 'oauth'), supports(s, 'token')]), [['cf-docs', true, true], ['cf-api', true, true], ['cf-bindings', true, true]]);
  const oauthOnly = fx('gitea').servers[0]!;
  delete oauthOnly.token;
  assert.deepEqual([supports(oauthOnly, 'oauth'), supports(oauthOnly, 'token')], [true, false]);
  assert.deepEqual(sampleValues(fx('gitea'), 'token'), { baseUrl: 'https://git.example.com', mcpUrl: 'https://gitea-mcp.example.com/mcp' });
});

/* ---------- List and preview ---------- */

test('list: every template with its instances; nothing is added yet', async () => {
  const h = await setup();
  try {
    const items: McpBuiltinItem[] = h.builtin.list();
    assert.deepEqual(items.map((i) => i.template.id), ['github', 'gitea', 'gitlab', 'outline', 'cloudflare']);
    assert.ok(items.every((i) => i.added.length === 0));
    items[0]!.template.name = 'Changed';
    assert.equal(h.builtin.list()[0]!.template.name, 'GitHub', 'a caller cannot change the registry');
  } finally {
    h.done();
  }
});

test('preview: the exact URL, OAuth fields, headers and flags, and nothing is written (FR4)', async () => {
  const h = await setup();
  try {
    const oauth = await h.builtin.preview('gitea', GITEA_OAUTH);
    assert.deepEqual(oauth, {
      servers: [
        {
          key: 'gitea',
          name: 'Gitea',
          url: 'https://gitea-mcp.example.com/mcp',
          transport: 'http',
          auth: 'oauth',
          headers: [],
          oauth: {
            clientId: 'abc-123',
            callbackPort: 8765,
            scopes: ['write:repository', 'write:issue'],
            authServerMetadataUrl: 'https://git.example.com/.well-known/openid-configuration',
          },
          flags: [],
        },
      ],
      secretNames: [],
      setName: 'Gitea',
      action: 'create',
      instance: null,
    } satisfies McpBuiltinPreview);

    const token = await h.builtin.preview('gitea', { auth: 'token', params: { clientId: 'ignored-in-token-mode' } });
    assert.equal(token.servers[0]!.oauth, null);
    assert.equal(token.servers[0]!.auth, 'headers');
    assert.deepEqual(token.servers[0]!.headers, ['Authorization']);
    assert.deepEqual(token.secretNames, [{ slot: 'GITEA_TOKEN', name: 'GITEA_TOKEN', exists: false }]);

    // Params of this deployment land in the URL, a trailing slash included or not.
    const own = await h.builtin.preview('gitlab', { auth: 'oauth', params: { gitlabUrl: 'https://gitlab.acme.test/' } });
    assert.equal(own.servers[0]!.url, 'https://gitlab.acme.test/api/v4/mcp');
    assert.equal(own.servers[0]!.oauth, null, 'dynamic registration: no client ID needed');
    const named = await h.builtin.preview('gitlab', { auth: 'oauth', params: { gitlabUrl: 'https://gitlab.acme.test', clientId: 'app-1' } });
    assert.deepEqual(named.servers[0]!.oauth, { clientId: 'app-1' });
    const header = await h.builtin.preview('gitlab', { auth: 'token', params: {} });
    assert.deepEqual(header.servers[0]!.headers, ['PRIVATE-TOKEN']);

    assert.equal(h.store.db!.prepare('SELECT count(*) AS n FROM mcp_catalog').get()!.n, 0);
    assert.equal(h.store.db!.prepare('SELECT count(*) AS n FROM mcp_builtin_instances').get()!.n, 0);
    assert.equal(h.pools.list('mcpset').length, 0);
  } finally {
    h.done();
  }
});

test('requests are checked before anything is made: mode, params, servers, names (FR5)', async () => {
  const h = await setup();
  try {
    const bad = (id: string, req: unknown, check: RegExp | ((e: unknown) => boolean)) => assert.rejects(h.builtin.preview(id, req as McpBuiltinAddRequest), check);
    await bad('nope', GITEA_OAUTH, code('NOT_FOUND'));
    await bad('gitea', { params: {} }, field('auth'));
    await bad('gitea', { auth: 'basic', params: {} }, field('auth'));
    await bad('github', { auth: 'oauth', params: {} }, field('auth'));
    await bad('gitea', { auth: 'oauth', params: {} }, field('params.clientId'));
    await bad('gitea', { auth: 'oauth', params: { clientId: 'x', nope: 'y' } }, field('params.nope'));
    await bad('gitea', { auth: 'oauth', params: 'x' }, field('params'));
    await bad('gitea', { auth: 'oauth', params: { clientId: 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789' } }, /looks like a secret/);
    await bad('gitea', { auth: 'oauth', params: { clientId: 'a b' } }, field('params.clientId'));
    await bad('gitea', { auth: 'oauth', params: { clientId: 'x', baseUrl: 'https://user:pw@git.example.com' } }, field('params.baseUrl'));
    await bad('gitea', { auth: 'oauth', params: { clientId: 'x', mcpUrl: 'https://m.example.com/mcp?x=1' } }, field('params.mcpUrl'));
    await bad('gitea', { ...GITEA_OAUTH, servers: ['other'] }, field('servers'));
    await bad('gitea', { ...GITEA_OAUTH, servers: [] }, field('servers'));
    await bad('gitea', { ...GITEA_OAUTH, servers: 'gitea' }, field('servers'));
    await bad('gitea', { ...GITEA_OAUTH, name: 'Bad Name' }, field('name'));
    await bad('gitea', { ...GITEA_OAUTH, name: 'a-name-way-too-long' }, field('name'));
    await bad('gitea', { ...GITEA_OAUTH, instance: 'nope' }, code('NOT_FOUND'));
    await bad('gitea', { ...GITEA_TOKEN, secretNames: { OTHER: 'X' } }, field('secretNames.OTHER'));
    await bad('gitea', { ...GITEA_TOKEN, secretNames: { GITEA_TOKEN: '../etc/passwd' } }, field('secretNames.GITEA_TOKEN'));
    await bad('gitea', { ...GITEA_TOKEN, secretNames: 'x' }, field('secretNames'));
    // OAuth's metadata URL must be https: Claude Code drops the whole server otherwise, so it is refused here, against the param behind it.
    await bad('gitea', { auth: 'oauth', params: { clientId: 'x', baseUrl: 'http://git.example.com' } }, (e) => field('params.baseUrl')(e) && /Gitea must be https for OAuth/.test((e as Error).message));
    await assert.doesNotReject(h.builtin.preview('gitea', { auth: 'token', params: { baseUrl: 'http://git.example.com' } }), 'a token needs no metadata URL');
    // A URL that the catalog refuses is reported against the param that made it.
    await bad('gitea', { auth: 'oauth', params: { clientId: 'x', mcpUrl: 'https://claude.ai/mcp' } }, field('params.mcpUrl'));
    await bad('outline', { auth: 'token', params: { outlineUrl: 'https://169.254.169.254' } }, field('params.outlineUrl'));
  } finally {
    h.done();
  }
});

test('the SSRF guard stays on: a private host needs the explicit tick, which the entry then records (FR6)', async () => {
  const h = await setup({ dns: true });
  try {
    const params = { outlineUrl: 'https://10.0.0.5' };
    await assert.rejects(h.builtin.preview('outline', { auth: 'token', params }), field('params.outlineUrl'));
    await assert.rejects(h.builtin.add('outline', { auth: 'token', params }), field('params.outlineUrl'));
    assert.equal(h.store.db!.prepare('SELECT count(*) AS n FROM mcp_catalog').get()!.n, 0);
    const preview = await h.builtin.preview('outline', { auth: 'token', params, allowPrivateNetwork: true });
    assert.deepEqual(preview.servers[0]!.flags.map((f) => f.code), ['private_network']);
    const added = await h.builtin.add('outline', { auth: 'token', params: { outlineUrl: 'http://10.0.0.5:3000' }, allowPrivateNetwork: true });
    assert.equal(added.allowPrivateNetwork, true);
    const entry = h.mcp.catalog.get(added.entries[0]!);
    assert.equal(entry.versions[0]!.spec.url, 'http://10.0.0.5:3000/mcp');
    assert.equal(entry.versions[0]!.spec.allowPrivateNetwork, true);
    assert.deepEqual(entry.versions[0]!.flags.map((f) => f.code).sort(), ['plain_http', 'private_network']);
    // The same inputs without the tick are another request: refused, not found as the instance.
    await assert.rejects(h.builtin.add('outline', { auth: 'token', params: { outlineUrl: 'http://10.0.0.5:3000' } }), field('params.outlineUrl'));
  } finally {
    h.done();
  }
});

/* ---------- Add ---------- */

test('Add makes approved catalog entries and a set, in OAuth mode (FR7)', async () => {
  const h = await setup();
  try {
    const added = await h.builtin.add('gitea', GITEA_OAUTH);
    assert.equal(added.result, 'created');
    assert.deepEqual(
      { ...added, id: '', poolId: '', entries: [], addedAt: '' },
      {
        id: '',
        name: '',
        poolId: '',
        poolName: 'Gitea',
        entries: [],
        auth: 'oauth',
        params: { baseUrl: 'https://git.example.com', mcpUrl: 'https://gitea-mcp.example.com/mcp', clientId: 'abc-123' },
        servers: ['gitea'],
        secretNames: {},
        allowPrivateNetwork: false,
        templateVersion: 1,
        updateAvailable: false,
        addedAt: '',
        result: 'created',
      },
    );
    const entry = h.mcp.catalog.get(added.entries[0]!);
    assert.deepEqual([entry.key, entry.displayName, entry.kind, entry.description, entry.versions.length], ['gitea', 'Gitea', 'remote', 'Gitea’s MCP server.', 1]);
    const v = entry.versions[0]!;
    assert.deepEqual([v.version, v.reviewState, v.reviewedBy, v.reviewNote], ['v1', 'approved', 'Admin', 'Built-in catalogue v1']);
    assert.equal(v.spec.auth, 'oauth');
    assert.deepEqual(v.spec.oauth, { clientId: 'abc-123', callbackPort: 8765, scopes: ['write:repository', 'write:issue'], authServerMetadataUrl: 'https://git.example.com/.well-known/openid-configuration' });
    assert.deepEqual(v.slots, []);

    const pool = h.pools.get(added.poolId);
    assert.deepEqual([pool.type, pool.name, pool.description, pool.status, pool.revision], ['mcpset', 'Gitea', 'Repositories and issues on a Gitea.', 'deliverable', 1]);
    assert.deepEqual(pool.content, { slug: 'gitea', servers: [{ key: 'gitea', entry: entry.id, version: 'v1', enabled: true, config: {}, secrets: {} }] });
    const listed = h.builtin.list().find((i) => i.template.id === 'gitea')!;
    assert.deepEqual(listed.added.map((a) => a.id), [added.id]);
    const events = h.store.db!.prepare("SELECT type, details FROM mcp_events WHERE type LIKE 'builtin_%'").all() as { type: string; details: string }[];
    assert.deepEqual(events.map((e) => e.type), ['builtin_added']);
    assert.match(events[0]!.details, /"template":"gitea"/);
  } finally {
    h.done();
  }
});

test('Add in Token mode references a Secrets & env name and never takes a value (FR7, D4)', async () => {
  const h = await setup();
  try {
    const added = await h.builtin.add('gitea', { ...GITEA_TOKEN, secretNames: { GITEA_TOKEN: 'team-gitea.token' } });
    assert.deepEqual(added.secretNames, { GITEA_TOKEN: 'team-gitea.token' });
    assert.deepEqual(added.params, { baseUrl: 'https://git.example.com', mcpUrl: 'https://gitea-mcp.example.com/mcp' }, 'the client ID is OAuth-only: not asked, not stored');
    const entry = h.mcp.catalog.get(added.entries[0]!);
    const v = entry.versions[0]!;
    assert.equal(v.spec.auth, 'headers');
    assert.equal(v.slots.length, 1);
    assert.deepEqual([v.slots[0]!.name, v.slots[0]!.target, v.slots[0]!.secret, v.slots[0]!.required, v.slots[0]!.template], ['Authorization', 'header', true, true, 'Bearer {value}']);
    assert.deepEqual(content(h, added.poolId).servers[0]!.secrets, { Authorization: '{{secret-file:team-gitea.token}}' });
    // No value anywhere in what was stored.
    const stored = JSON.stringify([h.store.db!.prepare('SELECT * FROM mcp_builtin_instances').all(), h.store.db!.prepare('SELECT * FROM pool_revisions').all()]);
    assert.ok(!/ghp_|Bearer [A-Za-z0-9]{8,}/.test(stored));
  } finally {
    h.done();
  }
});

test('"exists" says whether a Secrets & env secret of that name holds a value (D4)', async () => {
  const h = await setup();
  try {
    // Without Secrets & env registered nothing exists.
    assert.deepEqual((await h.builtin.preview('github', { auth: 'token', params: {} })).secretNames, [{ slot: 'GITHUB_TOKEN', name: 'GITHUB_TOKEN', exists: false }]);
    // A minimal secrets kind, as the real one shows its entries: names and metadata, never values.
    const entries = [
      { id: '1', kind: 'secret', name: 'GITHUB_TOKEN', secret: { version: 1, stored: true } },
      { id: '2', kind: 'secret', name: 'GITEA_TOKEN', secret: null },
      { id: '3', kind: 'secret', name: 'OUTLINE_API_KEY', secret: { version: 1, stored: true, revokedAt: '2026-10-01T00:00:00Z' } },
      { id: '4', kind: 'variable', name: 'CLOUDFLARE_API_TOKEN', value: 'x' },
    ];
    h.pools.register({ type: 'secrets', parse: (i) => i, view: (c) => c, fragments: () => [] });
    h.pools.create('secrets', { name: 'Team', content: { entries } });
    const exists = async (id: string, params: Record<string, string> = {}) => (await h.builtin.preview(id, { auth: 'token', params })).secretNames.map((s) => s.exists);
    assert.deepEqual(await exists('github'), [true]);
    assert.deepEqual(await exists('gitea'), [false], 'it needs a value');
    assert.deepEqual(await exists('outline', { outlineUrl: 'https://docs.example.com' }), [false], 'revoked');
    assert.deepEqual(await exists('cloudflare'), [false], 'a variable is not a secret file');
  } finally {
    h.done();
  }
});

test('Add is idempotent: the same inputs find the instance and make nothing (FR8)', async () => {
  const h = await setup();
  try {
    const first = await h.builtin.add('gitea', GITEA_OAUTH);
    const preview = await h.builtin.preview('gitea', GITEA_OAUTH);
    assert.deepEqual([preview.action, preview.instance, preview.setName], ['unchanged', first.id, 'Gitea']);
    const again = await h.builtin.add('gitea', GITEA_OAUTH);
    assert.equal(again.result, 'unchanged');
    assert.deepEqual({ ...again, result: 'created' }, first);
    // Defaults spelled out are the same inputs as defaults left out.
    const spelled = await h.builtin.add('gitea', { ...GITEA_OAUTH, params: { ...GITEA_OAUTH.params, baseUrl: 'https://GIT.example.com/', mcpUrl: 'https://gitea-mcp.example.com/mcp' }, servers: ['gitea'] });
    assert.equal(spelled.result, 'unchanged');
    // At once, too.
    const [a, b] = await Promise.all([h.builtin.add('github', { auth: 'token', params: {} }), h.builtin.add('github', { auth: 'token', params: {} })]);
    assert.deepEqual([a.result, b.result, a.id === b.id], ['created', 'unchanged', true]);
    assert.equal(h.mcp.catalog.list().length, 2);
    assert.ok(h.mcp.catalog.list().every((e) => e.versions.length === 1));
    assert.equal(h.pools.list('mcpset').length, 2);
    assert.equal(h.store.db!.prepare("SELECT count(*) AS n FROM mcp_events WHERE type LIKE 'builtin_%'").get()!.n, 2);
  } finally {
    h.done();
  }
});

test('a further instance with other inputs is labelled 2, 3, …, or by the name given (FR10)', async () => {
  const h = await setup();
  try {
    const one = await h.builtin.add('gitea', GITEA_OAUTH);
    const two = await h.builtin.add('gitea', { auth: 'oauth', params: { clientId: 'other-app', baseUrl: 'https://git.other.test' } });
    const three = await h.builtin.add('gitea', GITEA_TOKEN);
    const prod = await h.builtin.add('gitea', { ...GITEA_OAUTH, params: { clientId: 'prod-app' }, name: 'prod' });
    assert.deepEqual([one, two, three, prod].map((a) => [a.name, a.poolName, a.result]), [['', 'Gitea', 'created'], ['2', 'Gitea 2', 'created'], ['3', 'Gitea 3', 'created'], ['prod', 'Gitea prod', 'created']]);
    assert.deepEqual([one, two, three, prod].map((a) => h.mcp.catalog.get(a.entries[0]!).key), ['gitea', 'gitea-2', 'gitea-3', 'gitea-prod']);
    assert.deepEqual([one, two, three, prod].map((a) => content(h, a.poolId).slug), ['gitea', 'gitea-2', 'gitea-3', 'gitea-prod']);
    assert.equal(new Set([one, two, three, prod].map((a) => a.entries[0])).size, 4);
    // Asking for a name that exists changes that instance (its inputs differ): it is not a second one.
    const renamedInputs = await h.builtin.add('gitea', { ...GITEA_OAUTH, params: { clientId: 'prod-app-2' }, name: 'prod' });
    assert.deepEqual([renamedInputs.result, renamedInputs.id === prod.id, renamedInputs.params.clientId], ['updated', true, 'prod-app-2']);
  } finally {
    h.done();
  }
});

test('a name taken by something that is not a built-in is dodged or refused; set names and IDs stay unique (FR10)', async () => {
  const h = await setup();
  try {
    const manual = await h.mcp.catalog.create({ key: 'github', displayName: 'My GitHub', kind: 'remote', spec: { url: 'https://github-mirror.example.com/mcp' } });
    h.mcp.catalog.approve(manual.id, manual.versions[0]!.id, { reviewed: true, note: 'by hand' });
    h.pools.create('mcpset', { name: 'github', content: { slug: 'github', servers: [] } });
    const added = await h.builtin.add('github', { auth: 'token', params: {} });
    assert.equal(added.name, '2', 'the key github is a manual entry: not touched, not reused');
    assert.equal(h.mcp.catalog.get(added.entries[0]!).key, 'github-2');
    assert.equal(h.mcp.catalog.get(manual.id).versions.length, 1);
    assert.equal(added.poolName, 'GitHub 2');
    const slugs = h.pools.list('mcpset').map((p) => (p.content as McpSetContent).slug);
    assert.deepEqual([...slugs].sort(), ['github', 'github-2']);
    // An explicit name that lands on a manual key is a conflict that says what to do.
    const other = await h.mcp.catalog.create({ key: 'github-x', displayName: 'Other', kind: 'remote', spec: { url: 'https://other.example.com/mcp' } });
    h.mcp.catalog.approve(other.id, other.versions[0]!.id, { reviewed: true });
    await assert.rejects(h.builtin.add('github', { auth: 'token', params: {}, name: 'x' }), (e) => code('CONFLICT')(e) && /Pick another name/.test((e as Error).message));
    // A set with the template's name is dodged with a number.
    h.pools.create('mcpset', { name: 'Outline', content: { slug: 'outline', servers: [] } });
    const outline = await h.builtin.add('outline', { auth: 'token', params: { outlineUrl: 'https://docs.example.com' } });
    assert.deepEqual([outline.poolName, content(h, outline.poolId).slug], ['Outline (2)', 'outline-2']);
  } finally {
    h.done();
  }
});

test('a manual entry holding any real server key is never touched: Add goes around it, a named instance is refused (FR10)', async () => {
  const real = BUILTIN_TEMPLATES.length ? BUILTIN_TEMPLATES : FIXTURE_TEMPLATES;
  let checked = 0;
  for (const t of real) {
    for (const server of t.servers) {
      const mode = t.auth.find((m) => supports(server, m))!;
      const params = sampleValues(t, mode);
      for (const p of t.params) if ((!p.auth || p.auth === mode) && p.required && !(p.key in params)) params[p.key] = 'sample-value';
      const h = await setup({ templates: real });
      try {
        // The admin has an entry of their own under the key the template would use.
        const manual = await h.mcp.catalog.create({ key: server.key, displayName: 'By hand', kind: 'remote', spec: { url: 'https://manual.example.com/mcp' } });
        h.mcp.catalog.approve(manual.id, manual.versions[0]!.id, { reviewed: true, note: 'by hand' });
        const added = await h.builtin.add(t.id, { auth: mode, params, servers: [server.key] });
        const where = `${t.id}/${server.key}`;
        assert.equal(added.name, '2', where);
        const entry = h.mcp.catalog.get(added.entries[0]!);
        assert.equal(entry.key, entryKeyFor(server.key, '2'), where);
        assert.ok(entry.key.length <= 16 && entry.key !== server.key, where);
        const was = h.mcp.catalog.get(manual.id);
        assert.deepEqual([was.versions.length, was.versions[0]!.spec.url, was.versions[0]!.reviewNote, was.sets.length], [1, 'https://manual.example.com/mcp', 'by hand', 0], `${where}: untouched`);

        // A named instance whose key is another manual entry's is refused, and says what to do.
        const other = await h.mcp.catalog.create({ key: entryKeyFor(server.key, 'ops'), displayName: 'Also by hand', kind: 'remote', spec: { url: 'https://other.example.com/mcp' } });
        h.mcp.catalog.approve(other.id, other.versions[0]!.id, { reviewed: true });
        await assert.rejects(h.builtin.add(t.id, { auth: mode, params, servers: [server.key], name: 'ops' }), (e) => code('CONFLICT')(e) && /Pick another name/.test((e as Error).message), where);
        assert.equal(h.mcp.catalog.get(other.id).versions.length, 1, `${where}: untouched`);
        checked++;
      } finally {
        h.done();
      }
    }
  }
  assert.ok(checked >= 5, 'every server of every template was tried');
});

test('multi-server templates: defaults, ticking servers, and servers that need no sign-in (FR3, FR7)', async () => {
  const h = await setup();
  try {
    const oauth = await h.builtin.preview('cloudflare', { auth: 'oauth', params: {} });
    assert.deepEqual(oauth.servers.map((s) => s.key), ['cf-docs', 'cf-api']);
    assert.deepEqual(oauth.servers.map((s) => s.oauth), [null, null], 'dynamic registration: nothing to pin');
    assert.deepEqual(oauth.servers.map((s) => s.auth), ['none', 'oauth'], 'the docs server needs no sign-in; the API one signs in with OAuth');
    const token = await h.builtin.preview('cloudflare', { auth: 'token', params: {} });
    assert.deepEqual(token.servers.map((s) => s.headers), [[], ['Authorization']], 'the docs server needs no token');
    assert.deepEqual(token.secretNames, [{ slot: 'CLOUDFLARE_API_TOKEN', name: 'CLOUDFLARE_API_TOKEN', exists: false }], 'one token for the servers that share a slot');
    const all = await h.builtin.add('cloudflare', { auth: 'token', params: {}, servers: ['cf-docs', 'cf-api', 'cf-bindings', 'cf-api'] });
    assert.deepEqual(all.servers, ['cf-docs', 'cf-api', 'cf-bindings']);
    assert.deepEqual(content(h, all.poolId).servers.map((s) => [s.key, s.secrets]), [
      ['cf-docs', {}],
      ['cf-api', { Authorization: '{{secret-file:CLOUDFLARE_API_TOKEN}}' }],
      ['cf-bindings', { Authorization: '{{secret-file:CLOUDFLARE_API_TOKEN}}' }],
    ]);
    assert.deepEqual(h.mcp.catalog.get(all.entries[0]!).versions[0]!.spec.auth, 'none');
    assert.equal(content(h, all.poolId).slug, 'cloudflare');
    // Ticking fewer, on the same instance, takes servers out of the set; the entries stay in the catalog.
    const fewer = await h.builtin.add('cloudflare', { auth: 'token', params: {}, servers: ['cf-docs'], instance: all.id });
    assert.deepEqual([fewer.result, fewer.servers], ['updated', ['cf-docs']]);
    assert.deepEqual(content(h, all.poolId).servers.map((s) => s.key), ['cf-docs']);
    assert.equal(h.mcp.catalog.list().length, 3);
  } finally {
    h.done();
  }
});

test('a mode a server does not offer leaves it out of that mode', async () => {
  const tokenOnly = fx('cloudflare');
  delete tokenOnly.servers[1]!.oauth;
  const oauthOnly = fx('cloudflare');
  delete oauthOnly.servers[2]!.token;
  const mixed: McpBuiltinTemplate = { ...tokenOnly, servers: [tokenOnly.servers[0]!, tokenOnly.servers[1]!, oauthOnly.servers[2]!] };
  const h = await setup({ templates: [mixed] });
  try {
    assert.deepEqual((await h.builtin.preview('cloudflare', { auth: 'oauth', params: {}, servers: ['cf-docs', 'cf-bindings'] })).servers.map((s) => s.key), ['cf-docs', 'cf-bindings']);
    assert.deepEqual((await h.builtin.preview('cloudflare', { auth: 'oauth', params: {} })).servers.map((s) => s.key), ['cf-docs']);
    await assert.rejects(h.builtin.preview('cloudflare', { auth: 'oauth', params: {}, servers: ['cf-api'] }), /isn’t offered with OAuth/);
    assert.deepEqual((await h.builtin.preview('cloudflare', { auth: 'token', params: {}, servers: ['cf-docs', 'cf-api'] })).servers.map((s) => s.key), ['cf-docs', 'cf-api']);
    await assert.rejects(h.builtin.preview('cloudflare', { auth: 'token', params: {}, servers: ['cf-bindings'] }), /isn’t offered with a token/);
  } finally {
    h.done();
  }
});

/* ---------- Updates ---------- */

test('a newer template offers an update that makes new approved versions and a new set revision (FR11)', async () => {
  const h = await setup();
  try {
    const added = await h.builtin.add('gitea', GITEA_OAUTH);
    const ws = 'docker/bc-test-update';
    h.pools.setAssignments(ws, 'mcpset', [{ poolId: added.poolId }]);

    // The same template, one version later, with a changed callback port and a new scope.
    const next = fx('gitea');
    next.version = 2;
    next.servers[0]!.oauth!.callbackPort = 8766;
    next.servers[0]!.oauth!.scopes = ['write:repository', 'write:issue', 'read:user'];
    const v2 = new McpBuiltin({ store: h.store, catalog: h.mcp.catalog, pools: h.pools, registry: new BuiltinRegistry([next]) });

    const item = v2.list().find((i) => i.template.id === 'gitea')!;
    assert.deepEqual(item.added.map((a) => [a.templateVersion, a.updateAvailable]), [[1, true]]);
    const preview = await v2.preview('gitea', GITEA_OAUTH);
    assert.deepEqual([preview.action, preview.instance, preview.servers[0]!.oauth?.callbackPort], ['update', added.id, 8766]);

    const updated = await v2.add('gitea', GITEA_OAUTH);
    assert.deepEqual([updated.result, updated.id, updated.poolId, updated.templateVersion, updated.updateAvailable], ['updated', added.id, added.poolId, 2, false]);
    const entry = h.mcp.catalog.get(added.entries[0]!);
    assert.deepEqual(entry.versions.map((v) => [v.version, v.reviewState, v.reviewNote]), [['v2', 'approved', 'Built-in catalogue v2'], ['v1', 'approved', 'Built-in catalogue v1']]);
    assert.equal(entry.versions[0]!.spec.oauth!.callbackPort, 8766);
    assert.equal(entry.versions[1]!.spec.oauth!.callbackPort, 8765, 'an approved version never changes');
    const pool = h.pools.get(added.poolId);
    assert.equal(pool.revision, 2);
    assert.equal(content(h, added.poolId).servers[0]!.version, 'v2');
    assert.equal(content(h, added.poolId).slug, 'gitea');
    const compiled = mcpJson(deliver(h, ws), 'cpm-gitea').mcpServers.gitea!.oauth as { callbackPort: number };
    assert.equal(compiled.callbackPort, 8766, 'the workspace gets the new version');
    assert.deepEqual((await v2.add('gitea', GITEA_OAUTH)).result, 'unchanged');
    assert.equal(h.store.db!.prepare("SELECT count(*) AS n FROM mcp_events WHERE type = 'builtin_updated'").get()!.n, 1);

    // A bump that changes nothing the catalog holds still clears the offer, and makes no new version.
    const quiet = fx('gitea');
    quiet.version = 3;
    quiet.servers[0]!.oauth!.callbackPort = 8766;
    quiet.servers[0]!.oauth!.scopes = ['write:repository', 'write:issue', 'read:user'];
    const v3 = new McpBuiltin({ store: h.store, catalog: h.mcp.catalog, pools: h.pools, registry: new BuiltinRegistry([quiet]) });
    assert.equal((await v3.add('gitea', GITEA_OAUTH)).templateVersion, 3);
    assert.equal(h.mcp.catalog.get(added.entries[0]!).versions.length, 2);
    assert.equal(h.pools.get(added.poolId).revision, 2);
  } finally {
    h.done();
  }
});

test('changing an instance in place keeps what the admin did to the set (FR11)', async () => {
  const h = await setup();
  try {
    const added = await h.builtin.add('cloudflare', { auth: 'oauth', params: {} });
    const manual = await h.mcp.catalog.create({ key: 'lab', displayName: 'Lab', kind: 'remote', spec: { url: 'https://lab.example.com/mcp' } });
    h.mcp.catalog.approve(manual.id, manual.versions[0]!.id, { reviewed: true });
    const was = content(h, added.poolId);
    h.pools.update(added.poolId, {
      content: {
        ...was,
        servers: [...was.servers.map((s) => (s.key === 'cf-api' ? { ...s, enabled: false } : s)), { key: 'lab', entry: manual.id, version: 'v1', enabled: true, config: {}, secrets: {} }],
      },
    });
    const changed = await h.builtin.add('cloudflare', { auth: 'oauth', params: {}, servers: ['cf-docs', 'cf-api', 'cf-bindings'], instance: added.id });
    assert.equal(changed.result, 'updated');
    const servers = content(h, added.poolId).servers;
    assert.deepEqual(servers.map((s) => s.key), ['cf-docs', 'cf-api', 'cf-bindings', 'lab']);
    assert.equal(servers.find((s) => s.key === 'cf-api')!.enabled, false, 'switched off by the admin: stays off');
    assert.equal(servers.find((s) => s.key === 'lab')!.version, 'v1', 'not the instance’s: untouched');

    // A different client ID is a new version of the same entry, not a second entry.
    const gitea = await h.builtin.add('gitea', GITEA_OAUTH);
    const moved = await h.builtin.add('gitea', { auth: 'oauth', params: { clientId: 'new-app' }, instance: gitea.id });
    assert.deepEqual([moved.result, moved.id, moved.params.clientId], ['updated', gitea.id, 'new-app']);
    assert.deepEqual(h.mcp.catalog.get(gitea.entries[0]!).versions.map((v) => [v.version, v.spec.oauth?.clientId]), [['v2', 'new-app'], ['v1', 'abc-123']]);
    // Without saying which servers, changing an instance keeps the ones it has, and a mode switch changes how they sign in.
    const cf = await h.builtin.add('cloudflare', { auth: 'oauth', params: {}, servers: ['cf-docs', 'cf-api'], name: 'two' });
    const swapped = await h.builtin.add('cloudflare', { auth: 'token', params: {}, instance: cf.id });
    assert.deepEqual([swapped.result, swapped.auth, swapped.servers], ['updated', 'token', ['cf-docs', 'cf-api']]);
    assert.deepEqual(content(h, cf.poolId).servers.map((s) => [s.key, s.secrets]), [['cf-docs', {}], ['cf-api', { Authorization: '{{secret-file:CLOUDFLARE_API_TOKEN}}' }]]);
    assert.deepEqual(h.mcp.catalog.get(cf.entries[1]!).versions.map((v) => [v.version, v.spec.auth]), [['v2', 'headers'], ['v1', 'oauth']]);
    assert.equal(h.mcp.catalog.get(cf.entries[0]!).versions.length, 1, 'the docs server is the same in both modes: no new version');
    // And back: the definition of v1 exists and is approved, so it is reused.
    const back = await h.builtin.add('gitea', { ...GITEA_OAUTH, instance: gitea.id });
    assert.equal(back.result, 'updated');
    assert.equal(h.mcp.catalog.get(gitea.entries[0]!).versions.length, 2);
    assert.equal(content(h, gitea.poolId).servers[0]!.version, 'v1');
  } finally {
    h.done();
  }
});

test('a revoked or deprecated definition is never brought back by Add (FR9)', async () => {
  const h = await setup();
  try {
    const a = await h.builtin.add('gitea', GITEA_OAUTH);
    const entry = h.mcp.catalog.get(a.entries[0]!);
    const ws = 'docker/bc-test-revoke';
    h.pools.setAssignments(ws, 'mcpset', [{ poolId: a.poolId }]);
    assert.equal(h.mcp.kind.compileFor(ws).servers[0]!.state, 'delivered');

    h.mcp.revoke(entry.id, entry.versions[0]!.id, 'leaked client');
    assert.equal(h.mcp.kind.compileFor(ws).servers[0]!.state, 'revoked', 'a revoked built-in entry stops delivering');
    // The same inputs again are not a quiet no-op and not a new version: the preview and Add both say why.
    const revoked = (e: unknown) => code('CONFLICT')(e) && /Gitea v1 was revoked in the catalog, so Add won’t bring it back/.test((e as Error).message);
    await assert.rejects(h.builtin.preview('gitea', GITEA_OAUTH), revoked);
    await assert.rejects(h.builtin.add('gitea', GITEA_OAUTH), revoked);
    assert.equal(h.mcp.catalog.get(entry.id).versions.length, 1);
    assert.equal(h.mcp.kind.compileFor(ws).servers[0]!.state, 'revoked');

    // A newer template that changes the definition is a different definition: its approved version takes the revoked one's place.
    const next = fx('gitea');
    next.version = 2;
    next.servers[0]!.oauth!.callbackPort = 8766;
    const v2 = new McpBuiltin({ store: h.store, catalog: h.mcp.catalog, pools: h.pools, registry: new BuiltinRegistry([next]) });
    assert.equal((await v2.add('gitea', GITEA_OAUTH)).result, 'updated');
    assert.equal(h.mcp.kind.compileFor(ws).servers[0]!.state, 'delivered');

    // The entries outlive their set: after it is deleted, the same decision stands.
    const b = await h.builtin.add('github', { auth: 'token', params: {} });
    const gh = h.mcp.catalog.get(b.entries[0]!);
    h.mcp.catalog.deprecate(gh.id, gh.versions[0]!.id);
    h.pools.delete(b.poolId);
    await assert.rejects(h.builtin.add('github', { auth: 'token', params: {} }), (e) => code('CONFLICT')(e) && /GitHub v1 was deprecated/.test((e as Error).message));
    assert.equal(h.mcp.catalog.get(gh.id).versions.length, 1, 'nothing was made');
    assert.equal(h.builtin.list().find((i) => i.template.id === 'github')!.added.length, 0);
    assert.equal(h.pools.list('mcpset').length, 1);
  } finally {
    h.done();
  }
});

test('a set deleted in the Pools hub takes its instance; adding again reuses the entries (FR8)', async () => {
  const h = await setup();
  try {
    const first = await h.builtin.add('outline', { auth: 'token', params: { outlineUrl: 'https://docs.example.com' } });
    h.pools.delete(first.poolId);
    assert.equal(h.store.db!.prepare('SELECT count(*) AS n FROM mcp_builtin_instances').get()!.n, 0);
    const second = await h.builtin.add('outline', { auth: 'token', params: { outlineUrl: 'https://docs.example.com' } });
    assert.deepEqual([second.result, second.name, second.entries, second.poolName], ['created', '', first.entries, 'Outline']);
    assert.notEqual(second.poolId, first.poolId);
    assert.equal(h.mcp.catalog.get(first.entries[0]!).versions.length, 1, 'the approved version is reused, not duplicated');
    assert.equal(h.mcp.catalog.list().length, 1);
  } finally {
    h.done();
  }
});

test('a draft waiting in the catalog with the definition Add wants is the reviewer’s: Add refuses and leaves it', async () => {
  const h = await setup();
  try {
    const a = await h.builtin.add('outline', { auth: 'token', params: { outlineUrl: 'https://docs.example.com' } });
    const entry = h.mcp.catalog.get(a.entries[0]!);
    // Someone proposes another URL by hand: a draft.
    await h.mcp.catalog.addVersion(entry.id, { spec: { url: 'https://docs.other.example.com/mcp', auth: 'headers' }, slots: entry.versions[0]!.slots });
    // Changing the instance to exactly that URL would approve the draft behind the reviewer's back.
    const request = { auth: 'token', params: { outlineUrl: 'https://docs.other.example.com' }, instance: a.id } as const;
    await assert.rejects(h.builtin.add('outline', request), (e) => code('CONFLICT')(e) && /waiting for review in the catalog/.test((e as Error).message));
    assert.deepEqual(h.mcp.catalog.get(entry.id).versions.map((v) => v.reviewState), ['draft', 'approved']);
    assert.equal(content(h, a.poolId).servers[0]!.version, 'v1');
  } finally {
    h.done();
  }
});

/* ---------- What an assigned built-in compiles to ---------- */

test('an OAuth built-in compiles to a remote server with its OAuth fields, and a token built-in to a headers helper (FR7, mcpset §10.2)', async () => {
  const h = await setup();
  try {
    const oauth = await h.builtin.add('gitea', GITEA_OAUTH);
    const token = await h.builtin.add('github', { auth: 'token', params: {} });
    h.pools.setAssignments(WS, 'mcpset', [{ poolId: oauth.poolId }, { poolId: token.poolId }]);

    // The token's name isn't in this workspace's Secrets & env yet: said so, not delivered.
    let outcome = h.mcp.kind.compileFor(WS).servers;
    assert.deepEqual(outcome.map((s) => [s.key, s.state]).sort(), [['gitea', 'delivered'], ['github', 'missing_secret']]);
    assert.match(outcome.find((s) => s.key === 'github')!.reason!, /needs GITHUB_TOKEN/);

    h.give(WS, 'GITHUB_TOKEN');
    outcome = h.mcp.kind.compileFor(WS).servers;
    assert.deepEqual(outcome.map((s) => s.state), ['delivered', 'delivered']);
    const bundle = deliver(h);
    const gitea = mcpJson(bundle, 'cpm-gitea').mcpServers.gitea!;
    assert.equal(gitea.type, 'http');
    assert.equal(gitea.url, 'https://gitea-mcp.example.com/mcp');
    assert.equal(gitea.headersHelper, undefined, 'OAuth: no header, Claude Code signs in itself');
    const o = gitea.oauth as { clientId: string; callbackPort: number; scopes: string[] | string; authServerMetadataUrl: string };
    assert.deepEqual([o.clientId, o.callbackPort, o.authServerMetadataUrl], ['abc-123', 8765, 'https://git.example.com/.well-known/openid-configuration']);
    assert.deepEqual(Array.isArray(o.scopes) ? o.scopes : o.scopes.split(' '), ['write:repository', 'write:issue']);

    const github = mcpJson(bundle, 'cpm-github').mcpServers.github!;
    assert.deepEqual([github.type, github.url, github.headersHelper], ['http', 'https://api.githubcopilot.com/mcp/', '/etc/claudepilot/bin/mcp-headers cpm-github/github']);
    assert.equal(github.oauth, undefined);
    assert.deepEqual(JSON.parse(pluginFile(bundle, 'cpm-github', 'servers/github.json')!), {
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: [{ text: 'Bearer ' }, { file: 'GITHUB_TOKEN' }] },
    });
    // The allowlist matchers (FR19) see both URLs, as for any remote server.
    assert.deepEqual(h.mcp.matchers(WS), [{ serverUrl: 'https://api.githubcopilot.com/mcp/' }, { serverUrl: 'https://gitea-mcp.example.com/mcp' }]);
    // No value (there is none) and no secret name outside the map.
    assert.ok(!JSON.stringify(bundle.plugins.flatMap((p) => p.files)).includes('ghp_'));
  } finally {
    h.done();
  }
});

test('every real template instantiates in each of its modes with sample params, through the catalog (FR2, FR7)', async () => {
  const h = await setup({ templates: BUILTIN_TEMPLATES.length ? BUILTIN_TEMPLATES : FIXTURE_TEMPLATES });
  try {
    for (const item of h.builtin.list()) {
      const t = item.template;
      for (const mode of t.auth) {
        const params = sampleValues(t, mode);
        for (const p of t.params) if ((!p.auth || p.auth === mode) && p.required && !(p.key in params)) params[p.key] = 'sample-value';
        const preview = await h.builtin.preview(t.id, { auth: mode, params, name: `${mode}`.slice(0, 5) });
        assert.ok(preview.servers.length > 0, `${t.id} ${mode}`);
        for (const s of preview.servers) {
          assert.match(s.url, /^https:\/\//, `${t.id} ${s.key}`);
          assert.equal(s.headers.length > 0, mode === 'token' && !!t.servers.find((x) => x.key === s.key)!.token, `${t.id} ${s.key} headers`);
          assert.equal(!!s.oauth, mode === 'oauth' && !!t.servers.find((x) => x.key === s.key)!.oauth && s.oauth !== null, `${t.id} ${s.key} oauth`);
        }
        const added = await h.builtin.add(t.id, { auth: mode, params, name: `${mode}`.slice(0, 5) });
        assert.equal(added.result, 'created');
        for (const id of added.entries) {
          const e = h.mcp.catalog.get(id);
          assert.equal(e.versions[0]!.reviewState, 'approved', `${t.id} ${e.key}`);
          assert.equal(e.versions[0]!.reviewNote, `Built-in catalogue v${t.version}`);
        }
        const ws = `docker/bc-${t.id}-${mode}`;
        h.pools.setAssignments(ws, 'mcpset', [{ poolId: added.poolId }]);
        const compiled = h.mcp.kind.compileFor(ws);
        assert.ok(compiled.servers.every((s) => s.state === 'delivered' || s.state === 'missing_secret'), `${t.id} ${mode}: ${JSON.stringify(compiled.servers.map((s) => [s.key, s.state, s.reason]))}`);
        assert.equal((await h.builtin.add(t.id, { auth: mode, params, name: `${mode}`.slice(0, 5) })).result, 'unchanged');
      }
    }
  } finally {
    h.done();
  }
});

/* ---------- Routes ---------- */

test('routes: list, preview, add (201 then 200), and errors in the portal\'s shape', async () => {
  const h = await setup();
  try {
    const app = new Hono();
    app.onError((e, c) => {
      const error = isAppError(e) ? e : null;
      return error ? c.json(error.toJSON(), error.status as ContentfulStatusCode) : c.json({ error: { code: 'INTERNAL_ERROR' } }, 500);
    });
    app.route('/api/mcp', createMcpRoutes(h.mcp));
    const post = (path: string, body: unknown) => app.request(`/api/mcp/builtin${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

    const list = await app.request('/api/mcp/builtin');
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as { data: McpBuiltinItem[] }).data.length, 5);

    const preview = await post('/gitea/preview', GITEA_OAUTH);
    assert.equal(preview.status, 200);
    assert.equal(((await preview.json()) as { data: McpBuiltinPreview }).data.action, 'create');

    const created = await post('/gitea/add', GITEA_OAUTH);
    assert.equal(created.status, 201);
    const data = ((await created.json()) as { data: McpBuiltinAddResult }).data;
    assert.deepEqual([data.result, data.poolName], ['created', 'Gitea']);
    const again = await post('/gitea/add', GITEA_OAUTH);
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { data: McpBuiltinAddResult }).data.result, 'unchanged');

    const missing = await post('/gitea/add', { auth: 'oauth', params: {} });
    assert.equal(missing.status, 422);
    assert.equal(((await missing.json()) as { error: { code: string; details: Record<string, string> } }).error.details['params.clientId'], 'Fill this in.');
    assert.equal((await post('/nope/add', GITEA_OAUTH)).status, 404);
    assert.equal((await post('/gitea/add', '{not json')).status, 400);
    assert.equal((await post('/gitea/add', '[1]')).status, 422, 'an array is an empty request: it says what is missing');
  } finally {
    h.done();
  }
});
