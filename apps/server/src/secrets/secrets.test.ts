import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { CLAUDE_CREDENTIAL_MESSAGE, type SecretsContent as View } from '@portal/contracts';
import { compile, CompileError } from '../delivery/compile.js';
import { FOUNDATION } from '../delivery/reconciler.js';
import { NODE, ROOT, type Fragment } from '../delivery/types.js';
import { forgetSecrets, rotateKey } from '../store/store.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import type { SecretsContent } from './kind.js';
import { KEY, secretsHarness } from './testkit.js';

const CANARY = 'cnry7Hq2Lx9Vb4Nw8Pz3Rt6Ys1Ku5';
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;
const field = (f: string, re: RegExp) => (e: unknown) => isAppError(e) && re.test(String((e.details as Record<string, string> | undefined)?.[f] ?? ''));
const view = (c: unknown) => c as View;
const stored = (h: Awaited<ReturnType<typeof secretsHarness>>, id: string) =>
  JSON.parse((h.store.db!.prepare('SELECT content FROM pool_revisions WHERE pool_id = ? ORDER BY revision DESC LIMIT 1').get(id) as { content: string }).content) as SecretsContent;

test('the migration: secret_values holds sealed versions, one per entry field and version, deleted with their set', async () => {
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', { name: 'team', content: { entries: [{ kind: 'secret', name: 'TOKEN', newValue: CANARY }] } });
    const row = h.store.db!.prepare('SELECT * FROM secret_values').get() as Record<string, unknown>;
    assert.equal(row.pool_id, p.id);
    assert.equal(row.version, 1);
    assert.equal(row.field, 'value');
    assert.equal(row.source, 'manual');
    assert.match(String(row.ciphertext), /^v1\./);
    assert.ok(!String(row.ciphertext).includes(CANARY));
    assert.throws(
      () => h.store.db!.prepare("INSERT INTO secret_values (id, pool_id, entry_id, version, fingerprint, fingerprint_key_id, hint, byte_length, created_at) VALUES ('x', ?, ?, 1, 'f', 'k', 'h', 1, 'now')").run(p.id, row.entry_id as string),
      /UNIQUE/,
    );
    h.service.delete(p.id);
    assert.equal((h.store.db!.prepare('SELECT count(*) AS n FROM secret_values').get() as { n: number }).n, 0);
  } finally {
    h.done();
  }
});

test('write-only: values are sealed, revisions hold value IDs, and the API shows only hint, fingerprint, length and version', async () => {
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', {
      name: 'team',
      content: {
        entries: [
          { kind: 'variable', name: 'REGION', value: 'eu-west-1' },
          { kind: 'secret', name: 'GH_PAT', newValue: `ghp_${CANARY}aaaa1234\n`, options: { expose: true } },
        ],
      },
    });
    const v = view(p.content);
    assert.equal(v.entries[0]!.value, 'eu-west-1');
    const secret = v.entries[1]!;
    assert.equal(secret.secret!.version, 1);
    assert.equal(secret.secret!.hint, 'ghp_…1234', 'a pasted newline is dropped from a one-line value');
    assert.match(secret.secret!.fingerprint, /^[0-9a-f]{8}$/);
    assert.equal(secret.secret!.length, `ghp_${CANARY}aaaa1234`.length);
    assert.equal(secret.secret!.type, 'github');
    assert.equal(secret.secret!.stored, true);
    for (const out of [p, h.service.get(p.id), h.service.list('secrets'), stored(h, p.id)]) assert.ok(!JSON.stringify(out).includes(CANARY), 'never the value');
    assert.deepEqual(Object.keys(stored(h, p.id).entries[1]!.values!), ['value']);

    // Saving the view as it is keeps the value; a new value is the next version, and the old one stays.
    const kept = h.service.update(p.id, { content: { entries: v.entries.map((e) => (e.kind === 'variable' ? { ...e, value: 'us-east-1' } : e)) } });
    assert.equal(view(kept.content).entries[1]!.secret!.fingerprint, secret.secret!.fingerprint);
    const rotated = h.service.update(p.id, { content: { entries: view(kept.content).entries.map((e) => (e.kind === 'secret' ? { ...e, newValue: 'second-value-of-twenty-plus' } : e)) } });
    const info = view(rotated.content).entries[1]!.secret!;
    assert.equal(info.version, 2);
    assert.notEqual(info.fingerprint, secret.secret!.fingerprint);
    const rows = h.store.db!.prepare('SELECT version, prev_fingerprint FROM secret_values ORDER BY version').all() as { version: number; prev_fingerprint: string | null }[];
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ version: 1, prev_fingerprint: null }, { version: 2, prev_fingerprint: secret.secret!.fingerprint }]);
    // Revisions are immutable: revision 1 still names version 1, the newest names version 2.
    const r1 = JSON.parse((h.store.db!.prepare('SELECT content FROM pool_revisions WHERE pool_id = ? AND revision = 1').get(p.id) as { content: string }).content) as SecretsContent;
    const ids = h.store.db!.prepare('SELECT id FROM secret_values ORDER BY version').all() as { id: string }[];
    assert.equal(r1.entries[1]!.values!.value, ids[0]!.id);
    assert.equal(stored(h, p.id).entries[1]!.values!.value, ids[1]!.id);
  } finally {
    h.done();
  }
});

