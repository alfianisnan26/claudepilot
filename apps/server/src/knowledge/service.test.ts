import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tempDirectory } from '../store/testTmp.js';
import { makeZip } from '../skills/testkit.js';
import { fixtureZip, obsidianFixture } from './fixtures.js';
import { importZip } from './importer.js';
import { parseActor } from './journal.js';
import { KnowledgeService, parseRoots } from './service.js';
import { harness, type Harness } from './testkit.js';
import { openZip } from './zip.js';

const UI = parseActor('ui');
const TOKEN = parseActor('portal-mcp:tok1');
const SESSION = parseActor('session:s-1');
const CANARY_KEY = 'sk-ant-api03-CANARYCANARYCANARY1234567890';

const open: Harness[] = [];
after(() => open.forEach((h) => h.close()));
const reason = (r: string) => (e: unknown) => (e as { reason?: string }).reason === r;

async function make(opts: { limits?: Partial<Harness['limits']>; roots?: Record<string, { path: string; writable: boolean }> } = {}) {
  const h = await harness({ limits: opts.limits });
  open.push(h);
  const logs: string[] = [];
  const svc = new KnowledgeService(h.store, { dir: join(h.dir, 'knowledge'), backupsDir: join(h.dir, 'backups'), limits: h.limits, now: () => h.clock.now, roots: opts.roots, log: (m) => logs.push(m) });
  return { h, svc, logs, reopen: () => new KnowledgeService(h.store, { dir: join(h.dir, 'knowledge'), backupsDir: join(h.dir, 'backups'), limits: h.limits, now: () => h.clock.now, roots: opts.roots, log: (m) => logs.push(m) }) };
}

test('roots are parsed from the environment', () => {
  assert.deepEqual(parseRoots('docs=/srv/docs, notes=/srv/notes:rw ,bad, =/x, x=relative'), { docs: { path: '/srv/docs', writable: false }, notes: { path: '/srv/notes', writable: true } });
  assert.deepEqual(parseRoots(undefined), {});
});

test('vaults: create with defaults, validate names, update the policy, delete into trash after typing the name', async () => {
  const { svc, h } = await make();
  const v = svc.create({ name: '  My   Brain ' });
  assert.deepEqual([v.name, v.kind, v.agents, v.dailyFolder, v.readOnly], ['My Brain', 'vault', 'write-own', 'Daily', false]);
  assert.equal(statSync(v.location).mode & 0o777, 0o700);
  assert.throws(() => svc.create({ name: 'my brain' }), reason('EXISTS'));
  for (const bad of ['', '   ', 'x'.repeat(61), 'a\u0000b', 42 as unknown as string]) assert.throws(() => svc.create({ name: bad }), reason('INVALID_INPUT'));
  assert.throws(() => svc.create({ name: 'Other', agents: 'god' as never }), reason('INVALID_INPUT'));
  assert.throws(() => svc.create({ name: 'Other', timezone: 'Mars/Base' }), reason('INVALID_INPUT'));
  assert.throws(() => svc.create({ name: 'Other', dailyFolder: '../up' }), reason('INVALID_PATH'));
  const u = svc.update(v.id, { agents: 'write', timezone: 'Asia/Jakarta', settings: { rewriteLinksOnRename: false, labels: 'heading' } });
  assert.deepEqual([u.agents, u.timezone, u.settings.rewriteLinksOnRename, u.settings.labels], ['write', 'Asia/Jakarta', false, 'heading']);
  assert.throws(() => svc.update(v.id, { agents: 'nope' as never }), reason('INVALID_INPUT'));
  svc.create({ name: 'Second' });
  assert.throws(() => svc.update(v.id, { name: 'second' }), reason('EXISTS'));
  svc.vault(v.id).writeNote('keep.md', 'precious', { actor: UI, create: true });
  assert.throws(() => svc.remove(v.id, 'wrong name'), reason('INVALID_INPUT'));
  svc.remove(v.id, 'My Brain');
  assert.deepEqual(svc.list().map((x) => x.name), ['Second']);
  assert.throws(() => svc.summary(v.id), reason('NOT_FOUND'));
  const trash = readdirSync(join(h.dir, 'knowledge', 'trash'));
  assert.equal(trash.length, 1);
  assert.equal(readFileSync(join(h.dir, 'knowledge', 'trash', trash[0]!, 'keep.md'), 'utf8'), 'precious');
  assert.equal(existsSync(join(h.dir, 'knowledge', 'index', `${v.id}.db`)), false);
  // The name is free again, and the old row doesn't block it.
  assert.equal(svc.create({ name: 'My Brain' }).name, 'My Brain');
});

