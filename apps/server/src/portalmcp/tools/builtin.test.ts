import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_TEMPLATES } from '../../mcp/builtin/fixtures.js';
import { McpSets } from '../../mcp/index.js';
import { References } from '../../pools/references.js';
import { PoolService } from '../../pools/service.js';
import { agentCallable, userTier } from '../registry.js';
import { portalMcpHarness } from '../testkit.js';
import { registerBuiltinTools } from './builtin.js';

// The built-in catalogue's Portal MCP tool (docs/prd/mcp-builtin-catalogue.md FR14): read-only, for admin tokens and for agents,
// text a person typed labelled as data, and nothing an agent sees that it shouldn't.

type Row = Record<string, any>;
const where = (m: { result?: { structuredContent?: any } }) => m.result?.structuredContent as Row;
/** The one-line summary a tool returns is the first line of the text the model reads. */
const line = (m: { result?: { content?: { text: string }[] } }) => (m.result?.content?.map((c) => c.text).join('\n') ?? '').split('\n')[0];

async function world() {
  const h = await portalMcpHarness();
  const pools = new PoolService(h.store, { providers: [] });
  const mcp = new McpSets(h.store, pools, new References(), () => undefined, { resolveDns: false, templates: FIXTURE_TEMPLATES });
  registerBuiltinTools({ mcp, module: h.module } as never, h.registry);
  return { h, mcp };
}

test('mcp_builtin_list: a read tool for admin tokens and agents, listing every template and what was added', async () => {
  const { h, mcp } = await world();
  try {
    const tool = h.registry.get('mcp_builtin_list')!;
    assert.deepEqual([tool.scope, tool.hints?.readOnly, agentCallable(tool), userTier(tool)], ['agent', true, true, 'read']);

    const reader = h.token('read');
    const first = await h.call(reader.secret, 'mcp_builtin_list');
    const empty = where(first);
    assert.equal(line(first), '5 built-in servers, 0 added.');
    assert.deepEqual(empty.templates.map((t: Row) => t.id), ['github', 'gitea', 'gitlab', 'outline', 'cloudflare']);
    const gitea = empty.templates.find((t: Row) => t.id === 'gitea');
    assert.deepEqual(gitea.auth, ['oauth', 'token']);
    assert.deepEqual(gitea.settings.map((s: Row) => [s.key, s.required, s.only_for]), [['baseUrl', true, null], ['mcpUrl', true, null], ['clientId', true, 'oauth']]);
    assert.deepEqual(gitea.servers[0], { key: 'gitea', name: 'Gitea', url: '{mcpUrl}', transport: 'http', on_by_default: true, sign_in: ['oauth', 'token'] });
    assert.deepEqual(empty.templates.find((t: Row) => t.id === 'cloudflare').servers.map((s: Row) => [s.key, s.sign_in]), [['cf-docs', []], ['cf-api', ['oauth', 'token']], ['cf-bindings', ['oauth', 'token']]]);
    assert.deepEqual(gitea.added, []);

    await mcp.builtin.add('gitea', { auth: 'oauth', params: { clientId: 'abc-123' } });
    await mcp.builtin.add('github', { auth: 'token', params: {}, secretNames: { GITHUB_TOKEN: 'team-github' } });

    // An admin's token sees the instance with its settings (labelled as typed by a person) and the secret NAMES.
    const second = await h.call(reader.secret, 'mcp_builtin_list', { id: 'gitea' });
    const admin = where(second);
    assert.equal(line(second), '1 built-in server, 1 added.');
    const added = admin.templates[0].added[0];
    assert.deepEqual([added.name, added.set_name, added.auth, added.servers, added.template_version, added.update_available], [{ untrusted_text: '', source: 'builtin:admin' }, { untrusted_text: 'Gitea', source: 'builtin:admin' }, 'oauth', ['gitea'], 1, false]);
    assert.deepEqual(added.settings.clientId, { untrusted_text: 'abc-123', source: 'builtin:admin' });
    const gh = where(await h.call(reader.secret, 'mcp_builtin_list', { id: 'github' }));
    assert.deepEqual(gh.templates[0].added[0].secret_names, { GITHUB_TOKEN: 'team-github' });

    // An agent learns that it exists and how it signs in, not what the admin typed for it.
    const a = await h.agentToken('docker/api', 's1');
    const agent = where(await h.call(a.secret, 'mcp_builtin_list', { id: 'gitea' }));
    const seen = agent.templates[0].added[0];
    assert.deepEqual([seen.auth, seen.servers, seen.update_available], ['oauth', ['gitea'], false]);
    assert.equal(seen.settings, undefined);
    assert.equal(seen.secret_names, undefined);
    assert.equal(where(await h.call(a.secret, 'mcp_builtin_list', { id: 'nope' })).templates.length, 0);
    assert.match(agent.note, /mcp_propose_entry/);
  } finally {
    h.done();
  }
});

test('mcp_builtin_list is not registered where the MCP service is missing', async () => {
  const h = await portalMcpHarness();
  try {
    registerBuiltinTools({ module: h.module } as never, h.registry);
    assert.equal(h.registry.get('mcp_builtin_list'), undefined);
  } finally {
    h.done();
  }
});