test('fingerprints are keyed: the same value under another portal key gives another fingerprint', async () => {
  const a = await secretsHarness();
  const b = await secretsHarness({ key: generateSecretKey() });
  try {
    const fp = (h: typeof a) => view(h.service.create('secrets', { name: 's', content: { entries: [{ kind: 'secret', name: 'K', newValue: 'same-value' }] } }).content).entries[0]!.secret!.fingerprint;
    const [fa, fb] = [fp(a), fp(b)];
    assert.notEqual(fa, fb);
    assert.equal(a.store.secrets!.fingerprint('same-value').slice(0, 8), fa);
  } finally {
    a.done();
    b.done();
  }
});

test('names (FR3) and reserved names (FR4)', async () => {
  const h = await secretsHarness();
  try {
    const save = (entries: unknown[]) => h.service.create('secrets', { name: `s${Math.random()}`, content: { entries } });
    assert.throws(() => save([{ kind: 'variable', name: '1BAD', value: 'x' }]), field('entries.0.name', /Letters, digits and _/));
    assert.throws(() => save([{ kind: 'secret', name: '.hidden', newValue: 'x' }]), field('entries.0.name', /starting with a letter or digit/));
    assert.throws(() => save([{ kind: 'secret', name: 'my.key', newValue: 'x', options: { expose: true } }]), field('entries.0.name', /letters, digits and _ only/));
    for (const name of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_X', 'MCP_TIMEOUT', 'DISABLE_TELEMETRY', 'CLAUDEPILOT_VERIFY', 'PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'https_proxy', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_NO_VERIFY', 'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND', 'SSH_ASKPASS', 'GH_CONFIG_DIR', 'KUBECONFIG'])
      assert.throws(() => save([{ kind: 'variable', name, value: 'x' }]), field('entries.0.name', /reserved/), name);
    assert.throws(() => save([{ kind: 'secret', name: 'K', newValue: 'x', options: { pathVariable: 'BASH_ENV' } }]), field('entries.0.pathVariable', /reserved/));
    // A secret that isn't exposed is only a file, so its name isn't a variable name.
    assert.doesNotThrow(() => save([{ kind: 'secret', name: 'PATH', newValue: 'x' }]));
    assert.throws(() => save([{ kind: 'variable', name: 'A', value: '1' }, { kind: 'secret', name: 'A', newValue: 'x' }]), field('entries.1.name', /already used in this set/));
    assert.throws(() => save([{ kind: 'variable', name: 'A_FILE', value: '1' }, { kind: 'secret', name: 'A', newValue: 'x', options: { pathVariable: 'A_FILE' } }]), field('entries.1.pathVariable', /already used/));
  } finally {
    h.done();
  }
});

test('limits: one-line variables of 8 KB, secrets of 256 KB, 384 KB per set', async () => {
  const h = await secretsHarness();
  try {
    const save = (entries: unknown[]) => h.service.create('secrets', { name: `s${Math.random()}`, content: { entries } });
    assert.throws(() => save([{ kind: 'variable', name: 'A', value: 'x'.repeat(8 * 1024 + 1) }]), field('entries.0.value', /8 KB/));
    assert.throws(() => save([{ kind: 'variable', name: 'A', value: 'two\nlines' }]), field('entries.0.value', /one line/));
    assert.throws(() => save([{ kind: 'secret', name: 'A', newValue: 'x'.repeat(256 * 1024 + 1) }]), field('entries.0.newValue', /256 KB/));
    assert.throws(() => save([{ kind: 'secret', name: 'A', newValue: 'a\0b' }]), field('entries.0.newValue', /Binary/));
    const big = 'line\n'.repeat(40_000); // 200 KB each
    assert.throws(() => save([{ kind: 'secret', name: 'A', newValue: big }, { kind: 'secret', name: 'B', newValue: big }]), /a workspace can take 384 KB/);
    // Multi-line values (key files) keep their final newline.
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n';
    const p = save([{ kind: 'secret', name: 'id_ed25519', newValue: pem }]);
    assert.equal(view(p.content).entries[0]!.secret!.length, pem.length);
    assert.equal(view(p.content).entries[0]!.secret!.hint, '••••••');
    assert.equal(view(p.content).entries[0]!.secret!.type, 'pem');
  } finally {
    h.done();
  }
});

test('FR5: Claude credentials are refused in variables and secrets, raw and encoded, and the value never echoes back', async () => {
  const h = await secretsHarness();
  try {
    const key = `sk-ant-ort01-${CANARY}`;
    const samples = [key, `Bearer ${key}`, Buffer.from(key).toString('base64'), JSON.stringify({ claudeAiOauth: { accessToken: 'x' } })];
    for (const value of samples) {
      for (const entries of [[{ kind: 'secret', name: 'K', newValue: value }], [{ kind: 'variable', name: 'K', value, confirmed: true }]]) {
        let err: unknown;
        try {
          h.service.create('secrets', { name: `s${Math.random()}`, content: { entries } });
        } catch (e) {
          err = e;
        }
        assert.ok(isAppError(err) && err.code === 'VALIDATION_FAILED', value);
        assert.equal(err.message, CLAUDE_CREDENTIAL_MESSAGE);
        assert.ok(!JSON.stringify(err.toJSON()).includes(CANARY));
      }
    }
    assert.equal((h.store.db!.prepare('SELECT count(*) AS n FROM secret_values').get() as { n: number }).n, 0, 'nothing stored');
  } finally {
    h.done();
  }
});

test('FR6: a credential-looking variable is saved only once confirmed, and the confirmation is kept', async () => {
  const h = await secretsHarness();
  try {
    const value = 'npm_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z';
    assert.throws(() => h.service.create('secrets', { name: 'a', content: { entries: [{ kind: 'variable', name: 'NPM_X', value }] } }), field('entries.0.value', /looks like a npm token/));
    const p = h.service.create('secrets', { name: 'a', content: { entries: [{ kind: 'variable', name: 'NPM_X', value, confirmed: true }] } });
    assert.equal(view(p.content).entries[0]!.confirmed, true);
    // Plain values need no confirmation, and keep none.
    const q = h.service.create('secrets', { name: 'b', content: { entries: [{ kind: 'variable', name: 'URL', value: 'https://api.example.com/v1', confirmed: true }] } });
    assert.equal(view(q.content).entries[0]!.confirmed, undefined);
  } finally {
    h.done();
  }
});

test('duplicating copies plain values and leaves secrets empty (FR10); a fresh duplicate delivers no secret file', async () => {
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', { name: 'team', content: { entries: [{ kind: 'variable', name: 'A', value: '1' }, { kind: 'secret', name: 'K', newValue: CANARY }] } });
    const copy = h.service.duplicate(p.id, 'team copy');
    const v = view(copy.content);
    assert.equal(v.entries[0]!.value, '1');
    assert.equal(v.entries[1]!.secret, null, 'needs a value');
    const frags = h.kind.fragments([{ pool: { id: copy.id, name: 'team copy', revision: 1 }, content: stored(h, copy.id), options: {} }], { workspaceId: 'docker/w', running: true, now: new Date() });
    assert.ok(!frags.flatMap((f) => f.files ?? []).some((f) => f.path.endsWith('/files/K')));
  } finally {
    h.done();
  }
});

