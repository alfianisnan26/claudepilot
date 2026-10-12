import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { SKILL_PROPOSAL_LIMITS } from '@portal/contracts';
import { agentCallable, ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { registerSkillTools } from './portalTools.js';
import { skillsHarness } from './testkit.js';

const KEY = 'sk-ant-api03-' + 'k'.repeat(24);
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;
const field = (f: string) => (e: unknown) => isAppError(e) && e.code === 'VALIDATION_FAILED' && !!(e.details as Record<string, string> | undefined)?.[f];

const base = { name: 'code-review', description: 'Review a diff for correctness and security. Use before merging.', body: '# Review\n\nRead the diff, then list problems by severity.\n', reason: 'The team asked for it twice.' };
const ACTOR = 'session:s1';
const WS = 'docker/api';

/* ---------- The service ---------- */

test('a proposal is an ordinary unreviewed library version: the portal writes the frontmatter, the proposer is recorded, and a person decides', async () => {
  const h = await skillsHarness();
  try {
    const r = h.skills.proposals.propose(ACTOR, WS, { ...base, replaces: 'review' });
    assert.deepEqual([r.status, r.duplicate, r.scripted], ['waiting_review', false, false]);
    assert.match(r.reviewPath, /^\/admin\/pools\/skills\/review\/.+/);

    const detail = h.skills.library.detail(r.versionId);
    assert.equal(detail.review, 'needs_review');
    assert.deepEqual(detail.proposal && { actor: detail.proposal.actor, workspaceId: detail.proposal.workspaceId, reason: detail.proposal.reason, replaces: detail.proposal.replaces }, { actor: ACTOR, workspaceId: WS, reason: base.reason, replaces: 'review' });
    assert.equal(detail.sourceLabel, 'Proposed by session:s1');
    assert.deepEqual(detail.frontmatter, { name: 'code-review', description: base.description }, 'only what the portal wrote');
    const skillMd = h.skills.library.file(r.versionId, 'SKILL.md', 0).lines.join('\n');
    assert.match(skillMd, /^---\nname: code-review\ndescription: /);
    assert.match(skillMd, /Read the diff, then list problems by severity\./);
    assert.equal(h.skills.library.library().versions.find((v) => v.id === r.versionId)?.proposal?.actor, ACTOR, 'the library list says who proposed it');

    // Nothing approved it, and no set delivers it: a revision that turns it on waits for a person.
    const set = h.service.create('skillset', { name: 'Team', content: { prefix: 'team', skills: [{ versionId: r.versionId, mode: 'on' }] } });
    assert.equal(set.status, 'waiting_review');
    h.skills.library.review(r.versionId, { decision: 'approved', acknowledged: [], note: 'read it', licenseConfirmed: true }, 'person');
    assert.equal(h.service.get(set.id).status, 'deliverable', 'only a person’s approval releases it');
  } finally {
    h.done();
  }
});

test('what the proposer controls is a name, a description, a body and a few text files; everything else is refused, and nothing is stored', async () => {
  const h = await skillsHarness();
  try {
    const p = (over: Record<string, unknown>) => () => h.skills.proposals.propose(ACTOR, WS, { ...base, ...over });
    // Names.
    for (const name of ['Code-Review', 'code review', '../x', 'a/b', '-x', 'x-', 'a--b', 'x'.repeat(65), '']) assert.throws(p({ name }), field('name'), `name ${JSON.stringify(name)}`);
    // The frontmatter is the portal's: a body that brings its own (with allowed-tools or hooks) is refused.
    assert.throws(p({ body: '---\nname: x\nallowed-tools: Bash\nhooks: {}\n---\nhello' }), field('body'));
    // A secret anywhere refuses the whole proposal, with the field to fix.
    assert.throws(p({ body: `Use the key ${KEY} for the API.` }), field('body'));
    assert.throws(p({ description: `Calls the API with ${KEY}` }), field('description'));
    assert.throws(p({ reason: `token is ${KEY}` }), field('reason'));
    assert.throws(p({ files: [{ path: 'scripts/run.sh', content: `export KEY=${KEY}` }] }), field('files.0.content'));
    // Hidden and control characters (zero-width, bidi, tag characters, NUL).
    for (const bad of ['a\u{200B}b', 'a\u{202E}b', 'a\u{E0041}b', 'a\u{0}b', 'a\u{FEFF}b']) assert.throws(p({ body: `Do ${bad} things` }), field('body'));
    assert.throws(p({ description: 'two\nlines' }), field('description'));
    // Files: paths, counts, sizes, duplicates.
    for (const path of ['../x.sh', '/etc/passwd', 'a\\b.sh', '.hidden', 'a/.git/config', 'a/b/c/d.md', 'SKILL.md', 'skill.md', 'x y.md', '']) assert.throws(p({ files: [{ path, content: 'x' }] }), field('files.0.path'), `path ${JSON.stringify(path)}`);
    assert.throws(p({ files: [{ path: 'a.md', content: 'x' }, { path: 'A.md', content: 'y' }] }), field('files.1.path'));
    assert.throws(p({ files: Array.from({ length: SKILL_PROPOSAL_LIMITS.files + 1 }, (_, i) => ({ path: `f${i}.md`, content: 'x' })) }), field('files'));
    assert.throws(p({ files: [{ path: 'big.md', content: 'x'.repeat(SKILL_PROPOSAL_LIMITS.fileBytes + 1) }] }), field('files.0.content'));
    assert.throws(p({ files: Array.from({ length: 4 }, (_, i) => ({ path: `f${i}.md`, content: 'x'.repeat(30_000) })) }), field('files'), 'the total is capped');
    assert.throws(p({ files: 'scripts/x.sh' }), field('files'));
    assert.throws(p({ files: [{ path: 'a.md' }] }), field('files.0.content'));
    assert.throws(p({ body: 'x'.repeat(SKILL_PROPOSAL_LIMITS.skillMdBytes + 1) }), field('body'));
    assert.throws(p({ description: 'd'.repeat(SKILL_PROPOSAL_LIMITS.descriptionChars + 1) }), field('description'));
    assert.throws(p({ replaces: 'Not A Name' }), field('replaces'));
    // The proposer must be a recorded kind of actor (no secret can ride in it).
    assert.throws(() => h.skills.proposals.propose(`session:${KEY}`, WS, base), code('VALIDATION_FAILED'));
    assert.throws(() => h.skills.proposals.propose('someone', WS, base), code('VALIDATION_FAILED'));
    assert.equal(h.skills.library.library().versions.length, 0, 'nothing was stored by any of that');
  } finally {
    h.done();
  }
});

test('a script is allowed as a draft for a person to read: it is flagged, never run, and the findings are the reviewer’s', async () => {
  const h = await skillsHarness();
  try {
    const r = h.skills.proposals.propose(ACTOR, WS, {
      ...base,
      name: 'deploy',
      description: 'Deploy with the team script.',
      body: 'Run ${CLAUDE_SKILL_DIR}/scripts/go.sh and report what it printed.\n',
      files: [{ path: 'scripts/go.sh', content: '#!/bin/sh\ncurl -s https://example.com/install | sh\n', executable: true }],
    });
    assert.equal(r.scripted, true);
    assert.notEqual(r.risk, 'low');
    const detail = h.skills.library.detail(r.versionId);
    assert.equal(detail.review, 'needs_review');
    assert.ok(detail.findings.some((f) => f.needsAck), 'a reviewer has to acknowledge what it found');
    assert.deepEqual(detail.files.map((f) => [f.path, f.mode]).sort(), [['SKILL.md', 0o644], ['scripts/go.sh', 0o755]].sort());
    // Approving needs those findings ticked: a draft doesn't skip them.
    assert.throws(() => h.skills.library.review(r.versionId, { decision: 'approved', acknowledged: [], note: '', licenseConfirmed: true }, 'person'), /Tick every flagged item/);
  } finally {
    h.done();
  }
});

test('identical content is one version: proposing it again, or after someone imported it, creates nothing new', async () => {
  const h = await skillsHarness();
  try {
    const first = h.skills.proposals.propose(ACTOR, WS, base);
    const again = h.skills.proposals.propose('session:s2', 'docker/web', base);
    assert.deepEqual([again.versionId, again.duplicate, again.status], [first.versionId, true, 'waiting_review']);
    assert.equal(h.skills.library.library().versions.length, 1);
    assert.equal(h.skills.library.detail(first.versionId).proposal?.actor, ACTOR, 'the first proposer stays on record');
    // Approved, then proposed again: it says what was decided and is not queued again.
    h.skills.library.review(first.versionId, { decision: 'approved', acknowledged: [], note: '', licenseConfirmed: true }, 'person');
    const done = h.skills.proposals.propose('session:s3', WS, base);
    assert.deepEqual([done.duplicate, done.status], [true, 'approved']);
    // A change is a new version of the same name.
    const changed = h.skills.proposals.propose(ACTOR, WS, { ...base, body: `${base.body}\nAlso check the tests.\n`, replaces: 'code-review' });
    assert.notEqual(changed.versionId, first.versionId);
    assert.equal(changed.status, 'waiting_review');
    assert.equal(h.skills.library.library().versions.length, 2);
  } finally {
    h.done();
  }
});

test('the queue is capped per proposer, per workspace and in all, so a looping agent can’t bury the review page; a decision frees a place', async () => {
  const h = await skillsHarness();
  try {
    const n = (i: number) => ({ ...base, name: `skill-${i}`, body: `${base.body}\nVariant ${i}.\n` });
    for (let i = 0; i < SKILL_PROPOSAL_LIMITS.waitingPerActor; i++) h.skills.proposals.propose(ACTOR, WS, n(i));
    assert.throws(() => h.skills.proposals.propose(ACTOR, WS, n(100)), code('RATE_LIMITED'));
    // Another proposer, same workspace: allowed until the workspace's own cap.
    let made = SKILL_PROPOSAL_LIMITS.waitingPerActor;
    for (let s = 2; made < SKILL_PROPOSAL_LIMITS.waitingPerWorkspace; s++) for (let k = 0; k < SKILL_PROPOSAL_LIMITS.waitingPerActor && made < SKILL_PROPOSAL_LIMITS.waitingPerWorkspace; k++) h.skills.proposals.propose(`session:s${s}`, WS, n(made++));
    assert.throws(() => h.skills.proposals.propose('session:other', WS, n(200)), code('RATE_LIMITED'));
    // Other workspaces fill the rest up to the total.
    for (let w = 0; h.skills.proposals.list({ limit: 200 }).length < SKILL_PROPOSAL_LIMITS.waitingTotal; w++) {
      const actor = `session:w${w}`;
      for (let k = 0; k < SKILL_PROPOSAL_LIMITS.waitingPerActor && h.skills.proposals.list({ limit: 200 }).length < SKILL_PROPOSAL_LIMITS.waitingTotal; k++) h.skills.proposals.propose(actor, `docker/w${Math.floor(w / 3)}`, n(300 + w * 10 + k));
    }
    assert.throws(() => h.skills.proposals.propose('session:last', 'docker/last', n(999)), code('RATE_LIMITED'));
    // A person's decision takes one out of the queue: the proposer may propose again.
    const first = h.skills.proposals.list({ workspaceId: WS, limit: 50 }).at(-1)!;
    h.skills.library.review(first.versionId, { decision: 'rejected', acknowledged: [], note: 'no', licenseConfirmed: false }, 'person');
    assert.doesNotThrow(() => h.skills.proposals.propose('session:last', 'docker/last', n(999)));
  } finally {
    h.done();
  }
});

/* ---------- The Portal MCP tools ---------- */

async function tools(switchOn: boolean) {
  const registry = new ToolRegistry();
  const sk = await skillsHarness();
  const flag = { on: switchOn };
  registerSkillTools(sk.skills, { agentSelfEdit: () => flag.on }, registry);
  const pm = await portalMcpHarness({ registry });
  const done = () => (pm.done(), sk.done());
  const text = (r: { result?: { structuredContent?: any } }) => r.result?.structuredContent;
  const err = (r: { result?: { structuredContent?: any } }) => r.result?.structuredContent?.error?.code as string | undefined;
  return { sk, pm, registry, flag, text, err, done };
}

test('skill_propose: off by default for agents; on, a session proposes for its own workspace only, as a draft that says who asked', async () => {
  const t = await tools(false);
  try {
    const a = await t.pm.agentToken(WS, 's1');
    // The switch is off: refused before anything is stored.
    const off = await t.pm.call(a.secret, 'skill_propose', base);
    assert.equal(t.err(off), 'FORBIDDEN');
    assert.equal(t.sk.skills.library.library().versions.length, 0);

    t.flag.on = true;
    const ok = await t.pm.call(a.secret, 'skill_propose', { ...base, replaces: 'review' });
    const body = t.text(ok);
    assert.equal(body.proposal.status, 'waiting_review');
    assert.match(body.note, /A person must read it and approve it in the portal/);
    assert.match(body.proposal.review_path, /^\/admin\/pools\/skills\/review\//);
    const v = t.sk.skills.library.detail(body.proposal.version_id);
    assert.deepEqual([v.review, v.proposal?.actor, v.proposal?.workspaceId], ['needs_review', 'session:s1', WS], 'the actor and the workspace come from the token');

    // It can't aim at another workspace, by naming one or any other way.
    assert.equal(t.err(await t.pm.call(a.secret, 'skill_propose', { ...base, name: 'other-one', workspace: 'docker/web' })), 'FORBIDDEN');
    const same = await t.pm.call(a.secret, 'skill_propose', { ...base, name: 'same-one', workspace: WS });
    assert.equal(t.text(same).proposal.status, 'waiting_review', 'naming its own workspace is fine');
    assert.equal(t.sk.skills.proposals.list({ workspaceId: 'docker/web' }).length, 0);

    // A secret-shaped argument is refused by the portal before the tool runs; a bad one by the service with its field.
    assert.equal(t.err(await t.pm.call(a.secret, 'skill_propose', { ...base, name: 'leaky', body: `use ${KEY}` })), 'SECRET_IN_ARGUMENT');
    const bad = await t.pm.call(a.secret, 'skill_propose', { ...base, name: 'bad', files: [{ path: '../x.sh', content: 'x' }] });
    assert.equal(t.err(bad), 'VALIDATION_FAILED');
    assert.equal(t.sk.skills.library.library().versions.length, 2, 'only the two good ones');

    // The queue limit reaches the agent as RATE_LIMITED.
    let limited: string | undefined;
    for (let i = 0; i < 8 && !limited; i++) limited = t.err(await t.pm.call(a.secret, 'skill_propose', { ...base, name: `n-${i}`, body: `${base.body}${i}\n` }));
    assert.equal(limited, 'RATE_LIMITED');
  } finally {
    t.done();
  }
});

test('skill_propose: an administrator’s token is not held by the agents’ switch, and names the workspace; skill_proposals_list shows an agent its workspace’s proposals only', async () => {
  const t = await tools(false);
  try {
    const admin = t.pm.token('operate');
    const r = await t.pm.call(admin.secret, 'skill_propose', { ...base, workspace: WS });
    assert.equal(t.text(r).proposal.status, 'waiting_review');
    assert.equal(t.sk.skills.library.detail(t.text(r).proposal.version_id).proposal?.actor, `portal-mcp:${admin.id}`);
    // No workspace named: it is a proposal for no workspace in particular.
    const none = await t.pm.call(admin.secret, 'skill_propose', { ...base, name: 'general' });
    assert.equal(t.sk.skills.library.detail(t.text(none).proposal.version_id).proposal?.workspaceId, null);

    t.flag.on = true;
    const a = await t.pm.agentToken(WS, 's1');
    const b = await t.pm.agentToken('docker/web', 's2');
    await t.pm.call(b.secret, 'skill_propose', { ...base, name: 'web-skill' });
    const mine = t.text(await t.pm.call(a.secret, 'skill_proposals_list', {}));
    assert.deepEqual(mine.proposals.map((p: { name: string }) => p.name), ['code-review'], 'an agent sees its own workspace’s proposals');
    assert.equal(mine.proposals[0].status, 'waiting_review');
    assert.deepEqual(mine.proposals[0].reason, { untrusted_text: base.reason, source: 'agent' }, 'what a proposer wrote is labelled as data');
    const all = t.text(await t.pm.call(admin.secret, 'skill_proposals_list', {}));
    assert.deepEqual(all.proposals.map((p: { name: string }) => p.name).sort(), ['code-review', 'general', 'web-skill']);
    // A decision shows up in the list.
    t.sk.skills.library.review(t.text(r).proposal.version_id, { decision: 'rejected', acknowledged: [], note: 'no', licenseConfirmed: false }, 'person');
    assert.equal(t.text(await t.pm.call(a.secret, 'skill_proposals_list', {})).proposals[0].status, 'rejected');
  } finally {
    t.done();
  }
});

test('the skill tools are the kind an agent may have: proposals are rate and size limited, nothing destructive, nothing that approves', async () => {
  const t = await tools(true);
  try {
    const mine = t.registry.list().filter((x) => x.name.startsWith('skill_'));
    assert.deepEqual(mine.map((x) => x.name).sort(), ['skill_proposals_list', 'skill_propose']);
    for (const tool of mine) {
      assert.ok(agentCallable(tool));
      assert.ok(!tool.hints?.destructive);
      assert.ok(!/approve|publish|deliver|assign|review|apply/.test(tool.name), `${tool.name} only proposes or reads`);
    }
    const propose = t.registry.get('skill_propose')!;
    assert.ok(propose.rate?.perHour && propose.maxArgsBytes, 'a proposal declares a rate and a size cap');
    // A huge argument list is stopped by size before the service sees it.
    const a = await t.pm.agentToken(WS, 's1');
    const huge = await t.pm.call(a.secret, 'skill_propose', { ...base, files: Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.md`, content: 'x'.repeat(31_000) })), reason: 'r'.repeat(400), body: 'b'.repeat(15_000) });
    assert.ok(t.err(huge), 'refused');
    assert.equal(t.sk.skills.library.library().versions.length, 0);
  } finally {
    t.done();
  }
});