test('folder sources: only operator-allowed roots, read-only, never outside the root, forgetting one leaves the folder alone', async () => {
  const docs = tempDirectory('kg-docs-');
  mkdirSync(join(docs, 'prd'), { recursive: true });
  writeFileSync(join(docs, 'README.md'), '# Docs\n[PRD one](prd/one.md)\n');
  writeFileSync(join(docs, 'prd', 'one.md'), '# PRD one\n[back](../README.md)\n');
  const outside = tempDirectory('kg-outside-');
  writeFileSync(join(outside, 'secret.md'), 'secret');
  symlinkSync(outside, join(docs, 'escape'));
  const { svc } = await make({ roots: { docs: { path: docs, writable: false } } });
  assert.deepEqual(svc.sources(), [{ name: 'docs', writable: false }]);
  assert.throws(() => svc.create({ name: 'x', source: { root: 'etc' } }), reason('INVALID_INPUT'));
  assert.throws(() => svc.create({ name: 'x', source: { root: 'docs', sub: '../..' } }), reason('INVALID_PATH'));
  assert.throws(() => svc.create({ name: 'x', source: { root: 'docs', sub: 'escape' } }), reason('INVALID_PATH'));
  assert.throws(() => svc.create({ name: 'x', source: { root: 'docs', sub: 'missing' } }), reason('UNAVAILABLE'));
  const v = svc.create({ name: 'Portal docs', source: { root: 'docs' } });
  assert.deepEqual([v.kind, v.readOnly, v.agents, v.settings.labels, v.source], ['folder', true, 'read', 'heading', { root: 'docs', sub: '' }]);
  await svc.rescan(v.id);
  const stats = svc.summary(v.id).counts;
  assert.equal(stats.notes, 2);
  assert.equal(svc.vault(v.id).index.get('escape/secret.md'), null);
  assert.deepEqual(svc.backlinks(v.id, 'prd/one.md').map((b) => b.path), ['README.md']);
  assert.throws(() => svc.putNote(v.id, 'new.md', { content: 'x', create: true }), reason('READ_ONLY'));
  assert.throws(() => svc.putNote(v.id, 'prd/one.md', { content: 'x', baseVersion: svc.getNote(v.id, 'prd/one.md').version }, TOKEN), reason('READ_ONLY'));
  svc.remove(v.id, 'Portal docs');
  assert.equal(readFileSync(join(docs, 'prd', 'one.md'), 'utf8'), '# PRD one\n[back](../README.md)\n');
});