test('fragments: files, modes, env, env.sh, deny rules, hooks and the FR12 check', async () => {
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', {
      name: 'team',
      content: {
        entries: [
          { kind: 'variable', name: 'GREETING', value: `it's "$HOME" \`x\`` },
          { kind: 'secret', name: 'PGPASS', newValue: 'pg-secret', options: { ownerOnly: true, pathVariable: 'PGPASSFILE_PATH' } },
          { kind: 'secret', name: 'LINEAR_API_KEY', newValue: CANARY, options: { expose: true, terminals: true } },
        ],
      },
    });
    const assigned = [{ pool: { id: p.id, name: 'team', revision: 1 }, content: stored(h, p.id), options: {} }];
    const frags = h.kind.fragments(assigned, { workspaceId: 'docker/w', running: true, now: new Date() });
    const files = frags.flatMap((f) => f.files ?? []);
    const at = (path: string) => files.find((f) => f.path === path)!;
    assert.deepEqual([at('/etc/claudepilot/secrets/files/PGPASS').mode, at('/etc/claudepilot/secrets/files/PGPASS').uid, at('/etc/claudepilot/secrets/files/PGPASS').gid], [0o400, NODE, NODE]);
    const lin = at('/etc/claudepilot/secrets/files/LINEAR_API_KEY');
    assert.deepEqual([lin.content, lin.mode, lin.uid, lin.gid], [CANARY, 0o440, ROOT, NODE]);
    assert.match(lin.secretRef!, /^secret:/);
    const envSh = at('/etc/claudepilot/secrets/env.sh');
    assert.deepEqual([envSh.mode, envSh.uid, envSh.gid, envSh.secretRef], [0o440, ROOT, NODE, undefined]);
    assert.ok(!envSh.content.includes(CANARY), 'env.sh reads exposed secrets from their files');
    assert.match(envSh.content, /^export GREETING='it'\\''s "\$HOME" `x`'$/m);
    assert.match(envSh.content, /^export LINEAR_API_KEY="\$\(cat '\/etc\/claudepilot\/secrets\/files\/LINEAR_API_KEY' 2>\/dev\/null\)"$/m);
    assert.match(envSh.content, /^export PGPASSFILE_PATH='\/etc\/claudepilot\/secrets\/files\/PGPASS'$/m);
    const shared = frags.find((f) => f.settings)!;
    assert.deepEqual((shared.settings as { env: Record<string, string> }).env, { GREETING: `it's "$HOME" \`x\``, PGPASSFILE_PATH: '/etc/claudepilot/secrets/files/PGPASS', LINEAR_API_KEY: CANARY });
    assert.deepEqual((shared.settings as { permissions: { deny: string[] } }).permissions.deny, [
      'Read(//etc/claudepilot/secrets/**)',
      'Edit(//etc/claudepilot/secrets/**)',
      'Read(//etc/claude-code/managed-settings.d/20-claudepilot-env.json)',
      'Edit(//etc/claude-code/managed-settings.d/20-claudepilot-env.json)',
      'Read(//proc/**/environ)',
    ]);
    assert.deepEqual(shared.hooks, ['shell']);
    assert.ok(frags.every((f) => f.checkReadable));
    assert.deepEqual(frags.filter((f) => f.pool).map((f) => f.pool), [{ id: p.id, revision: 1 }]);

    // The compiler accepts it: ownership, the deny-rule check (A1), the drop-in's mode, hooks and readable paths.
    const bundle = compile({ portalId: 'p', generation: 1, fragments: [FOUNDATION, ...frags], claudeVersion: '2.1.296 (Claude Code)' });
    const dropIn = bundle.files.find((f) => f.path.endsWith('20-claudepilot-env.json'))!;
    assert.deepEqual([dropIn.mode, dropIn.gid], [0o440, NODE]);
    assert.ok(bundle.files.some((f) => f.path === '/etc/profile.d/claudepilot.sh'));
    assert.deepEqual(bundle.lines, [{ path: '/etc/bash.bashrc', line: 'if [ -r /etc/claudepilot/secrets/env.sh ]; then . /etc/claudepilot/secrets/env.sh; fi # claudepilot' }]);
    assert.ok(bundle.readable!.includes(dropIn.path) && bundle.readable!.includes('/etc/claudepilot/secrets/files/PGPASS'));
    assert.ok(!JSON.stringify(bundle.manifest).includes(CANARY));

    // No exposed secret: no /proc rule.
    const q = h.service.create('secrets', { name: 'plain', content: { entries: [{ kind: 'secret', name: 'K', newValue: 'v' }] } });
    const plain = h.kind.fragments([{ pool: { id: q.id, name: 'plain', revision: 1 }, content: stored(h, q.id), options: {} }], { workspaceId: 'docker/w', running: true, now: new Date() });
    assert.ok(!(plain.find((f) => f.settings)!.settings as { permissions: { deny: string[] } }).permissions.deny.includes('Read(//proc/**/environ)'));
  } finally {
    h.done();
  }
});

