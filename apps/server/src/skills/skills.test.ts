import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { SkillImportResult, SkillsetContentView, WorkspaceSkills } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { readZip } from './archive.js';
import { BlobStore } from './blobs.js';
import { createSkillRoutes } from './routes.js';
import { makeZip, skillItems, skillsHarness, WS, type ZipItem } from './testkit.js';

type Harness = Awaited<ReturnType<typeof skillsHarness>>;
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;

/** Imports a zip of items and returns the result. */
const upload = (h: Harness, items: ZipItem[], name = 'skills.zip'): SkillImportResult => h.skills.library.importUpload(readZip(makeZip(items)), name, name.replace(/\.zip$/, ''));
const idOf = (r: SkillImportResult, name: string) => r.skills.find((s) => s.name === name)!.versionId;
const approve = (h: Harness, versionId: string) => {
  const d = h.skills.library.detail(versionId);
  return h.skills.library.review(versionId, { decision: 'approved', acknowledged: d.findings.filter((f) => f.needsAck).map((f) => f.id), note: 'checked', licenseConfirmed: true }, 'sess');
};
const SCRIPTED: ZipItem[] = skillItems('deploy', {
  body: 'Run the helper: ${CLAUDE_SKILL_DIR}/scripts/go.sh\n',
  extra: [
    { name: 'deploy/scripts/go.sh', data: '#!/bin/sh\ncurl -s https://example.com/status\n', mode: 0o755 },
    { name: 'deploy/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]) },
  ],
});

test('import stores versions, files and blobs; identical content reuses its version and review', async () => {
  const h = await skillsHarness();
  try {
    const r = upload(h, [...skillItems('review'), ...SCRIPTED]);
    assert.deepEqual(r.skills.map((s) => [s.name, s.status, s.review, s.scripted]).sort(), [
      ['deploy', 'new', 'needs_review', true],
      ['review', 'new', 'needs_review', false],
    ]);
    const lib = h.skills.library.library();
    assert.equal(lib.toReview, 2);
    assert.equal(lib.sources.length, 1);
    const deploy = h.skills.library.detail(idOf(r, 'deploy'));
    assert.deepEqual(deploy.files.map((f) => [f.path, f.mode.toString(8), f.kind, f.binary]), [
      ['SKILL.md', '644', 'skill_md', false],
      ['logo.png', '644', 'asset', true],
      ['scripts/go.sh', '755', 'script', false],
    ]);
    // Blobs: content-addressed, 0600 files in 0700 folders under <data>/blobs/sha256/.
    const blob = (h.store.db!.prepare("SELECT blob_sha256 FROM skill_files WHERE path = 'scripts/go.sh'").get() as { blob_sha256: string }).blob_sha256;
    const path = join(h.dataDir, 'blobs', 'sha256', blob.slice(0, 2), blob);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(h.dataDir, 'blobs', 'sha256')).mode & 0o777, 0o700);
    // The same content again: the same version, no new source.
    approve(h, idOf(r, 'review'));
    const again = upload(h, skillItems('review'), 'again.zip');
    assert.deepEqual(again.skills.map((s) => [s.status, s.review, s.versionId]), [['existing', 'approved', idOf(r, 'review')]]);
    assert.equal(again.sourceId, null);
    // The file viewer: plain text pages, binary files as size only.
    assert.deepEqual(h.skills.library.file(idOf(r, 'deploy'), 'scripts/go.sh', 0).lines, ['#!/bin/sh', 'curl -s https://example.com/status', '']);
    assert.equal(h.skills.library.file(idOf(r, 'deploy'), 'logo.png', 0).binary, true);
    assert.throws(() => h.skills.library.file(idOf(r, 'deploy'), '../../etc/passwd', 0), code('NOT_FOUND'));
    // Nothing usable: a validation error, not an empty source.
    assert.throws(() => upload(h, [{ name: 'readme.txt', data: 'hi' }]), code('VALIDATION_FAILED'));
  } finally {
    h.done();
  }
});

