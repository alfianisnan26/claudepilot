import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { compile } from './compile.js';
import { parsePending, serializePending } from './pending.js';
import { CLAUDE_AGES_JS, parseClaudeAges, settleTombstones, TOMBSTONE_SLACK_MS } from './tombstones.js';
import type { Fragment, Tombstone } from './types.js';

const now = new Date('2026-10-10T12:00:00Z');
const base = { portalId: 'p1', generation: 1, claudeVersion: '2.1.296 (Claude Code)', now };
const ENV = '/etc/claude-code/managed-settings.d/20-claudepilot-env.json';
const secrets = (env: Record<string, string>, extra: Partial<Fragment> = {}): Fragment => ({
  owner: 'secrets',
  pool: { id: 's1', revision: 1 },
  settings: { env },
  envTombstones: { safeValues: { GH_CONFIG_DIR: '/home/node/.config/gh' }, except: ['KEEP_OUT'] },
  ...extra,
});
const dropIn = (bundle: ReturnType<typeof compile>, path = ENV) => JSON.parse(bundle.files.find((f) => f.path === path)?.content ?? 'null') as { env?: Record<string, string> } | null;

test('a fragment that asks for tombstones has its env names recorded with their safe values', () => {
  const bundle = compile({ ...base, fragments: [secrets({ GH_CONFIG_DIR: '/etc/claudepilot/secrets/gh', LINEAR_API_KEY: 'lin', KEEP_OUT: '1' })] });
  assert.deepEqual(bundle.manifest.env, { secrets: { GH_CONFIG_DIR: '/home/node/.config/gh', LINEAR_API_KEY: '' } }, 'default safe value "", except-listed names untracked');
  assert.deepEqual(bundle.tombstones, []);
  assert.throws(() => compile({ ...base, fragments: [secrets({ A: 'x' }, { envTombstones: { safeValues: { A: 1 as unknown as string } } })] }), /safe value of env A must be a string/);
});

test('a removed name stays in its owner’s drop-in with its safe value while the workspace runs, and not once stopped', () => {
  const first = compile({ ...base, fragments: [secrets({ GH_CONFIG_DIR: '/etc/claudepilot/secrets/gh', LINEAR_API_KEY: 'lin', KEEP_OUT: '1' })] });
  const next = compile({ ...base, fragments: [secrets({ LINEAR_API_KEY: 'lin2' })], previous: { env: first.manifest.env }, running: true });
  assert.deepEqual(dropIn(next)?.env, { LINEAR_API_KEY: 'lin2', GH_CONFIG_DIR: '/home/node/.config/gh' });
  assert.deepEqual(next.tombstones, [{ owner: 'secrets', name: 'GH_CONFIG_DIR', value: '/home/node/.config/gh', since: now.getTime() }]);
  assert.deepEqual(next.manifest.env, { secrets: { LINEAR_API_KEY: '' } }, 'tombstones live in pending_deletes, not in the record of what is delivered');
  assert.notEqual(next.hash, compile({ ...base, fragments: [secrets({ LINEAR_API_KEY: 'lin2' })] }).hash, 'tombstones are delivered content');

  const stopped = compile({ ...base, fragments: [secrets({ LINEAR_API_KEY: 'lin2' })], previous: { env: first.manifest.env }, running: false });
  assert.deepEqual(dropIn(stopped)?.env, { LINEAR_API_KEY: 'lin2' });
  assert.deepEqual(stopped.tombstones, []);
});

test('a whole set going away leaves a drop-in of tombstones only; a carried tombstone keeps its time', () => {
  const carried: Tombstone[] = [{ owner: 'secrets', name: 'LINEAR_API_KEY', value: '', since: 123 }];
  const bundle = compile({ ...base, fragments: [], previous: { env: { secrets: { LINEAR_API_KEY: '', GH_CONFIG_DIR: '/home/node/.config/gh' } } }, tombstones: carried, running: true });
  assert.deepEqual(dropIn(bundle), { env: { GH_CONFIG_DIR: '/home/node/.config/gh', LINEAR_API_KEY: '' } });
  assert.deepEqual(
    bundle.tombstones.map((t) => [t.name, t.since]),
    [
      ['LINEAR_API_KEY', 123],
      ['GH_CONFIG_DIR', now.getTime()],
    ],
  );
  assert.equal(bundle.manifest.env, undefined);
  // Once settled away, the drop-in goes with them.
  const after = compile({ ...base, fragments: [], tombstones: [], running: true });
  assert.equal(dropIn(after), null);
});