test('preview: placeholders where values go, secret files redacted, nothing decrypted', async () => {
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', { name: 'team', content: { entries: [{ kind: 'secret', name: 'TOKEN', newValue: CANARY, options: { expose: true } }] } });
    const info = view(p.content).entries[0]!.secret!;
    const preview = h.service.preview('secrets', p.id, {});
    assert.ok(!JSON.stringify(preview).includes(CANARY));
    const file = preview.files.find((f) => f.path.endsWith('/files/TOKEN'))!;
    assert.equal(file.redacted, true);
    const dropIn = preview.files.find((f) => f.path.endsWith('20-claudepilot-env.json'))!;
    assert.equal(JSON.parse(dropIn.content).env.TOKEN, `«secret TOKEN v1 · ${info.fingerprint}»`);
    // Unsaved content with a new value: stored for the preview only.
    const before = (h.store.db!.prepare('SELECT count(*) AS n FROM secret_values').get() as { n: number }).n;
    const unsaved = h.service.preview('secrets', p.id, { content: { entries: [{ ...view(p.content).entries[0]!, newValue: `${CANARY}-2` }] } });
    assert.ok(!JSON.stringify(unsaved).includes(CANARY));
    assert.match(JSON.parse(unsaved.files.find((f) => f.path.endsWith('20-claudepilot-env.json'))!.content).env.TOKEN, /^«secret TOKEN v2 · [0-9a-f]{8}»$/);
    assert.equal((h.store.db!.prepare('SELECT count(*) AS n FROM secret_values').get() as { n: number }).n, before, 'rolled back');
  } finally {
    h.done();
  }
});