test('review: High findings need every tick and a note, credentials can’t be approved, licenses need confirming, revoked stays revoked', async () => {
  const h = await skillsHarness();
  try {
    const r = upload(h, [...SCRIPTED, ...skillItems('leaky', { body: 'Use sk-ant-api03-zzzzzzzzzzzzzzzz to call it.\n' }), ...skillItems('closed', { frontmatter: 'name: closed\ndescription: Closed\nlicense: Proprietary\n' })]);
    const lib = h.skills.library;
    const deploy = lib.detail(idOf(r, 'deploy'));
    const flagged = deploy.findings.filter((f) => f.needsAck).map((f) => f.id);
    assert.ok(flagged.length >= 2);
    assert.throws(() => lib.review(deploy.id, { decision: 'approved', acknowledged: flagged.slice(1), note: 'x' }, null), code('VALIDATION_FAILED'));
    assert.throws(() => lib.review(deploy.id, { decision: 'approved', acknowledged: flagged }, null), code('VALIDATION_FAILED'));
    assert.equal(lib.review(deploy.id, { decision: 'approved', acknowledged: flagged, note: 'Read go.sh: echoes only.' }, 'abc').review, 'approved');
    assert.deepEqual(lib.detail(deploy.id).reviews[0], { decision: 'approved', note: 'Read go.sh: echoes only.', acknowledged: flagged, licenseConfirmed: false, session: 'abc', at: lib.detail(deploy.id).reviews[0]!.at });
    assert.throws(() => lib.review(idOf(r, 'leaky'), { decision: 'approved', acknowledged: [], note: 'x', licenseConfirmed: true }, null), code('CONFLICT'));
    assert.throws(() => lib.review(idOf(r, 'closed'), { decision: 'approved' }, null), code('VALIDATION_FAILED'));
    assert.equal(lib.review(idOf(r, 'closed'), { decision: 'approved', licenseConfirmed: true }, null).review, 'approved');
    // Reject needs a note; an approved version is revoked, not rejected; revoked is final.
    assert.throws(() => lib.review(idOf(r, 'leaky'), { decision: 'rejected' }, null), code('VALIDATION_FAILED'));
    assert.equal(lib.review(idOf(r, 'leaky'), { decision: 'rejected', note: 'Has a key.' }, null).review, 'rejected');
    assert.throws(() => lib.review(deploy.id, { decision: 'rejected', note: 'x' }, null), code('CONFLICT'));
    assert.throws(() => lib.revoke(idOf(r, 'leaky'), 'x', null), code('CONFLICT'));
    assert.throws(() => lib.revoke(deploy.id, '', null), code('VALIDATION_FAILED'));
    assert.equal(lib.revoke(deploy.id, 'Compromised upstream.', null).review, 'revoked');
    assert.throws(() => lib.review(deploy.id, { decision: 'approved', acknowledged: flagged, note: 'again' }, null), code('CONFLICT'));
    // Stored text never keeps a credential.
    assert.ok(!JSON.stringify(h.store.db!.prepare('SELECT * FROM skill_versions').all()).includes('zzzzzzzzzzzzzzzz'));
  } finally {
    h.done();
  }
});

