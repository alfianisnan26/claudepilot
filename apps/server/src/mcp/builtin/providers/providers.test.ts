import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCP_BUILTIN_IDS, MCP_SERVER_KEY_MAX, type McpBuiltinTemplate } from '@portal/contracts';
import { normalizeRemoteUrl } from '../../spec.js';
import { BuiltinRegistry, validateTemplate } from '../registry.js';
import { fill, sampleValues, supports } from '../template.js';
import { PINNED_REDIRECT, resolveOptions } from '../testkit/presets.js';
import { startProvider } from '../testkit/provider.js';
import { OAUTH_CALLBACK_PORT, OAUTH_REDIRECT_URI } from './common.js';
import { BUILTIN_TEMPLATES } from './index.js';

/**
 * The provider definitions (providers PRD §5): what each template says must stay true to what was observed and documented there, and
 * must stay inside the catalogue's own rules. The templates are data, so these tests pin the decisions that are easy to undo by accident.
 */

const byId = (id: string): McpBuiltinTemplate => BUILTIN_TEMPLATES.find((t) => t.id === id)!;

test('the registry accepts every template, one per built-in id, in the shelf order', () => {
  assert.deepEqual(BUILTIN_TEMPLATES.map((t) => t.id), ['github', 'gitlab', 'gitea', 'outline', 'cloudflare']);
  assert.deepEqual([...BUILTIN_TEMPLATES.map((t) => t.id)].sort(), [...MCP_BUILTIN_IDS].sort());
  for (const t of BUILTIN_TEMPLATES) assert.deepEqual(validateTemplate(t), [], t.id);
  assert.equal(new BuiltinRegistry(BUILTIN_TEMPLATES).list().length, 5);
});

test('server keys are unique across templates (catalog entry keys are global) and fit the 16 characters a key may have', () => {
  const keys = BUILTIN_TEMPLATES.flatMap((t) => t.servers.map((s) => s.key));
  assert.equal(new Set(keys).size, keys.length, keys.join(', '));
  for (const key of keys) assert.ok(key.length <= MCP_SERVER_KEY_MAX, key);
  assert.deepEqual(byId('cloudflare').servers.map((s) => s.key), ['cf-api', 'cf-docs', 'cf-bindings', 'cf-observability']);
});

