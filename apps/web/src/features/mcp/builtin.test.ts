import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpBuiltinAdded, McpBuiltinPreviewServer, McpBuiltinTemplate } from '@portal/contracts';
import { buildRequest, defaultServers, fieldErrors, initialForm, mentionsPrivateNetwork, missingParams, oauthRows, paramsFor, serversFor, submitLabel, tokenSlots, withMode } from './builtin.js';

// Shaped like the server's templates (apps/server/src/mcp/builtin/providers): a Gitea-like one with a required OAuth-only
// client ID, and a Cloudflare-like one with servers that offer different modes.
const gitea: McpBuiltinTemplate = {
  id: 'gitea',
  name: 'Gitea',
  icon: 'gitea',
  summary: 's',
  docUrl: 'https://example.com',
  auth: ['oauth', 'token'],
  params: [
    { key: 'mcpUrl', label: 'MCP URL', kind: 'url', required: true, default: 'https://gitea-mcp.example.com/mcp' },
    { key: 'baseUrl', label: 'Gitea URL', kind: 'url', required: true, default: 'https://git.example.com', auth: 'oauth' },
    { key: 'clientId', label: 'Client ID', kind: 'text', required: true, auth: 'oauth' },
  ],
  servers: [
    {
      key: 'gitea',
      name: 'Gitea',
      description: 'd',
      url: '{mcpUrl}',
      transport: 'http',
      oauth: { dcr: false, clientIdParam: 'clientId', callbackPort: 24819 },
      token: { header: 'Authorization', slot: 'GITEA_TOKEN' },
      default: true,
    },
  ],
  notes: [],
  version: 1,
  checkedAt: '2026-10-12',
};

const cloudflare: McpBuiltinTemplate = {
  id: 'cloudflare',
  name: 'Cloudflare',
  icon: 'cloudflare',
  summary: 's',
  docUrl: 'https://example.com',
  auth: ['oauth', 'token'],
  params: [],
  servers: [
    { key: 'cf-api', name: 'API', description: 'd', url: 'https://mcp.example.com/mcp', transport: 'http', oauth: { dcr: true }, token: { header: 'Authorization', slot: 'CF_TOKEN' }, default: true },
    { key: 'cf-docs', name: 'Docs', description: 'd', url: 'https://docs.example.com/mcp', transport: 'http', default: true },
    { key: 'cf-extra', name: 'Extra', description: 'd', url: 'https://extra.example.com/mcp', transport: 'http', oauth: { dcr: true }, default: false },
  ],
  notes: [],
  version: 2,
  checkedAt: '2026-10-12',
};

const instance = (over: Partial<McpBuiltinAdded> = {}): McpBuiltinAdded => ({
  id: 'inst1',
  name: '',
  poolId: 'pool1',
  poolName: 'Gitea',
  entries: ['e1'],
  auth: 'oauth',
  params: { mcpUrl: 'https://m.example.com/mcp', baseUrl: 'https://g.example.com', clientId: 'abc' },
  servers: ['gitea'],
  secretNames: {},
  allowPrivateNetwork: false,
  templateVersion: 1,
  updateAvailable: false,
  addedAt: '2026-10-12T00:00:00Z',
  ...over,
});

test('a server with neither oauth nor token is offered in both modes; one with a single mode only there', () => {
  assert.deepEqual(serversFor(cloudflare, 'oauth').map((s) => s.key), ['cf-api', 'cf-docs', 'cf-extra']);
  assert.deepEqual(serversFor(cloudflare, 'token').map((s) => s.key), ['cf-api', 'cf-docs']);
});

test('defaults are the servers marked default that the mode offers', () => {
  assert.deepEqual(defaultServers(cloudflare, 'oauth'), ['cf-api', 'cf-docs']);
  assert.deepEqual(defaultServers(cloudflare, 'token'), ['cf-api', 'cf-docs']);
});

test('params marked for one mode are not asked in the other', () => {
  assert.deepEqual(paramsFor(gitea, 'oauth').map((p) => p.key), ['mcpUrl', 'baseUrl', 'clientId']);
  assert.deepEqual(paramsFor(gitea, 'token').map((p) => p.key), ['mcpUrl']);
});

test('the form opens on the first mode with the defaults filled in', () => {
  const f = initialForm(gitea, null);
  assert.equal(f.auth, 'oauth');
  assert.deepEqual(f.params, { mcpUrl: 'https://gitea-mcp.example.com/mcp', baseUrl: 'https://git.example.com', clientId: '' });
  assert.deepEqual(f.servers, ['gitea']);
});

test('an instance opens with its own values and its mode', () => {
  const f = initialForm(gitea, instance({ auth: 'token', secretNames: { GITEA_TOKEN: 'MY_GITEA' } }));
  assert.equal(f.auth, 'token');
  assert.equal(f.params.mcpUrl, 'https://m.example.com/mcp');
  assert.deepEqual(f.secretNames, { GITEA_TOKEN: 'MY_GITEA' });
});