test('skillsets: prefix rules and uniqueness, unique names, review status, release on approval, duplicate gets a new prefix', async () => {
  const h = await skillsHarness();
  try {
    const r = upload(h, [...skillItems('review'), ...skillItems('lint'), ...skillItems('other/review', { name: 'review', description: 'Another review' })]);
    const [review, lint] = [idOf(r, 'review'), idOf(r, 'lint')];
    const otherReview = r.skills.filter((s) => s.name === 'review')[1]!.versionId;
    let n = 0;
    const create = (prefix: string, skills: unknown[]) => h.service.create('skillset', { name: `Set ${++n}`, content: { prefix, skills } });
    for (const bad of ['', 'Has Caps', 'claude-tools', 'cpm-x', 'cpb-x', 'cpp-x', 'anthropic', 'a--b'])
      assert.throws(() => create(bad, []), (e: unknown) => isAppError(e) && e.code === 'VALIDATION_FAILED' && !!(e.details as Record<string, string>).prefix, bad);
    assert.throws(() => create('frontend', [{ versionId: review }, { versionId: otherReview }]), /unique/);
    const set = create('frontend', [{ versionId: review, mode: 'on' }, { versionId: lint, mode: 'manual' }]);
    assert.equal(set.status, 'waiting_review');
    assert.equal(set.revision, 0);
    assert.throws(() => create('frontend', []), /already uses \/frontend:/);
    assert.throws(() => h.service.approve(set.id, 1), /Approve review, lint in the Library first/);
    approve(h, review);
    assert.equal(h.service.get(set.id).revision, 0, 'still waits for lint');
    approve(h, lint);
    const released = h.service.get(set.id);
    assert.equal(released.revision, 1);
    assert.equal(released.status, 'deliverable');
    // Turning a skill off never waits; turning on an unapproved one does.
    const r2 = upload(h, skillItems('fresh'));
    const off = h.service.update(set.id, { content: { prefix: 'frontend', skills: [{ versionId: review, mode: 'on' }] } });
    assert.equal(off.revision, 2);
    const on = h.service.update(set.id, { content: { prefix: 'frontend', skills: [{ versionId: review }, { versionId: idOf(r2, 'fresh') }] } });
    assert.equal(on.status, 'waiting_review');
    assert.equal(on.revision, 2);
    const view = on.content as SkillsetContentView;
    assert.deepEqual(view.skills.map((s) => [s.name, s.mode, s.review]), [
      ['review', 'on', 'approved'],
      ['fresh', 'on', 'needs_review'],
    ]);
    // Duplicate: same skills, a prefix of its own from the new name.
    const copy = h.service.duplicate(set.id, 'Frontend Two');
    assert.equal((copy.content as SkillsetContentView).prefix, 'frontend-two');
    // Revoked or rejected versions can only be Off.
    h.skills.library.revoke(review, 'bad', null);
    assert.throws(() => h.service.update(set.id, { content: { prefix: 'frontend', skills: [{ versionId: review }] } }), /revoked/);
    assert.equal(h.service.update(set.id, { content: { prefix: 'frontend', skills: [{ versionId: review, mode: 'off' }] } }).status, 'deliverable');
  } finally {
    h.done();
  }
});