test('a tombstone yields to a live value and is dropped when its owner may no longer set the name', () => {
  const carried: Tombstone[] = [
    { owner: 'secrets', name: 'LINEAR_API_KEY', value: '', since: 1 },
    { owner: 'secrets', name: 'MCP_TIMEOUT', value: '', since: 1 }, // MCP sets declare it
    { owner: 'secrets', name: 'bad name', value: '', since: 1 },
    { owner: 'nobody' as Tombstone['owner'], name: 'X', value: '', since: 1 },
    { owner: 'browser', name: 'CLAUDEPILOT_BROWSER_URL', value: '', since: 1 },
  ];
  const bundle = compile({ ...base, fragments: [secrets({ LINEAR_API_KEY: 'back' })], tombstones: carried, running: true });
  assert.deepEqual(dropIn(bundle)?.env, { LINEAR_API_KEY: 'back' }, 're-added: the live value wins');
  assert.deepEqual(bundle.tombstones.map((t) => t.name), ['CLAUDEPILOT_BROWSER_URL']);
  assert.deepEqual(dropIn(bundle, '/etc/claude-code/managed-settings.d/70-claudepilot-browser.json'), { env: { CLAUDEPILOT_BROWSER_URL: '' } });
});

test('settling: none while stopped; while running, kept until no claude process older than it runs', () => {
  const t = (name: string, ageMs: number): Tombstone => ({ owner: 'secrets', name, value: '', since: now.getTime() - ageMs });
  const all = [t('OLD', 600_000), t('NEW', 5_000)];
  const at = { now: now.getTime() };
  assert.deepEqual(settleTombstones(all, { ...at, running: false, claudeAges: [9999] }), []);
  assert.deepEqual(settleTombstones(all, { ...at, running: true, claudeAges: null }), all, 'unknown: keep them all');
  assert.deepEqual(settleTombstones(all, { ...at, running: true, claudeAges: [] }), [], 'no claude process: nothing can hold an old value');
  assert.deepEqual(settleTombstones(all, { ...at, running: true, claudeAges: [700, 2] }).map((x) => x.name), ['OLD', 'NEW'], 'a session older than both');
  assert.deepEqual(settleTombstones(all, { ...at, running: true, claudeAges: [60, 2] }).map((x) => x.name), ['NEW'], 'only NEW is older than that session');
  assert.deepEqual(settleTombstones(all, { ...at, running: true, claudeAges: [1] }), [], 'sessions started after both');
  // A process that started just before the tombstone landed (within the slack) still counts as older.
  assert.deepEqual(settleTombstones([t('EDGE', 10_000)], { ...at, running: true, claudeAges: [(10_000 - TOMBSTONE_SLACK_MS + 1000) / 1000] }).length, 1);
});

test('the workspace prints only claude process ages; anything else in the output is ignored', () => {
  assert.deepEqual(parseClaudeAges('12\n0\n\nnot a number\n-3\n 7 \n'), [12, 0, 7]);
  // Runs the same function the workspace runs, here: it reads /proc and returns whole, non-negative seconds.
  const ages = new Function('require', `return (${CLAUDE_AGES_JS})`)(createRequire(import.meta.url))(100) as number[];
  assert.ok(Array.isArray(ages) && ages.every((a) => Number.isInteger(a) && a >= 0));
  assert.ok(!/environ|cmdline/.test(CLAUDE_AGES_JS), 'never reads environments or command lines');
});

test('pending_deletes: old rows read the same, files-only rows write the same, and only safe entries survive', () => {
  const old = '[{"path":"/etc/claudepilot/account/a.key","since":5},{"path":"/etc/claude-code/managed-settings.d/40-claudepilot-account.json","since":6}]';
  const p = parsePending(old);
  assert.deepEqual([...p.paths], [['/etc/claudepilot/account/a.key', 5], ['/etc/claude-code/managed-settings.d/40-claudepilot-account.json', 6]]);
  assert.equal(serializePending(p), old);

  p.paths.set('/etc/claudepilot/marketplace/plugins/frontend/0123456789ab/', 7);
  p.tombstones.push({ owner: 'secrets', name: 'GH_CONFIG_DIR', value: '/home/node/.config/gh', since: 8 });
  const round = parsePending(serializePending(p));
  assert.deepEqual([...round.paths], [...p.paths]);
  assert.deepEqual(round.tombstones, p.tombstones);

  const hostile = JSON.stringify([
    { path: '/etc/passwd', since: 1 }, // no owner writes it
    { path: '/etc/claudepilot/marketplace/plugins/x/../../../a/', since: 1 },
    { path: '/home/node/', since: 1 },
    { env: 'X', owner: 'nobody', value: '', since: 1 },
    { env: 'X', owner: 'secrets', value: 3, since: 1 },
    { path: '/etc/claudepilot/secrets/x', since: 'yesterday' },
    null,
  ]);
  assert.deepEqual(parsePending(hostile), { paths: new Map(), tombstones: [] });
  assert.deepEqual(parsePending('not json'), { paths: new Map(), tombstones: [] });
  assert.deepEqual(parsePending('{"path":"/x"}'), { paths: new Map(), tombstones: [] });
});