test('switching the mode keeps the typed values and resets the servers to that mode defaults', () => {
  const f = withMode(cloudflare, { ...initialForm(cloudflare, null), servers: ['cf-extra'] }, 'token');
  assert.equal(f.auth, 'token');
  assert.deepEqual(f.servers, ['cf-api', 'cf-docs']);
});

test('required params without a value or a default block the preview', () => {
  const f = initialForm(gitea, null);
  assert.deepEqual(missingParams(gitea, f), ['clientId']);
  assert.deepEqual(missingParams(gitea, { ...f, params: { ...f.params, clientId: ' abc ' } }), []);
  assert.deepEqual(missingParams(gitea, withMode(gitea, f, 'token')), []);
});

test('the request leaves out empty and unused values, trims, and names the instance only when editing', () => {
  const f = initialForm(gitea, null);
  const req = buildRequest(gitea, { ...f, params: { ...f.params, clientId: ' abc ', baseUrl: '' }, name: ' second ' }, null);
  assert.deepEqual(req, { auth: 'oauth', params: { mcpUrl: 'https://gitea-mcp.example.com/mcp', clientId: 'abc' }, servers: ['gitea'], name: 'second' });
  const tok = buildRequest(gitea, withMode(gitea, f, 'token'), instance({ auth: 'token' }));
  assert.deepEqual(tok, { auth: 'token', params: { mcpUrl: 'https://gitea-mcp.example.com/mcp' }, servers: ['gitea'], instance: 'inst1' });
});

test('secret names are sent only for the slots in play, and the private-network tick only when set', () => {
  const f = withMode(gitea, initialForm(gitea, null), 'token');
  const req = buildRequest(gitea, { ...f, secretNames: { GITEA_TOKEN: ' MY_GITEA ', OTHER: 'X' }, allowPrivateNetwork: true }, null);
  assert.deepEqual(req.secretNames, { GITEA_TOKEN: 'MY_GITEA' });
  assert.equal(req.allowPrivateNetwork, true);
  assert.equal(buildRequest(gitea, initialForm(gitea, null), null).allowPrivateNetwork, undefined);
});

test('token slots are listed once for the ticked servers', () => {
  const t: McpBuiltinTemplate = { ...cloudflare, servers: cloudflare.servers.map((s) => (s.token ? s : { ...s, token: { header: 'Authorization', slot: 'CF_TOKEN' } })) };
  assert.deepEqual(tokenSlots(t, 'token', ['cf-api', 'cf-docs']), ['CF_TOKEN']);
  assert.deepEqual(tokenSlots(t, 'oauth', ['cf-api']), []);
  assert.deepEqual(tokenSlots(t, 'token', []), []);
});

test('422 details are sorted into the fields they belong to', () => {
  const e = fieldErrors({ 'params.clientId': 'Fill this in.', 'secretNames.GITEA_TOKEN': 'Use letters.', servers: 'Pick at least one server.', name: 'Pick a name.', odd: 'x' });
  assert.deepEqual(e.params, { clientId: 'Fill this in.' });
  assert.deepEqual(e.secretNames, { GITEA_TOKEN: 'Use letters.' });
  assert.equal(e.servers, 'Pick at least one server.');
  assert.equal(e.name, 'Pick a name.');
  assert.deepEqual(e.other, ['x']);
  assert.deepEqual(fieldErrors(undefined), { params: {}, secretNames: {}, other: [] });
});

test('the private-network tick is offered only for the server\'s own private-address refusal', () => {
  assert.equal(mentionsPrivateNetwork('10.0.0.5 is a private address. Turn on “Allow private network” for this server to use it.'), true);
  assert.equal(mentionsPrivateNetwork('Fill this in.'), false);
});

test('the details show what will be pinned', () => {
  const base: McpBuiltinPreviewServer = { key: 'k', name: 'n', url: 'https://x', transport: 'http', auth: 'oauth', headers: [], oauth: null, flags: [] };
  assert.deepEqual(oauthRows(base), [['Client', 'Registers itself']]);
  assert.deepEqual(oauthRows({ ...base, oauth: { clientId: 'abc', callbackPort: 24819, scopes: ['a', 'b'], authServerMetadataUrl: 'https://g/.well-known/openid-configuration' } }), [
    ['Client ID', 'abc'],
    ['Callback port', '24819'],
    ['Scopes', 'a b'],
    ['Metadata', 'https://g/.well-known/openid-configuration'],
  ]);
  assert.deepEqual(oauthRows({ ...base, auth: 'headers', headers: ['Authorization'] }), []);
});

test('the primary button says what Add would do', () => {
  assert.equal(submitLabel('create', false), 'Add');
  assert.equal(submitLabel('unchanged', false), 'Added');
  assert.equal(submitLabel('update', false), 'Update');
  assert.equal(submitLabel('unchanged', true), 'Update');
  assert.equal(submitLabel(null, false), 'Add');
});