test('delivery: one plugin per set with transforms, enabledPlugins, binary assets byte for byte, and the version gate', async () => {
  const h = await skillsHarness();
  try {
    const r = upload(h, [
      ...SCRIPTED,
      ...skillItems('quiet', { frontmatter: 'name: quiet\ndescription: Quiet one\nlicense: MIT\nuser-invocable: false\nallowed-tools: Bash(ls *)\n' }),
      ...skillItems('folder-name', { name: 'renamed-in-frontmatter' }),
    ]);
    for (const s of r.skills) approve(h, s.versionId);
    const set = h.service.create('skillset', {
      name: 'Ops',
      content: { prefix: 'ops', skills: [{ versionId: idOf(r, 'deploy') }, { versionId: idOf(r, 'quiet'), mode: 'manual', stripAllowedTools: true }, { versionId: idOf(r, 'renamed-in-frontmatter') }] },
    });
    h.service.setAssignments(WS, 'skillset', [{ poolId: set.id }]);
    await h.run();
    assert.equal(h.row()?.status, 'synced', h.row()?.reason ?? '');
    const [folder] = h.ws.folders('ops');
    assert.ok(folder, 'a version folder');
    const root = `/etc/claudepilot/marketplace/plugins/ops/${folder}`;
    assert.deepEqual(h.ws.dropIn(), { enabledPlugins: { 'ops@claudepilot': true } });
    assert.deepEqual(h.ws.catalog().plugins.map((p) => [p.name, p.source]), [['ops', `./plugins/ops/${folder}`]]);
    assert.match(h.ws.catalog().plugins[0]!.version, /^1\.0\.0\+[0-9a-f]{8}$/);
    assert.equal(h.ws.files.get(`${root}/skills/deploy/scripts/go.sh`)!.mode, 0o755);
    assert.equal(h.ws.files.get(`${root}/skills/deploy/SKILL.md`)!.mode, 0o644);
    assert.deepEqual([...h.ws.files.get(`${root}/skills/deploy/logo.png`)!.bytes!].slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
    const quiet = h.ws.files.get(`${root}/skills/quiet/SKILL.md`)!.content;
    assert.match(quiet, /disable-model-invocation: true/);
    assert.doesNotMatch(quiet, /user-invocable|allowed-tools/);
    assert.match(h.ws.files.get(`${root}/skills/renamed-in-frontmatter/SKILL.md`)!.content, /^---\nname: renamed-in-frontmatter\n/);
    // The tree-hash drift check sees binary files as they are: a start reconcile rewrites nothing.
    const before = h.row()!.generation;
    await h.run('started');
    assert.equal(h.row()!.generation, before);
    // Preview shows binary files as a placeholder.
    const preview = h.service.preview('skillset', set.id, {});
    assert.match(preview.files.find((f) => f.path.endsWith('logo.png'))!.content, /binary file/);
  } finally {
    h.done();
  }
  // Below the version gate the fragment is left out, and the Skills row says why.
  const old = await skillsHarness({ minClaudeVersion: '9.0.0' });
  try {
    const r = upload(old, skillItems('review'));
    approve(old, idOf(r, 'review'));
    const set = old.service.create('skillset', { name: 'S', content: { prefix: 'gate', skills: [{ versionId: idOf(r, 'review') }] } });
    old.service.setAssignments(WS, 'skillset', [{ poolId: set.id }]);
    await old.run();
    assert.equal(old.row()?.status, 'synced');
    assert.match(old.row()?.reason ?? '', /Needs Claude Code 9\.0\.0 or newer/);
    assert.equal(old.ws.dropIn(), null);
    assert.deepEqual(old.ws.folders('gate'), []);
    const row = old.skills.workspace(WS);
    assert.equal(row.tooOld, true);
    assert.match(row.sets[0]!.message ?? '', /too old for skillsets/);
  } finally {
    old.done();
  }
});

test('revocation: recompiles without the version, deletes every folder holding it at once (pinned too), denies it 14 days', async () => {
  const h = await skillsHarness();
  try {
    const r = upload(h, [...skillItems('review'), ...skillItems('lint')]);
    approve(h, idOf(r, 'review'));
    approve(h, idOf(r, 'lint'));
    const set = h.service.create('skillset', { name: 'Front', content: { prefix: 'front', skills: [{ versionId: idOf(r, 'review') }] } });
    h.service.setAssignments(WS, 'skillset', [{ poolId: set.id }]);
    await h.run();
    const [r1] = h.ws.folders('front');
    // r2 adds lint; r1's folder is retained for sessions that loaded it.
    h.service.update(set.id, { content: { prefix: 'front', skills: [{ versionId: idOf(r, 'review') }, { versionId: idOf(r, 'lint') }] } });
    await h.run();
    const folders = h.ws.folders('front');
    assert.equal(folders.length, 2);
    // Pin the workspace to r2: revocation ignores pins.
    h.service.setAssignments(WS, 'skillset', [{ poolId: set.id, pinnedRevision: 2 }]);
    await h.run();
    h.skills.library.revoke(idOf(r, 'review'), 'Compromised.', null);
    await h.run();
    const now = h.ws.folders('front');
    assert.equal(now.length, 1);
    assert.ok(!now.includes(r1!) && !folders.includes(now[0]!), 'both folders with the revoked version are gone, a new one holds lint only');
    assert.deepEqual([...h.ws.files.keys()].filter((k) => k.includes('/skills/review/')), []);
    assert.ok([...h.ws.files.keys()].some((k) => k.endsWith(`/front/${now[0]}/skills/lint/SKILL.md`)));
    assert.deepEqual(h.ws.dropIn(), { enabledPlugins: { 'front@claudepilot': true }, permissions: { deny: ['Skill(front:review *)', 'Skill(front:review)'] } });
    const row = h.skills.workspace(WS);
    assert.deepEqual(row.sets[0]!.blocked.map((b) => b.command), ['/front:review']);
    assert.deepEqual(row.sets[0]!.skills.map((s) => s.command), ['/front:lint']);
    // Unassigning: the plugin stays switched off until its folders are gone.
    h.service.setAssignments(WS, 'skillset', []);
    await h.run();
    assert.deepEqual(h.ws.dropIn(), { enabledPlugins: { 'front@claudepilot': false } });
  } finally {
    h.done();
  }
});

test('verification: Verified, Not verified before a session, Mismatch after a retry, Load error, and FR23 pause', async () => {
  const h = await skillsHarness();
  try {
    const r = upload(h, [...skillItems('review'), ...skillItems('lint')]);
    approve(h, idOf(r, 'review'));
    approve(h, idOf(r, 'lint'));
    const set = h.service.create('skillset', { name: 'Front', content: { prefix: 'front', skills: [{ versionId: idOf(r, 'review') }, { versionId: idOf(r, 'lint') }] } });
    h.ws.state.claude.unregistered = true;
    h.service.setAssignments(WS, 'skillset', [{ poolId: set.id }]);
    await h.run();
    let row: WorkspaceSkills = h.skills.workspace(WS);
    assert.equal(row.verification?.status, 'not_verified');
    assert.match(row.verification?.detail ?? '', /No Claude Code session/);
    h.ws.state.claude.unregistered = false;
    await h.skills.verifier.verify(WS);
    row = h.skills.workspace(WS);
    assert.equal(row.verification?.status, 'verified');
    assert.deepEqual(row.sets.map((s) => [s.status, s.revision, s.skills.map((x) => x.command)]), [['verified', 1, ['/front:review', '/front:lint']]]);
    // A mismatch is retried once before it's reported.
    h.ws.state.claude.details = { front: ['review'] };
    await h.skills.verifier.verify(WS);
    assert.equal(h.skills.workspace(WS).verification?.status, 'verified');
    await h.skills.verifier.verify(WS);
    row = h.skills.workspace(WS);
    assert.equal(row.verification?.status, 'mismatch');
    assert.match(row.sets[0]!.message ?? '', /lists 1 skill \(review\); 2 expected/);
    delete h.ws.state.claude.details;
    // A load error is reported at once; with 2 workspaces failing the rollout pauses (FR23).
    h.ws.state.claude.errors = { 'front@claudepilot': ['Plugin directory not found at path: /x.'] };
    await h.skills.verifier.verify(WS);
    row = h.skills.workspace(WS);
    assert.equal(row.sets[0]!.status, 'error');
    assert.match(row.sets[0]!.message ?? '', /Plugin directory not found/);
    assert.equal(h.service.get(set.id).rolloutPaused, null, 'one workspace is below the threshold');
    h.store.db!.prepare("INSERT INTO skill_inventory (workspace_id, status, plugins) VALUES ('docker/ws2', 'error', ?)").run(JSON.stringify([{ poolId: set.id, revision: 1, prefix: 'front', status: 'error' }]));
    await h.skills.verifier.verify(WS);
    assert.match(h.service.get(set.id).rolloutPaused?.reason ?? '', /Load error on 2 workspaces/);
    // Timeouts: retried once, then Not verified.
    delete h.ws.state.claude.errors;
    h.ws.state.claude.hang = true;
    await h.skills.verifier.verify(WS);
    await h.skills.verifier.verify(WS);
    assert.match(h.skills.workspace(WS).verification?.detail ?? '', /timed out/);
    // A stopped workspace is Not verified until it starts.
    h.ws.state.claude.hang = false;
    h.ws.state.running = false;
    await h.skills.verifier.verify(WS);
    assert.match(h.skills.workspace(WS).verification?.detail ?? '', /stopped/);
    const events = h.store.db!.prepare("SELECT details FROM delivery_events WHERE kind = 'skills_verified'").all() as { details: string }[];
    assert.ok(events.length >= 3 && events.every((e) => !e.details.includes('SKILL')));
  } finally {
    h.done();
  }
});

test('sources: remove keeps versions; remove with versions is refused while a set lists one', async () => {
  const h = await skillsHarness();
  try {
    const r = upload(h, skillItems('review'));
    approve(h, idOf(r, 'review'));
    const set = h.service.create('skillset', { name: 'S', content: { prefix: 's', skills: [{ versionId: idOf(r, 'review') }] } });
    assert.throws(() => h.skills.library.removeSource(r.sourceId!, true), /in a skillset/);
    h.skills.library.removeSource(r.sourceId!, false);
    assert.equal(h.skills.library.library().sources.length, 0);
    assert.equal(h.skills.library.library().versions.length, 1);
    h.service.delete(set.id);
    h.skills.library.removeSource(r.sourceId!, true);
    assert.equal(h.skills.library.library().versions.length, 0);
  } finally {
    h.done();
  }
});

test('blob store: unreferenced blobs go after the TTL; damaged ones read as missing', async () => {
  const h = await skillsHarness();
  try {
    let now = new Date('2026-01-01T00:00:00Z');
    const blobs = new BlobStore(h.store, { ttlMs: 1000, now: () => now });
    const keep = blobs.put(Buffer.from('keep'));
    const drop = blobs.put(Buffer.from('drop'));
    blobs.addSource(() => [keep]);
    assert.deepEqual(blobs.collect(), { deleted: 0, kept: 2 });
    now = new Date(now.getTime() + 2000);
    assert.deepEqual(blobs.collect(), { deleted: 1, kept: 1 });
    assert.equal(blobs.get(drop), null);
    assert.equal(blobs.get(keep)?.toString(), 'keep');
    assert.equal(existsSync(join(blobs.root, drop.slice(0, 2), drop)), false);
  } finally {
    h.done();
  }
});

test('routes: zip and folder uploads, reviews by session, a workspace’s skills', async () => {
  const h = await skillsHarness();
  try {
    const app = new Hono<{ Variables: { token: string } }>();
    app.use(async (c, next) => {
      c.set('token', 'session-token');
      await next();
    });
    app.onError((e, c) => (isAppError(e) ? c.json(e.toJSON(), e.status as ContentfulStatusCode) : c.json({ error: String(e) }, 500)));
    app.route('/', createSkillRoutes(h.skills));
    const zip = makeZip(skillItems('review'));
    let res = await app.request('/import?name=team.zip', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip });
    assert.equal(res.status, 201);
    const imported = ((await res.json()) as { data: SkillImportResult }).data;
    assert.equal(imported.skills[0]!.name, 'review');
    const form = new FormData();
    form.append('paths', JSON.stringify(['tools/SKILL.md', 'tools/notes.md']));
    form.append('files', new Blob(['---\nname: tools\ndescription: Tools\nlicense: MIT\n---\nUse them.\n']), 'SKILL.md');
    form.append('files', new Blob(['notes']), 'notes.md');
    res = await app.request('/import', { method: 'POST', body: form });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as { data: SkillImportResult }).data.skills[0]!.name, 'tools');
    res = await app.request('/import', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(res.status, 415);
    res = await app.request('/import?name=x.zip', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: makeZip([{ name: '../x', data: 'x' }]) });
    assert.equal(res.status, 422);
    res = await app.request(`/versions/${imported.skills[0]!.versionId}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }) });
    assert.equal(res.status, 200);
    const reviewed = ((await res.json()) as { data: { reviews: { session: string | null }[] } }).data;
    assert.match(reviewed.reviews[0]!.session ?? '', /^[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(reviewed).includes('session-token'));
    res = await app.request(`/workspaces/docker/ws1`);
    assert.deepEqual(((await res.json()) as { data: WorkspaceSkills }).data.sets, []);
  } finally {
    h.done();
  }
});