test('agent policy: off, read, write-own, write against every kind of call; people are never held to it', async () => {
  const { svc, h } = await make();
  const mk = (agents: 'off' | 'read' | 'write-own' | 'write') => {
    const v = svc.create({ name: `P-${agents}`, agents });
    const vault = svc.vault(v.id);
    vault.writeNote('Human.md', 'written by a person', { actor: UI, create: true });
    vault.writeNote('Daily/2026-10-12.md', '- 08:00 person\n', { actor: UI, create: true });
    return v.id;
  };
  const ids = { off: mk('off'), read: mk('read'), own: mk('write-own'), write: mk('write') };

  // off: nothing at all, for agents; the person still reads and writes.
  assert.throws(() => svc.getNote(ids.off, 'Human.md', TOKEN), reason('VAULT_UNAVAILABLE'));
  assert.throws(() => svc.search(ids.off, 'person', {}, TOKEN), reason('VAULT_UNAVAILABLE'));
  assert.throws(() => svc.tree(ids.off, '', TOKEN), reason('VAULT_UNAVAILABLE'));
  assert.equal(svc.getNote(ids.off, 'Human.md', UI).content, 'written by a person');

  // read: reading yes, any write no.
  assert.equal(svc.getNote(ids.read, 'Human.md', TOKEN).content, 'written by a person');
  assert.equal(svc.search(ids.read, 'person', {}, TOKEN).hits.length, 2);
  assert.throws(() => svc.putNote(ids.read, 'New.md', { content: 'x', create: true }, TOKEN), reason('NOT_ALLOWED_BY_POLICY'));
  assert.throws(() => svc.appendNote(ids.read, 'Human.md', 'x', undefined, TOKEN), reason('NOT_ALLOWED_BY_POLICY'));
  assert.throws(() => svc.appendDaily(ids.read, { text: 'x' }, TOKEN), reason('NOT_ALLOWED_BY_POLICY'));

  // write-own: create anywhere; change only notes agents wrote; append to a daily note; never a person's note.
  const human = svc.getNote(ids.own, 'Human.md', UI);
  assert.throws(() => svc.putNote(ids.own, 'Human.md', { content: 'overwritten', baseVersion: human.version }, TOKEN), reason('NOT_ALLOWED_BY_POLICY'));
  assert.throws(() => svc.editNote(ids.own, 'Human.md', 'person', 'agent', human.version, TOKEN), reason('NOT_ALLOWED_BY_POLICY'));
  assert.throws(() => svc.appendNote(ids.own, 'Human.md', 'x', undefined, TOKEN), reason('NOT_ALLOWED_BY_POLICY'));
  assert.equal(svc.getNote(ids.own, 'Human.md', UI).content, 'written by a person');
  const made = svc.putNote(ids.own, 'Agent/Notes.md', { content: 'agent note', create: true }, TOKEN);
  assert.equal(made.created, true);
  assert.equal(svc.putNote(ids.own, 'Agent/Notes.md', { content: 'agent note v2', baseVersion: made.version }, TOKEN).unchanged, false);
  assert.equal(svc.appendNote(ids.own, 'Agent/Notes.md', 'more', undefined, SESSION).unchanged, false);
  const day = svc.appendDaily(ids.own, { text: 'agent was here', date: '2026-10-12' }, TOKEN);
  assert.equal(day.created, false);
  assert.match(svc.getNote(ids.own, 'Daily/2026-10-12.md', UI).content, /- 08:00 person\n- \d\d:\d\d agent was here\n$/);
  // The note an agent made turns into the person's once the person edits it.
  const agentNote = svc.getNote(ids.own, 'Agent/Notes.md', UI);
  assert.equal(agentNote.agentOnly, true);
  h.clock.now = new Date(h.clock.now.getTime() + 600_000);
  svc.putNote(ids.own, 'Agent/Notes.md', { content: 'the person rewrote it', baseVersion: agentNote.version }, UI);
  assert.equal(svc.getNote(ids.own, 'Agent/Notes.md', UI).agentOnly, false);
  assert.throws(() => svc.appendNote(ids.own, 'Agent/Notes.md', 'x', undefined, TOKEN), reason('NOT_ALLOWED_BY_POLICY'));

  // write: edit a person's note, with the version check.
  const w = svc.getNote(ids.write, 'Human.md', TOKEN);
  assert.throws(() => svc.putNote(ids.write, 'Human.md', { content: 'x', baseVersion: 'ffffffffffffffff' }, TOKEN), reason('CONFLICT'));
  assert.throws(() => svc.putNote(ids.write, 'Human.md', { content: 'x' }, TOKEN), reason('CONFLICT'));
  assert.equal(svc.putNote(ids.write, 'Human.md', { content: 'agent edit', baseVersion: w.version }, TOKEN).unchanged, false);
  assert.equal(svc.editNote(ids.write, 'Human.md', 'agent', 'AGENT', svc.getNote(ids.write, 'Human.md', TOKEN).version, TOKEN).unchanged, false);

  // Whatever the policy, an agent never deletes, renames, restores, uploads or makes folders; a person does.
  for (const id of [ids.own, ids.write]) {
    assert.throws(() => svc.deleteNote(id, 'Human.md', TOKEN), reason('NOT_ALLOWED_BY_POLICY'));
    assert.throws(() => svc.renameNote(id, 'Human.md', 'Moved.md', {}, TOKEN), reason('NOT_ALLOWED_BY_POLICY'));
    assert.throws(() => svc.putFile(id, 'a.png', Buffer.alloc(3), TOKEN), reason('NOT_ALLOWED_BY_POLICY'));
    assert.throws(() => svc.makeFolder(id, 'Folder', TOKEN), reason('NOT_ALLOWED_BY_POLICY'));
  }
  assert.equal((await svc.renameNote(ids.own, 'Human.md', 'Moved.md', {}, UI)).path, 'Moved.md');
  // Refusals are audited with their reason; the audit never holds note text.
  const audit = svc.activity(ids.own).filter((a) => a.outcome === 'denied');
  assert.ok(audit.length >= 3);
  assert.ok(audit.every((a) => a.actor === 'portal-mcp:tok1'));
});

