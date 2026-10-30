// `settings_get` over the real Portal MCP endpoint (T-968 S2a, general-manager PRD §9.1): a read token sees the settings with where each
// value came from and which need a confirmation; a caller without `view` on the platform's settings area gets exactly what a missing key
// gets (NOT_FOUND, same bytes) and the handler never runs; an agent's token never reaches it; a credential-shaped value reads `[set]`.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { objectRef, SETTING_MISSING, SETTING_SECRET_SET, type UserId } from '@portal/contracts';
import { clearResolvers, registerResolver } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { declareSettingsPolicies, SETTINGS_TOOL_POLICIES } from './authz.js';
import { registerSettingsTools } from './portalTools.js';
import { defineSetting } from './registry.js';
import { Settings } from './store.js';

const FLAG = 't968.guard';
const TEXT = 't968.note';
defineSetting({ key: FLAG, type: 'boolean', default: true, protective: true, scope: 'global', group: 't968', order: 1, label: 'Guard', confirmText: 'Turns the guard off.' });
defineSetting({ key: TEXT, type: 'string', default: '', scope: 'global', group: 't968', order: 2, label: 'Note', max: 200 });
/** A credential-shaped value, built at run time (no token-shaped literal in the repository). */
const fakeToken = () => ['cp', 'at_', 'Q7x'.repeat(10)].join('');
// A setting whose DEFAULT is credential-shaped (mutant A10: the default was never masked by any test).
const KEYED = 't968.keyed';
const DEFAULT_SECRET = fakeToken();
defineSetting({ key: KEYED, type: 'string', default: DEFAULT_SECRET, scope: 'global', group: 't968x', order: 1, label: 'Keyed', max: 200 });
declareSettingsPolicies();

after(() => clearResolvers());

async function build() {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const settings = new Settings(h.store);
  let reached = 0;
  registerSettingsTools({ view: () => (reached++, settings.view()) }, registry);
  return { h, settings, reached: () => reached };
}

test('a read token lists the settings: value, default, changed or not, by whom, and which need a confirmation', async () => {
  const { h, settings } = await build();
  try {
    settings.set(TEXT, 'hello', { actor: 'Admin' });
    const read = h.token('read').secret;
    const all = await h.call(read, 'settings_get', { group: 't968' });
    assert.equal(all.result?.isError, undefined, JSON.stringify(all.raw));
    const rows = all.result!.structuredContent.settings as { key: string }[];
    assert.deepEqual(rows.map((r) => r.key), [FLAG, TEXT]);
    assert.deepEqual(all.result!.structuredContent.settings[0], { key: FLAG, group: 't968', label: 'Guard', type: 'boolean', value: true, default: true, source: 'default', needs_confirmation: true, updated_at: null, updated_by: null });
    const one = await h.call(read, 'settings_get', { key: TEXT });
    assert.equal(one.result!.structuredContent.setting.value, 'hello');
    assert.equal(one.result!.structuredContent.setting.source, 'changed');
    assert.equal(one.result!.structuredContent.setting.updated_by, 'Admin');
    assert.equal(one.result!.structuredContent.setting.needs_confirmation, false);
  } finally {
    h.done();
  }
});

test('denied: without view on the settings area the answer is the missing key\'s, byte for byte, and the handler never runs; an agent never reaches it', async () => {
  const { h, reached } = await build();
  try {
    const read = h.token('read').secret;
    const missing = await h.call(read, 'settings_get', { key: 't968.nosuch' });
    assert.equal(missing.result?.structuredContent.error.code, 'NOT_FOUND');
    const before = reached();
    // The platform's settings area now belongs to another user: the token's owner holds nothing on it.
    registerResolver({ type: 'platform', resolve: (id) => ({ ref: objectRef('platform', id), owner: { kind: 'user', id: 'u_b' as UserId } }) });
    try {
      const denied = await h.call(read, 'settings_get', { key: 't968.nosuch' });
      assert.deepEqual(denied.result, missing.result, 'a denial reads exactly like a missing key');
      const deniedAll = await h.call(read, 'settings_get', {});
      assert.deepEqual(deniedAll.result, missing.result, 'and so does the list');
      assert.equal(reached(), before, 'the handler never saw a refused call');
    } finally {
      clearResolvers();
    }
    const agent = await h.agentToken('docker/api-dev', 's_a');
    const fromAgent = await h.call(agent.secret, 'settings_get', {});
    assert.ok(fromAgent.result?.isError === true || !!fromAgent.error, 'an agent token is refused');
    assert.equal(reached(), before, 'nor did the agent\'s');
  } finally {
    h.done();
  }
});