test('FR9: names unique across a workspace’s sets, refused on assign (one or bulk), on save, and at compile', async () => {
  const h = await secretsHarness();
  try {
    const a = h.service.create('secrets', { name: 'a', content: { entries: [{ kind: 'variable', name: 'SHARED', value: '1' }] } });
    const b = h.service.create('secrets', { name: 'b', content: { entries: [{ kind: 'secret', name: 'SHARED', newValue: 'x' }] } });
    const c = h.service.create('secrets', { name: 'c', content: { entries: [{ kind: 'variable', name: 'OTHER', value: '2' }] } });
    h.service.setAssignments('docker/w1', 'secrets', [{ poolId: a.id }, { poolId: c.id }]);
    assert.throws(() => h.service.setAssignments('docker/w1', 'secrets', [{ poolId: a.id }, { poolId: b.id }]), (e) => code('CONFLICT')(e) && /“SHARED” is in both/.test((e as Error).message));
    assert.throws(() => h.service.assignToMany(b.id, ['docker/w1']), code('CONFLICT'));
    assert.deepEqual(h.service.assignToMany(b.id, ['docker/w2']).assigned, ['docker/w2']);
    // Saving c with a name a also has, while both are on w1: refused.
    assert.throws(() => h.service.update(c.id, { content: { entries: [{ kind: 'variable', name: 'SHARED', value: '3' }] } }), (e) => code('CONFLICT')(e) && /also in “a”, which w1 uses/.test((e as Error).message));
    // Compile: two sets that clash anyway (pinned to an older revision, for example) fail the workspace's delivery.
    const clash = [a, b].map((p) => ({ pool: { id: p.id, name: p.name, revision: 1 }, content: stored(h, p.id), options: {} }));
    assert.throws(() => h.kind.fragments(clash, { workspaceId: 'docker/w1', running: true, now: new Date() }), (e) => e instanceof CompileError && /“SHARED” is in both “a” and “b”/.test(e.message));
  } finally {
    h.done();
  }
});