test('secrets: an agent write that looks like a credential is refused and leaves no trace; a person’s is saved with a warning', async () => {
  const { svc, h, logs } = await make();
  const v = svc.create({ name: 'S', agents: 'write' });
  const base = svc.putNote(v.id, 'Note.md', { content: 'clean', create: true }, UI);
  const dirty = `config: ${CANARY_KEY}`;
  assert.throws(() => svc.putNote(v.id, 'Agent.md', { content: dirty, create: true }, TOKEN), reason('SECRET_IN_CONTENT'));
  assert.throws(() => svc.appendNote(v.id, 'Note.md', dirty, undefined, TOKEN), reason('SECRET_IN_CONTENT'));
  assert.throws(() => svc.editNote(v.id, 'Note.md', 'clean', dirty, base.version, TOKEN), reason('SECRET_IN_CONTENT'));
  assert.throws(() => svc.appendDaily(v.id, { text: dirty }, TOKEN), reason('SECRET_IN_CONTENT'));
  assert.throws(() => svc.appendNote(v.id, 'Note.md', 'ok', dirty, TOKEN), reason('SECRET_IN_CONTENT'));
  assert.equal(existsSync(join(svc.summary(v.id).location, 'Agent.md')), false);
  assert.equal(svc.getNote(v.id, 'Note.md', UI).content, 'clean');
  const saved = svc.putNote(v.id, 'Mine.md', { content: dirty, create: true }, UI);
  assert.equal(saved.warnings.length, 1);
  assert.equal(svc.getNote(v.id, 'Mine.md', UI).secretShaped, true);
  // The canary is in the person's note and its history, by design, and nowhere else: not in the audit, not in the log.
  const dump = JSON.stringify(h.store.db!.prepare('SELECT * FROM kg_audit').all());
  assert.equal(dump.includes('CANARYCANARY'), false);
  assert.equal(logs.join('\n').includes('CANARYCANARY'), false);
  assert.ok(svc.activity(v.id).some((a) => a.outcome === 'refused' && a.detail === 'SECRET_IN_CONTENT'));
});

test('agent writes are capped; a person may write a full note', async () => {
  const { svc } = await make();
  const v = svc.create({ name: 'Cap', agents: 'write' });
  const big = 'x'.repeat(256 * 1024 + 1);
  assert.throws(() => svc.putNote(v.id, 'Big.md', { content: big, create: true }, TOKEN), reason('TOO_LARGE'));
  assert.throws(() => svc.appendNote(v.id, 'Big.md', big, undefined, TOKEN), reason('TOO_LARGE'));
  assert.equal(svc.putNote(v.id, 'Big.md', { content: big, create: true }, UI).created, true);
  assert.throws(() => svc.putNote(v.id, 'Bigger.md', { content: 'x'.repeat(1024 * 1024 + 1), create: true }, UI), reason('TOO_LARGE'));
});

test('context edges: sessions, tokens and the person are recorded as who read or wrote which note, and follow a rename', async () => {
  const { svc, h } = await make();
  const v = svc.create({ name: 'Edges', agents: 'write' });
  svc.putNote(v.id, 'A.md', { content: 'a [[B]]', create: true }, UI);
  svc.putNote(v.id, 'B.md', { content: 'b', create: true }, SESSION);
  svc.getNote(v.id, 'A.md', SESSION);
  svc.getNote(v.id, 'A.md', SESSION);
  svc.getNote(v.id, 'A.md', TOKEN);
  svc.getNote(v.id, 'A.md', UI); // a person reading is not an edge
  svc.appendNote(v.id, 'B.md', 'more', undefined, parseActor('ticket:T-9'));
  const edges = () =>
    (h.store.db!.prepare('SELECT path, source_kind, source_id, kind, count FROM kg_edges WHERE vault_id = ? ORDER BY path, source_kind, source_id, kind').all(v.id) as unknown as { path: string; source_kind: string; source_id: string; kind: string; count: number }[]).map((e) => `${e.path}|${e.source_kind}:${e.source_id}|${e.kind}|${e.count}`);
  assert.deepEqual(edges(), [
    'A.md|session:s-1|read|2',
    'A.md|token:tok1|read|1',
    'A.md|user:ui|created|1',
    'B.md|session:s-1|created|1',
    'B.md|ticket:T-9|appended|1',
  ]);
  await svc.renameNote(v.id, 'B.md', 'Folder/B2.md', {}, UI);
  assert.ok(edges().includes('Folder/B2.md|session:s-1|created|1'));
  assert.ok(edges().every((e) => !e.startsWith('B.md|')));
});