test('redaction: a credential-shaped value reads [set], in the list and alone, and never leaves the portal', async () => {
  const { h, settings } = await build();
  try {
    const secret = fakeToken();
    settings.set(TEXT, `key ${secret}`, { actor: 'Admin' });
    const read = h.token('read').secret;
    const one = await h.call(read, 'settings_get', { key: TEXT });
    assert.equal(one.result!.structuredContent.setting.value, SETTING_SECRET_SET);
    assert.doesNotMatch(one.result!.structuredContent.summary, /\[redacted\]|Q7x/);
    const all = await h.call(read, 'settings_get', {});
    assert.equal((all.result!.structuredContent.settings as { key: string; value: unknown }[]).find((r) => r.key === TEXT)?.value, SETTING_SECRET_SET);
    for (const r of [one, all]) assert.ok(!JSON.stringify(r.raw).includes(secret), 'the value is in no part of the answer');
  } finally {
    h.done();
  }
});

test('redaction: a credential-shaped DEFAULT reads [set], as the value and as the default, alone and in the list', async () => {
  const { h } = await build();
  try {
    const read = h.token('read').secret;
    const one = await h.call(read, 'settings_get', { key: KEYED });
    assert.equal(one.result?.isError, undefined, JSON.stringify(one.raw));
    assert.equal(one.result!.structuredContent.setting.default, SETTING_SECRET_SET);
    assert.equal(one.result!.structuredContent.setting.value, SETTING_SECRET_SET);
    const all = await h.call(read, 'settings_get', { group: 't968x' });
    assert.equal(all.result!.structuredContent.settings[0].default, SETTING_SECRET_SET);
    for (const r of [one, all]) assert.ok(!JSON.stringify(r.raw).includes(DEFAULT_SECRET), 'the default is in no part of the answer');
  } finally {
    h.done();
  }
});

test('an empty value reads [missing], never an empty string (set or missing only)', async () => {
  const { h, settings } = await build();
  try {
    const read = h.token('read').secret;
    const one = await h.call(read, 'settings_get', { key: TEXT });
    assert.equal(one.result!.structuredContent.setting.value, SETTING_MISSING);
    assert.equal(one.result!.structuredContent.setting.default, SETTING_MISSING);
    settings.set(TEXT, 'hello', { actor: 'Admin' });
    const set = await h.call(read, 'settings_get', { key: TEXT });
    assert.equal(set.result!.structuredContent.setting.value, 'hello');
    assert.equal(set.result!.structuredContent.setting.default, SETTING_MISSING);
  } finally {
    h.done();
  }
});

test('redaction at depth (QA #11080 gap 1): a credential inside an array or an object value, or as an object key, never leaves; too deep reads [set]', async () => {
  // SettingValue is a scalar today, so this row is injected through the view: the mask must hold when a setting type grows a list or a map.
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const settings = new Settings(h.store);
  const secret = fakeToken();
  const keySecret = fakeToken().replace('Q7x', 'K9w');
  let deep: unknown = `deep ${secret}`;
  for (let i = 0; i < 12; i++) deep = [deep];
  const value = { hosts: ['a.example', `b ${secret}`, ''], nested: { plain: 'ok', token: secret, list: [{ inner: secret }] }, [keySecret]: 'x', deep };
  const row = { key: 't968.nested', group: 't968n', label: 'Nested', help: null, confirmText: null, type: 'string', value, default: [secret], updatedAt: null, updatedBy: null };
  const view = () => {
    const v = settings.view();
    return { ...v, settings: [...v.settings, row as unknown as (typeof v.settings)[number]] };
  };
  registerSettingsTools({ view }, registry);
  try {
    const read = h.token('read').secret;
    const one = await h.call(read, 'settings_get', { key: 't968.nested' });
    assert.equal(one.result?.isError, undefined, JSON.stringify(one.raw));
    const got = one.result!.structuredContent.setting;
    assert.deepEqual(got.value.hosts, ['a.example', SETTING_SECRET_SET, SETTING_MISSING], 'inside an array');
    assert.deepEqual(got.value.nested, { plain: 'ok', token: SETTING_SECRET_SET, list: [{ inner: SETTING_SECRET_SET }] }, 'inside an object, and an object in an array');
    assert.equal(got.value[SETTING_SECRET_SET], 'x', 'a credential-shaped key is replaced');
    assert.deepEqual(got.default, [SETTING_SECRET_SET], 'the default too');
    let d: unknown = got.value.deep;
    while (Array.isArray(d)) d = d[0];
    assert.equal(d, SETTING_SECRET_SET, 'past the depth bound it reads [set], never the string');
    const all = await h.call(read, 'settings_get', { group: 't968n' });
    for (const r of [one, all]) {
      const text = JSON.stringify(r.raw);
      assert.ok(!text.includes(secret) && !text.includes(keySecret), 'the credential is in no part of the answer');
    }
  } finally {
    h.done();
  }
});

test('declared through the seam: view on the platform\'s settings area', () => {
  assert.deepEqual(SETTINGS_TOOL_POLICIES, { settings_get: { kind: 'platform', area: 'settings', verb: 'view' } });
});