test('references: names resolve per workspace; renames, removals and deletes of used names are refused; unassigning warns', async () => {
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', {
      name: 'team',
      content: {
        entries: [
          { kind: 'variable', name: 'REGION', value: 'eu' },
          { kind: 'secret', name: 'LINEAR_API_KEY', newValue: 'lin', options: { expose: true, pathVariable: 'LINEAR_FILE' } },
          { kind: 'secret', name: 'EMPTY' },
        ],
      },
    });
    const other = h.service.create('secrets', { name: 'other', content: { entries: [{ kind: 'variable', name: 'X', value: '1' }] } });
    h.service.setAssignments('docker/w1', 'secrets', [{ poolId: p.id }, { poolId: other.id }]);
    assert.deepEqual(Object.fromEntries(h.references.secretNamesFor('docker/w1')), {
      REGION: { kind: 'variable', file: false, variable: true },
      LINEAR_API_KEY: { kind: 'secret', file: true, variable: true },
      LINEAR_FILE: { kind: 'variable', file: false, variable: true },
      X: { kind: 'variable', file: false, variable: true },
    });
    assert.equal(h.references.secretNamesFor('docker/none').size, 0);

    h.uses.set('LINEAR_API_KEY', [{ poolId: 'm1', poolName: 'Linear', workspaces: ['docker/w1'] }]);
    const entries = view(h.service.get(p.id).content).entries;
    const renamed = entries.map((e) => (e.name === 'LINEAR_API_KEY' ? { ...e, name: 'LINEAR_KEY' } : e));
    assert.throws(() => h.service.update(p.id, { content: { entries: renamed } }), (e) => code('CONFLICT')(e) && /MCP set “Linear” uses “LINEAR_API_KEY”/.test((e as Error).message));
    assert.throws(() => h.service.update(p.id, { content: { entries: entries.filter((e) => e.name !== 'LINEAR_API_KEY') } }), code('CONFLICT'));
    // Other changes go through.
    assert.doesNotThrow(() => h.service.update(p.id, { content: { entries: entries.map((e) => (e.name === 'REGION' ? { ...e, value: 'us' } : e)) } }));

    // Unassigning the only set that provides it warns (and goes ahead).
    const r = h.service.setAssignments('docker/w1', 'secrets', [{ poolId: other.id }]);
    assert.deepEqual(r.warnings, ['MCP set “Linear” on w1 needs “LINEAR_API_KEY”, which no other set there provides.']);
    assert.deepEqual(h.service.setAssignments('docker/w1', 'secrets', []).warnings, []);
    // Deleting is refused while something references one of its names (FR19).
    assert.throws(() => h.service.delete(p.id), (e) => code('CONFLICT')(e) && /Linear/.test((e as Error).message));
    h.uses.clear();
    h.service.delete(p.id);
  } finally {
    h.done();
  }
});