test('daily notes: the vault’s time zone, bullets with the time, created on first write, the person’s note can be appended to', async () => {
  const { svc, h } = await make();
  h.clock.now = new Date('2026-10-12T23:30:00Z');
  const v = svc.create({ name: 'Days', timezone: 'Asia/Jakarta', agents: 'write-own' });
  assert.deepEqual(svc.daily(v.id, undefined), { date: '2026-10-13', path: 'Daily/2026-10-13.md', exists: false, note: null });
  const a = svc.appendDaily(v.id, { text: 'first' }, TOKEN);
  assert.deepEqual([a.created, a.path, a.date], [true, 'Daily/2026-10-13.md', '2026-10-13']);
  svc.appendDaily(v.id, { text: 'multi\nline entry', time: true }, TOKEN);
  svc.appendDaily(v.id, { text: 'no time', time: false }, UI);
  const note = svc.daily(v.id, '2026-10-13').note!;
  assert.equal(note.content, '- 06:30 first\n- 06:30 multi\n  line entry\n- no time\n');
  assert.throws(() => svc.daily(v.id, '2026-02-30'), reason('INVALID_INPUT'));
  assert.throws(() => svc.appendDaily(v.id, { text: '  ' }, UI), reason('INVALID_INPUT'));
  assert.throws(() => svc.appendDaily(v.id, { text: 'x', date: 'yesterday' }, UI), reason('INVALID_INPUT'));
  assert.equal(svc.appendDaily(v.id, { text: 'old day', date: '2026-01-01' }, UI).path, 'Daily/2026-01-01.md');
});

test('search: snippets, tag and folder filters, prefix, agent results capped at 50', async () => {
  const { svc } = await make();
  const v = svc.create({ name: 'Find', agents: 'write' });
  const vault = svc.vault(v.id);
  vault.writeNote('Projects/Alpha.md', '---\ntags: [work]\n---\nThe quick brown fox jumps over the lazy dog', { actor: UI, create: true });
  vault.writeNote('Journal/Note.md', 'quick thoughts about crème brûlée #food', { actor: UI, create: true });
  const r = svc.search(v.id, 'quick');
  assert.equal(r.total, 2);
  assert.ok(r.hits.every((h) => h.snippet && h.snippet.marks.length > 0));
  assert.equal(svc.search(v.id, 'creme brulee').hits[0]!.path, 'Journal/Note.md');
  assert.deepEqual(svc.search(v.id, 'quick', { tag: 'work' }).hits.map((h) => h.path), ['Projects/Alpha.md']);
  assert.deepEqual(svc.search(v.id, 'quick', { folder: 'Journal' }).hits.map((h) => h.path), ['Journal/Note.md']);
  assert.equal(svc.search(v.id, 'bro').hits.length, 1);
  assert.equal(svc.search(v.id, '').hits.length, 2);
  for (let i = 0; i < 60; i++) vault.writeNote(`Many/n${i}.md`, 'commonword here', { actor: UI, create: true });
  assert.equal(svc.search(v.id, 'commonword', { limit: 500 }, TOKEN).hits.length, 50);
  assert.equal(svc.search(v.id, 'commonword', { limit: 500 }, UI).hits.length, 60);
  assert.equal(svc.search(v.id, 'commonword', { limit: 500 }, UI).total, 60);
  assert.deepEqual(svc.quick(v.id, 'alp').map((h) => h.path), ['Projects/Alpha.md']);
});