test('every URL is https on a public name, none on an Anthropic-hosted connector host, and each fills from its defaults or samples (FR1, D2)', () => {
  for (const t of BUILTIN_TEMPLATES) {
    for (const mode of t.auth) {
      const values = sampleValues(t, mode);
      for (const s of t.servers.filter((x) => supports(x, mode))) {
        const url = normalizeRemoteUrl(fill(s.url, values));
        assert.match(url, /^https:\/\//, `${t.id}/${s.key}`);
        assert.doesNotMatch(new URL(url).hostname, /(^|\.)(anthropic\.com|claude\.ai|claude\.com)$/, `${t.id}/${s.key}`);
        if (mode === 'oauth' && s.oauth?.authServerMetadataUrl) assert.match(fill(s.oauth.authServerMetadataUrl, values), /^https:\/\//, `${t.id}/${s.key} authServerMetadataUrl: Claude Code accepts only https`);
      }
    }
    for (const url of [t.docUrl, ...t.servers.flatMap((s) => (s.token?.docUrl ? [s.token.docUrl] : []))]) assert.match(url, /^https:\/\//, `${t.id} ${url}`);
  }
});

test('GitHub is token only: no registration, and OAuth would need a client secret the portal never holds (PRD D1)', () => {
  const t = byId('github');
  assert.deepEqual(t.auth, ['token']);
  assert.deepEqual(t.params, []);
  assert.deepEqual(t.servers.map((s) => [s.key, s.url, s.default]), [
    ['github', 'https://api.githubcopilot.com/mcp', true],
    ['github-ro', 'https://api.githubcopilot.com/mcp/readonly', false],
  ]);
  for (const s of t.servers) {
    assert.equal(s.oauth, undefined, s.key);
    assert.deepEqual([s.token?.header, s.token?.slot, s.token?.template], ['Authorization', 'GITHUB_TOKEN', undefined], s.key);
  }
});

test('GitLab: dynamic registration with an optional client ID, GitLab.com by default, the token fallback flagged as unconfirmed', () => {
  const t = byId('gitlab');
  assert.deepEqual(t.auth, ['oauth', 'token']);
  const host = t.params.find((p) => p.key === 'host')!;
  assert.deepEqual([host.kind, host.required, host.default], ['url', true, 'https://gitlab.com']);
  const id = t.params.find((p) => p.key === 'clientId')!;
  assert.deepEqual([id.kind, id.required, id.auth], ['text', false, 'oauth']);
  const s = t.servers[0]!;
  assert.equal(s.url, '{host}/api/v4/mcp');
  assert.equal(s.oauth?.dcr, true);
  assert.equal(s.oauth?.callbackPort, OAUTH_CALLBACK_PORT, 'a client ID registered by hand needs the fixed redirect port');
  assert.equal(s.oauth?.scopes, undefined, 'GitLab names its scope (mcp) in the challenge: the server decides');
  assert.match(s.token!.description!, /Unconfirmed/);
  assert.ok(t.notes.some((n) => n.includes(OAUTH_REDIRECT_URI)));
});

test('Gitea: the owner’s defaults, a required client ID, no dynamic registration, the API scopes pinned, the OIDC document named', () => {
  const t = byId('gitea');
  assert.deepEqual(t.auth, ['oauth', 'token']);
  const param = (key: string) => t.params.find((p) => p.key === key)!;
  assert.equal(param('mcpUrl').default, 'https://gitea-mcp.konfersi.com/mcp');
  assert.equal(param('baseUrl').default, 'https://git.konfersi.com');
  assert.deepEqual([param('baseUrl').auth, param('clientId').auth, param('mcpUrl').auth], ['oauth', 'oauth', undefined], 'token mode asks only for the MCP URL');
  assert.deepEqual([param('clientId').required, param('clientId').default], [true, undefined], 'no default client ID: it belongs to a Gitea app made by hand');
  const s = t.servers[0]!;
  assert.equal(s.url, '{mcpUrl}');
  assert.deepEqual([s.oauth?.dcr, s.oauth?.clientIdParam, s.oauth?.callbackPort], [false, 'clientId', OAUTH_CALLBACK_PORT]);
  assert.equal(s.oauth?.authServerMetadataUrl, '{baseUrl}/.well-known/openid-configuration');
  assert.deepEqual(s.oauth?.scopes, ['write:repository', 'write:issue', 'write:user', 'write:organization', 'write:notification', 'write:package', 'write:misc']);
  assert.deepEqual([s.token?.header, s.token?.slot], ['Authorization', 'GITEA_TOKEN']);
  assert.ok(t.notes.some((n) => n.includes(OAUTH_REDIRECT_URI)));
  assert.ok(t.notes.some((n) => /401/.test(n)), 'the sidecar’s 401 behaviour is recorded');
});

test('Outline: the address is the one param; dynamic registration with the server’s own scopes; an API key is the fallback', () => {
  const t = byId('outline');
  assert.deepEqual(t.auth, ['oauth', 'token']);
  assert.deepEqual(t.params.map((p) => [p.key, p.kind, p.required, p.default]), [['outlineUrl', 'url', true, undefined]]);
  const s = t.servers[0]!;
  assert.equal(s.url, '{outlineUrl}/mcp');
  assert.equal(fill(s.url, { outlineUrl: 'https://docs.example.com' }), 'https://docs.example.com/mcp');
  assert.equal(fill(s.url, { outlineUrl: 'https://docs.example.com/' }), 'https://docs.example.com/mcp');
  assert.deepEqual(s.oauth, { dcr: true });
  assert.deepEqual([s.token?.header, s.token?.slot], ['Authorization', 'OUTLINE_API_KEY']);
});

test('Cloudflare: the API server and the docs on by default, the deprecated ones off; the docs server needs no sign-in', () => {
  const t = byId('cloudflare');
  assert.deepEqual(t.auth, ['oauth', 'token']);
  assert.deepEqual(t.params, []);
  assert.deepEqual(t.servers.map((s) => [s.key, s.url, s.default]), [
    ['cf-api', 'https://mcp.cloudflare.com/mcp', true],
    ['cf-docs', 'https://docs.mcp.cloudflare.com/mcp', true],
    ['cf-bindings', 'https://bindings.mcp.cloudflare.com/mcp', false],
    ['cf-observability', 'https://observability.mcp.cloudflare.com/mcp', false],
  ]);
  const docs = t.servers.find((s) => s.key === 'cf-docs')!;
  assert.deepEqual([docs.oauth, docs.token], [undefined, undefined]);
  for (const mode of ['oauth', 'token'] as const) assert.ok(supports(docs, mode), `the docs server is offered in ${mode} mode`);
  for (const s of t.servers.filter((x) => x.key !== 'cf-docs')) {
    assert.deepEqual(s.oauth, { dcr: true }, s.key);
    assert.equal(s.token?.slot, 'CLOUDFLARE_API_TOKEN', s.key);
  }
});

test('no template carries a client secret, a token, or a slot name that is not an environment-style name', () => {
  const dump = JSON.stringify(BUILTIN_TEMPLATES);
  assert.doesNotMatch(dump, /client_?secret/i);
  assert.doesNotMatch(dump, /gh[pousr]_[A-Za-z0-9]{20,}|glpat-|github_pat_|sk-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{20,}/);
  for (const t of BUILTIN_TEMPLATES)
    for (const s of t.servers) {
      if (s.token) assert.match(s.token.slot, /^[A-Z][A-Z0-9_]*$/, `${t.id}/${s.key}`);
      assert.ok(!s.oauth || !('clientSecret' in s.oauth), `${t.id}/${s.key}`);
    }
});

test('text diet (PLAN rule 12): one short line per summary, a handful of short notes, short hints', () => {
  for (const t of BUILTIN_TEMPLATES) {
    assert.ok(t.summary.length <= 90, `${t.id} summary: ${t.summary.length}`);
    assert.ok(t.notes.length <= 5, `${t.id} notes: ${t.notes.length}`);
    for (const n of t.notes) assert.ok(n.length <= 260, `${t.id} note: ${n.slice(0, 40)}…`);
    for (const p of t.params) {
      assert.ok(p.label.split(/\s+/).length <= 2, `${t.id} ${p.key} label`);
      assert.ok((p.hint ?? '').length <= 200, `${t.id} ${p.key} hint`);
    }
    for (const s of t.servers) assert.ok(s.description.length <= 90, `${t.id}/${s.key} description: ${s.description.length}`);
    assert.match(t.checkedAt, /^2026-\d\d-\d\d$/);
    assert.equal(t.version, 1);
  }
});

test('the stand-in presets mirror the templates they stand in for: scopes, redirect, discovery document and token styles', async () => {
  assert.equal(PINNED_REDIRECT, OAUTH_REDIRECT_URI, 'the stand-in registers the redirect URI the templates tell a person to register');
  const gitea = byId('gitea').servers[0]!;
  const preset = resolveOptions('gitea');
  assert.ok(preset.oauth);
  assert.deepEqual(preset.oauth.resourceScopes, gitea.oauth!.scopes, 'the stand-in resource wants the scopes the template pins');
  assert.equal(preset.oauth.dcr, gitea.oauth!.dcr);
  assert.deepEqual([preset.oauth.rfc8414, preset.oauth.oidc], [false, true], 'Gitea publishes only OIDC discovery, which is why the template names it');
  // The template's authServerMetadataUrl points at a document the stand-in's authorization server really serves.
  const p = await startProvider('gitea');
  try {
    const url = fill(gitea.oauth!.authServerMetadataUrl!, { baseUrl: p.authOrigin! });
    assert.equal((await fetch(url)).status, 200, url);
    // A token slot sends `Authorization: Bearer <value>`, the form gitea-mcp, GitHub, Outline and Cloudflare read.
    assert.equal(gitea.token!.template ?? 'Bearer {value}', 'Bearer {value}');
    const res = await fetch(p.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer standin-pat' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal(res.status, 200);
  } finally {
    await p.close();
  }
  for (const [id, preset_] of [['gitlab', 'gitlab'], ['outline', 'outline'], ['cloudflare', 'cloudflare']] as const) {
    const o = resolveOptions(preset_);
    assert.ok(o.oauth && o.oauth.dcr, `${id}: dynamic registration`);
    assert.equal(byId(id).servers[0]!.oauth?.dcr, true, id);
  }
  const github = resolveOptions('github');
  assert.ok(github.oauth && !github.oauth.dcr, 'GitHub registers no clients');
  assert.deepEqual(byId('github').auth, ['token']);
  assert.ok(github.oauth!.clients.every((c) => c.secret), 'and its client is confidential');
});