test('locked portal: a new value can’t be stored; delivery of a cleared value fails instead of dropping the file', async () => {
  const locked = await secretsHarness({ key: null });
  try {
    assert.throws(() => locked.service.create('secrets', { name: 's', content: { entries: [{ kind: 'secret', name: 'K', newValue: 'v' }] } }), code('LOCKED'));
    // Variables need no key.
    assert.doesNotThrow(() => locked.service.create('secrets', { name: 'v', content: { entries: [{ kind: 'variable', name: 'A', value: '1' }] } }));
  } finally {
    locked.done();
  }
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', { name: 's', content: { entries: [{ kind: 'secret', name: 'K', newValue: 'v' }] } });
    h.store.db!.exec('UPDATE secret_values SET ciphertext = NULL');
    assert.equal(view(h.service.get(p.id).content).entries[0]!.secret!.stored, false);
    assert.throws(
      () => h.kind.fragments([{ pool: { id: p.id, name: 's', revision: 1 }, content: stored(h, p.id), options: {} }], { workspaceId: 'docker/w', running: true, now: new Date() }),
      (e) => e instanceof CompileError && /cleared/.test(e.message),
    );
  } finally {
    h.done();
  }
});

test('key rotation re-seals secret values; forget-secrets clears them', async () => {
  const h = await secretsHarness();
  const dataDir = h.dataDir;
  const p = h.service.create('secrets', { name: 's', content: { entries: [{ kind: 'secret', name: 'K', newValue: CANARY }] } });
  const content = stored(h, p.id);
  h.store.close();
  const next = generateSecretKey();
  const opts = { dataDir };
  const r = await rotateKey({ ...opts, oldKey: parseSecretKey(KEY), newKey: parseSecretKey(next) });
  assert.equal(r.resealed, 1);
  const { Store } = await import('../store/store.js');
  const { SecretValues } = await import('./values.js');
  const reopened = await Store.open({ dataDir, secretKey: parseSecretKey(next) });
  assert.equal(new SecretValues(reopened).open(content.entries[0]!.values!.value!), CANARY);
  reopened.close();
  const f = await forgetSecrets({ ...opts, newKey: parseSecretKey(generateSecretKey()) });
  assert.equal(f.cleared, 1);
  h.done();
});

test('tombstones (A6, FR13): a removed variable keeps "" in the drop-in on a running workspace, and goes outright on a stopped one', async () => {
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', { name: 'team', content: { entries: [{ kind: 'variable', name: 'A', value: '1' }, { kind: 'variable', name: 'B', value: '2' }] } });
    const frag = (): Fragment[] => h.kind.fragments([{ pool: { id: p.id, name: 'team', revision: 1 }, content: stored(h, p.id), options: {} }], { workspaceId: 'docker/w', running: true, now: new Date() });
    const base = { portalId: 'p', generation: 1, claudeVersion: '2.1.296 (Claude Code)' };
    const first = compile({ ...base, fragments: [FOUNDATION, ...frag()] });
    assert.deepEqual(first.manifest.env, { secrets: { A: '', B: '' } });
    h.service.update(p.id, { content: { entries: [{ ...view(h.service.get(p.id).content).entries[0]! }] } });
    const env = (b: ReturnType<typeof compile>) => JSON.parse(b.files.find((f) => f.path.endsWith('20-claudepilot-env.json'))!.content).env as Record<string, string>;
    const running = compile({ ...base, fragments: [FOUNDATION, ...frag()], previous: { env: first.manifest.env }, running: true });
    assert.deepEqual(env(running), { A: '1', B: '' });
    assert.deepEqual(running.tombstones.map((t) => [t.owner, t.name, t.value]), [['secrets', 'B', '']]);
    const stopped = compile({ ...base, fragments: [FOUNDATION, ...frag()], previous: { env: first.manifest.env }, running: false });
    assert.deepEqual(env(stopped), { A: '1' });
  } finally {
    h.done();
  }
});