test('import: an Obsidian vault zip keeps notes and attachments, skips .obsidian and the rest, and says so', async () => {
  const { svc } = await make();
  const report = await importZip(svc, fixtureZip({ wrapper: 'My Vault', extra: [{ name: 'My Vault/page.html', data: '<script>' }, { name: 'My Vault/x.weird', data: 'x' }, { name: 'My Vault/link', type: 'symlink', data: '/etc/passwd' }, { name: 'My Vault/__MACOSX/._Welcome.md', data: 'junk' }, { name: 'My Vault/Tricky/binary.md', data: Buffer.from([0xff, 0xfe, 0xfd]) }, { name: 'My Vault/case.md', data: 'a' }, { name: 'My Vault/Case.md', data: 'b' }] }), { filename: 'My Vault.zip', policy: 'keep-both', actor: UI });
  assert.equal(report.created, true);
  assert.equal(report.vaultName, 'My Vault');
  const kept = obsidianFixture().filter((f) => !f.path.startsWith('.'));
  const notes = kept.filter((f) => f.path.endsWith('.md')).length;
  assert.equal(report.notes, notes + 1, 'the fixture’s notes plus one of the case pair');
  assert.equal(report.attachments, 2);
  const skipped = Object.fromEntries(report.skipped.map((s) => [s.reason, s.count]));
  assert.equal(skipped.hidden, 5);
  assert.equal(skipped.dangerous, 1);
  assert.equal(skipped['not-allowed'], 1);
  assert.equal(skipped.symlink, 1);
  assert.equal(skipped.duplicate, 1);
  assert.equal(skipped['not-text'], 1);
  assert.ok(report.warnings.some((w) => /wrapper folder “My Vault”/.test(w)));
  assert.ok(report.warnings.some((w) => /Daily notes are in “Daily”/.test(w)));
  const id = report.vaultId;
  const sum = svc.summary(id);
  assert.equal(sum.dailyFolder, 'Daily');
  const vault = svc.vault(id);
  assert.equal(vault.index.get('.obsidian/app.json'), null);
  assert.equal(vault.index.get('Tricky/binary.md'), null);
  // Links and structure came through: aliases, headings, embeds, duplicates, entity links.
  const welcome = svc.getNote(id, 'Welcome.md');
  assert.deepEqual(welcome.aliases, ['Home', 'Start here']);
  assert.deepEqual(welcome.tags.sort(), ['nested/tag', 'welcome']);
  const byTarget = (p: string) => Object.fromEntries(svc.getNote(id, p).links.map((l) => [`${l.embed ? '!' : ''}${l.target}${l.heading ? `#${l.heading}` : ''}${l.block ? `#^${l.block}` : ''}`, l.to]));
  assert.deepEqual(byTarget('Welcome.md'), {
    'Projects/Alpha plan': 'Projects/Alpha plan.md',
    'Daily/2026-10-11': 'Daily/2026-10-11.md',
    Beta: 'Projects/Beta.md',
    '!Meeting notes#Decisions': 'Meeting notes.md',
    '!diagram.png': 'img/diagram.png',
    Alpha: null,
  });
  // Two notes are named "Meeting notes": a link from the Notes folder finds the one beside it, one from elsewhere the root one.
  const dup = svc.getNote(id, 'Notes/Other.md').links[0]!;
  assert.deepEqual([dup.to, dup.ambiguous], ['Notes/Meeting notes.md', true]);
});

test('import: the second brain keeps links honest: backlinks, unresolved, ambiguous, anchors, code, entities', async () => {
  const { svc } = await make();
  const { vaultId: id } = await importZip(svc, fixtureZip(), { filename: 'vault.zip', policy: 'skip', actor: UI });
  const health = svc.health(id);
  assert.deepEqual(health.unresolved.map((u) => u.target).sort(), ['Alpha', 'Does not exist']);
  assert.deepEqual(health.embeds.map((e) => e.target), ['missing.png']);
  assert.ok(health.duplicates.some((d) => d.name === 'meeting notes' && d.paths.length === 2));
  assert.ok(health.ambiguous.some((a) => a.target === 'Meeting notes'));
  assert.deepEqual(health.anchors, []);
  assert.deepEqual(svc.backlinks(id, 'Projects/Beta.md').map((b) => b.path).sort(), ['Projects/Alpha plan.md', 'Tricky/CRLF.md', 'Tricky/Code blocks.md', 'Tricky/Frontmatter invalid.md', 'Tricky/Table.md', 'Welcome.md']);
  const code = svc.getNote(id, 'Tricky/Code blocks.md');
  assert.deepEqual(code.links.map((l) => l.target), ['Beta']);
  assert.deepEqual(code.tags, []);
  const entities = svc.getNote(id, 'Tricky/Entities.md').links.map((l) => `${l.entity?.type}:${l.entity?.key}`);
  assert.deepEqual(entities, ['ticket:T-1', 'session:abc123', 'workspace:docker/dev']);
  assert.match(svc.getNote(id, 'Tricky/Frontmatter invalid.md').frontmatter.error ?? '', /Not valid YAML/);
  assert.equal(svc.getNote(id, 'Tricky/BOM.md').content.startsWith('---'), true);
  assert.deepEqual(svc.getNote(id, 'Tricky/BOM.md').tags, ['bom']);
  // Mentions: the note named "Beta" is mentioned, unlinked, nowhere here; "Alpha plan" is by alias text.
  assert.deepEqual(svc.tags(id, 'nested'), [{ tag: 'nested/tag', count: 1 }]);
  // Heading and block embeds resolve to the right text.
  assert.equal(svc.embed(id, 'Meeting notes.md', 'Decisions', null).text.trim(), '## Decisions\n\n- we decided to ship ^decision-1\n- and to wait');
  assert.equal(svc.embed(id, 'Meeting notes.md', null, 'decision-1').text, '- we decided to ship');
  assert.equal(svc.embed(id, 'Meeting notes.md', 'No such heading', null).text, '');
});

test('import: unsafe archives are refused whole, before anything is written', async () => {
  const { svc } = await make();
  const before = svc.list().length;
  const refuse = async (buf: Buffer, re: RegExp) => {
    await assert.rejects(importZip(svc, buf, { policy: 'skip', actor: UI }), (e: unknown) => re.test((e as Error).message));
    assert.equal(svc.list().length, before, 'no vault was made');
  };
  await refuse(makeZip([{ name: 'ok.md', data: 'fine' }, { name: '../evil.md', data: 'x' }]), /unsafe path/);
  await refuse(makeZip([{ name: 'a/../../evil.md', data: 'x' }]), /unsafe path/);
  await refuse(makeZip([{ name: '/abs.md', data: 'x' }]), /unsafe path/);
  await refuse(makeZip([{ name: 'a\\b.md', data: 'x' }]), /unsafe path/);
  await refuse(makeZip([{ name: 'C:/x.md', data: 'x' }]), /unsafe path/);
  await refuse(makeZip([{ name: '.obsidian/../../x.md', data: 'x' }]), /unsafe path/);
  await refuse(makeZip([{ name: 'a.md', data: 'x'.repeat(5_000_000) }]), /bomb/);
  await refuse(makeZip([{ name: 'a.md', data: 'hello', crc: 1 }]), /checksum/);
  await refuse(makeZip([{ name: 'a.md', data: 'hello', flags: 1 }]), /Encrypted/);
  await refuse(Buffer.from('definitely not a zip file, but long enough to look at'), /isn’t a zip/);
  await refuse(makeZip([{ name: '.obsidian/app.json', data: '{}' }, { name: 'x.html', data: '<b>' }]), /nothing to import/);
  await refuse(makeZip([]), /isn’t a zip|nothing to import/);
});

test('import: conflict policies into an existing vault; a name that is taken gets a number; export then import is identical', async () => {
  const { svc } = await make();
  const first = await importZip(svc, fixtureZip(), { filename: 'Vault.zip', policy: 'skip', actor: UI });
  const again = await importZip(svc, fixtureZip(), { filename: 'Vault.zip', policy: 'skip', actor: UI });
  assert.equal(again.vaultName, 'Vault (2)');
  const into = await importZip(svc, fixtureZip(), { into: first.vaultId, policy: 'skip', actor: UI });
  assert.equal(into.created, false);
  assert.equal(into.notes + into.attachments, 0);
  assert.equal(into.skippedExisting, first.notes + first.attachments);
  const both = await importZip(svc, fixtureZip(), { into: first.vaultId, policy: 'keep-both', actor: UI });
  assert.equal(both.renamed, first.notes + first.attachments);
  assert.ok(svc.vault(first.vaultId).index.get('Welcome (2).md'));
  const over = await importZip(svc, fixtureZip({ files: [{ path: 'Welcome.md', content: 'replaced' }] }), { into: first.vaultId, policy: 'overwrite', actor: UI });
  assert.equal(over.overwritten, 1);
  assert.equal(svc.getNote(first.vaultId, 'Welcome.md').content, 'replaced');
  // The original is in history: overwriting is recoverable.
  const hist = svc.history(first.vaultId, 'Welcome.md');
  assert.ok(hist.entries.some((e) => e.note === 'original'));

  // Round trip: export a vault, import that zip into a new one, compare every file.
  const { filename, chunks } = svc.exportZip(again.vaultId);
  assert.equal(filename, 'Vault (2).zip');
  const zip = Buffer.concat([...chunks]);
  const entries = openZip(zip, { packedBytes: 1e9, unpackedBytes: 1e9, files: 60_000, ratio: 100 });
  assert.ok(entries.every((e) => e.name.startsWith('Vault (2)/')));
  const copy = await importZip(svc, zip, { filename: 'Vault (2).zip', name: 'Copy', policy: 'skip', actor: UI });
  assert.deepEqual([copy.notes, copy.attachments], [again.notes, again.attachments]);
  assert.ok(copy.warnings.some((w) => /wrapper folder/.test(w)));
  const a = svc.vault(again.vaultId);
  const b = svc.vault(copy.vaultId);
  const all = [...a.exportEntries()];
  assert.ok(all.length > 20);
  for (const e of all) assert.deepEqual(readFileSync(join(b.root, e.name)), e.data, e.name);
  assert.deepEqual([...b.exportEntries()].map((e) => e.name), all.map((e) => e.name));
});

test('the index is rebuilt from the files: delete it, restart, and the answers are the same', async () => {
  const { svc, h, reopen } = await make();
  const { vaultId: id } = await importZip(svc, fixtureZip(), { filename: 'v.zip', policy: 'skip', actor: UI });
  const search = (s: KnowledgeService) => s.search(id, 'decided').hits.map((x) => x.path);
  const before = { s: search(svc), c: svc.summary(id).counts, t: svc.tags(id) };
  assert.ok(before.s.length > 0);
  svc.stop();
  for (const f of readdirSync(join(h.dir, 'knowledge', 'index'))) rmSync(join(h.dir, 'knowledge', 'index', f));
  const fresh = reopen();
  await fresh.rescan(id);
  assert.deepEqual(search(fresh), before.s);
  assert.deepEqual(fresh.summary(id).counts, before.c);
  assert.deepEqual(fresh.tags(id), before.t);
  fresh.stop();
});

test('upkeep: a zip of each changed vault is kept (last three), history stays within its caps', async () => {
  const { svc, h } = await make({ limits: { versionsPerNote: 5 } });
  const v = svc.create({ name: 'Backed up' });
  const vault = svc.vault(v.id);
  vault.writeNote('A.md', 'one', { actor: UI, create: true });
  vault.writeFile('img/a.png', Buffer.from([1, 2, 3]), { actor: UI });
  await svc.maintain();
  const dir = join(h.dir, 'backups');
  const zips = () => readdirSync(dir).filter((n) => n.startsWith(`knowledge-${v.id}-`) && n.endsWith('.zip'));
  assert.equal(zips().length, 1);
  const names = openZip(readFileSync(join(dir, zips()[0]!)), { packedBytes: 1e9, unpackedBytes: 1e9, files: 60_000, ratio: 100 }).map((e) => e.name);
  assert.deepEqual(names, ['A.md', 'img/a.png'], 'a backup zip is flat, so importing it makes a vault with the same layout');
  await svc.maintain();
  assert.equal(zips().length, 1, 'nothing changed: no new zip');
  for (let i = 0; i < 4; i++) {
    h.clock.now = new Date(h.clock.now.getTime() + 3_600_000);
    vault.writeNote('A.md', `edit ${i}`, { actor: UI, baseVersion: vault.readNote('A.md').version });
    // Upkeep compares the newest file time with the last zip's: make the edit newer than it.
    const t = new Date(Date.now() + (i + 1) * 10_000);
    utimesSync(join(vault.root, 'A.md'), t, t);
    await vault.scan();
    await svc.maintain();
  }
  assert.ok(zips().length <= 3);
  // Five edits an hour apart, capped at five versions kept per note.
  for (let i = 0; i < 8; i++) {
    h.clock.now = new Date(h.clock.now.getTime() + 3_600_000);
    vault.writeNote('A.md', `more ${i}`, { actor: UI, baseVersion: vault.readNote('A.md').version });
  }
  assert.equal(svc.history(v.id, 'A.md').entries.length, 5);
});
