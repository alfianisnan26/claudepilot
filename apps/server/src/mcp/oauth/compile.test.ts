import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpSetContent, McpVersionSpec } from '@portal/contracts';
import type { CatalogVersion } from '../catalog.js';
import { compileMcp, mcpJsonOauth } from '../compile.js';

// PRD mcpset-pool §13.3: Claude Code 2.1.296 takes `.mcp.json` oauth.scopes as ONE space-separated string and drops
// the whole server (silently) when it gets a list. The catalog keeps a list; the compiler joins it.

test('mcpJsonOauth: scopes become one space-separated string; the other fields stay as they are, in order', () => {
  const out = mcpJsonOauth({ clientId: 'abc', callbackPort: 24819, scopes: ['write:repository', 'write:issue'], authServerMetadataUrl: 'https://git.example.com/.well-known/openid-configuration' });
  assert.deepEqual(out, {
    clientId: 'abc',
    callbackPort: 24819,
    scopes: 'write:repository write:issue',
    authServerMetadataUrl: 'https://git.example.com/.well-known/openid-configuration',
  });
  assert.deepEqual(Object.keys(out), ['clientId', 'callbackPort', 'scopes', 'authServerMetadataUrl']);
  assert.deepEqual(mcpJsonOauth({ clientId: 'abc' }), { clientId: 'abc' });
  assert.deepEqual(mcpJsonOauth({ scopes: [] }), {}, 'an empty list is no scope field at all');
});

test('compile: an oauth server is written with string scopes, and a headers server has no oauth block', () => {
  const version = (id: string, spec: McpVersionSpec): CatalogVersion =>
    ({ entry: { id: `e-${id}`, display_name: `Server ${id}`, kind: 'remote' }, row: { id, version: 'v1', review_state: 'approved', revoked_at: null }, spec, slots: [], target: null }) as unknown as CatalogVersion;
  const versions = new Map([
    ['e-a', version('a', { url: 'https://mcp.example.com/mcp', transport: 'http', auth: 'oauth', oauth: { clientId: 'pub-1', callbackPort: 24819, scopes: ['read', 'write'] } })],
    ['e-b', version('b', { url: 'https://other.example.com/mcp', transport: 'http', auth: 'oauth' })],
  ]);
  const content: McpSetContent = {
    slug: 'lab',
    servers: ['a', 'b'].map((k) => ({ key: k, entry: `e-${k}`, version: 'v1', enabled: true, config: {}, secrets: {} })),
  };
  const out = compileMcp({
    sets: [{ pool: { id: 'p1', name: 'Lab', revision: 1 }, content }],
    find: (entry) => versions.get(entry) ?? null,
    names: null,
    claudeVersion: '2.1.296 (Claude Code)',
    running: true,
    now: new Date('2026-10-12T00:00:00Z'),
  });
  const mcpJson = out.fragments.flatMap((f) => f.plugins ?? []).flatMap((p) => p.files).find((f) => f.path === '.mcp.json')!;
  const servers = (JSON.parse(mcpJson.content) as { mcpServers: Record<string, { url: string; oauth?: Record<string, unknown> }> }).mcpServers;
  assert.deepEqual(servers.a!.oauth, { clientId: 'pub-1', callbackPort: 24819, scopes: 'read write' });
  assert.equal(servers.b!.oauth, undefined, 'dynamic registration needs no oauth block');
  assert.deepEqual(out.servers.map((s) => s.state), ['delivered', 'delivered']);
});
