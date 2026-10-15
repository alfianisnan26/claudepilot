import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { ContextContent, PersonaContent, PoolSummary } from '@portal/contracts';
import { emptyPersona } from '@portal/contracts';
import { compile } from '../delivery/compile.js';
import { FOUNDATION, Reconciler, type FragmentProvider } from '../delivery/reconciler.js';
import { memoryWorkspace } from '../secrets/testkit.js';
import { PoolService } from '../pools/service.js';
import { parseSkillMd } from '../skills/frontmatter.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { Personas } from './index.js';

const WS = 'docker/ws1';
const DROP_IN = '/etc/claude-code/managed-settings.d/50-claudepilot-persona.json';
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;
const field = (f: string, re?: RegExp) => (e: unknown) => isAppError(e) && !!(e.details as Record<string, string> | undefined)?.[f] && (!re || re.test(String((e.details as Record<string, string>)[f])));

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-personas-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const pools = new PoolService(store, { providers });
  const personas = new Personas(store, pools);
  const requests: string[] = [];
  pools.reconciler = { request: (id: string) => (requests.push(id), Promise.resolve()) };
  const ws = memoryWorkspace();
  const reconciler = new Reconciler(store, () => ws.runtime, () => [ws.runtime], providers);
  /** What the real compiler makes of this workspace's assignments, ownership checks included. */
  const compiled = () => {
    const now = new Date();
    const fragments = providers.flatMap((p) => p.fragments(WS, { running: true, now }));
    return compile({ portalId: 'p', generation: 1, fragments: [FOUNDATION, ...fragments], claudeVersion: '2.1.296 (Claude Code)', now });
  };
  const file = (path: string) => compiled().files.find((f) => f.path === path)?.content;
  const publish = (p: PoolSummary) => pools.approve(p.id, p.latestRevision);
  const done = () => (reconciler.stop(), store.close(), rmSync(dataDir, { recursive: true, force: true }));
  return { store, pools, personas, providers, reconciler, ws, requests, compiled, file, publish, done };
}
type H = Awaited<ReturnType<typeof setup>>;

const persona = (over: Partial<PersonaContent> = {}): PersonaContent => ({ ...emptyPersona(), ...over });
const create = (h: H, name: string, content: Partial<PersonaContent>, draft = false) => h.pools.create('persona', { name, content: persona(content), draft });

/* ---------- Content ---------- */

test('FR1–FR5: instructions, styles, subagents, model and effort are validated and kept as written', async () => {
  const h = await setup();
  try {
    const p = create(h, 'Reviewer', {
      instructions: '# Role\r\nReview security first.\r\n\r\n',
      styles: [{ name: 'Terse', description: 'Short answers', keepCodingInstructions: true, body: 'At most two sentences.' }],
      defaultStyle: 'Terse',
      agents: [{ name: 'security-reviewer', description: 'Reviews a diff for security problems', prompt: 'You review diffs.', tools: ['Read', 'Grep', 'Bash(npm test:*)'], disallowedTools: ['Write'], model: 'inherit', effort: 'high', maxTurns: 8 }],
      model: 'sonnet',
      effort: 'xhigh',
    });
    const c = p.content as PersonaContent;
    assert.equal(c.instructions, '# Role\nReview security first.', 'line endings are normalized, trailing blank space dropped');
    assert.deepEqual([c.defaultStyle, c.model, c.effort], ['Terse', 'sonnet', 'xhigh']);
    assert.deepEqual(c.agents[0]!.tools, ['Read', 'Grep', 'Bash(npm test:*)']);
    // An empty persona is valid and changes nothing.
    assert.doesNotThrow(() => create(h, 'Empty', {}));
  } finally {
    h.done();
  }
});

test('validation: names, limits, the default style, models and efforts, with the field to fix', async () => {
  const h = await setup();
  try {
    const bad = (content: Partial<PersonaContent> & Record<string, unknown>, where: string, re?: RegExp) => assert.throws(() => create(h, `n${Math.random()}`, content), field(where, re));
    bad({ instructions: 'x'.repeat(100 * 1024 + 1) }, 'instructions', /at most 100 KB/);
    bad({ chatPrompt: 'x'.repeat(32 * 1024 + 1) }, 'chatPrompt', /at most 32 KB/);
    bad({ instructions: 'a\u0000b' }, 'instructions', /control/);
    bad({ instructions: 'hide\u{202e} this' }, 'instructions', /invisible/);
    const style = (name: string, extra: object = {}) => ({ name, description: 'd', keepCodingInstructions: true, body: 'b', ...extra });
    bad({ styles: [style('1bad')] }, 'styles.0.name', /starting with a letter/);
    bad({ styles: [style('has space')] }, 'styles.0.name');
    bad({ styles: [style('A'), style('a')] }, 'styles.1.name', /used twice/);
    bad({ styles: Array.from({ length: 6 }, (_, i) => style(`s${i}`)) }, 'styles', /at most 5/);
    bad({ styles: [style('a', { description: 'two\nlines' })] }, 'styles.0.description', /one line/);
    bad({ styles: [style('a')], defaultStyle: 'missing' }, 'defaultStyle', /one of the persona’s styles/);
    const agent = (extra: object = {}) => ({ name: 'helper', description: 'Helps', prompt: 'Help.', tools: [], disallowedTools: [], model: '', effort: null, maxTurns: null, ...extra });
    bad({ agents: [agent({ name: 'Helper' })] }, 'agents.0.name', /lowercase/);
    bad({ agents: [agent(), agent()] }, 'agents.1.name', /used twice/);
    bad({ agents: [agent({ description: '' })] }, 'agents.0.description', /Fill this in/);
    bad({ agents: [agent({ prompt: '' })] }, 'agents.0.prompt', /prompt/);
    bad({ agents: [agent({ tools: ['Read Write'] })] }, 'agents.0.tools', /isn’t a tool name/);
    bad({ agents: [agent({ maxTurns: 0 })] }, 'agents.0.maxTurns');
    bad({ agents: [agent({ effort: 'max' })] }, 'agents.0.effort', /low, medium, high or xhigh/);
    bad({ agents: Array.from({ length: 21 }, (_, i) => agent({ name: `a${i}` })) }, 'agents', /at most 20/);
    bad({ model: 'not a model!' }, 'model', /alias/);
    bad({ model: 'inherit' }, 'model');
    bad({ effort: 'max' as never }, 'effort');
    bad({ contexts: ['nope'] }, 'contexts', /no longer exists/);
    // Subagents carry nothing but what FR4 lists: `permissionMode`, `hooks` and `mcpServers` are simply never written.
    const p = create(h, 'Carrier', { agents: [agent({ permissionMode: 'bypassPermissions', hooks: { x: 1 }, mcpServers: {} } as never)] });
    h.pools.setAssignments(WS, 'persona', []);
    void p;
  } finally {
    h.done();
  }
});

test('FR8: credential-shaped text is refused wherever it could go, so a persona never carries a secret', async () => {
  const h = await setup();
  try {
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
    const bad = (content: Partial<PersonaContent> & Record<string, unknown>, where: string) => assert.throws(() => create(h, `n${Math.random()}`, content), field(where, /looks like a secret/));
    bad({ instructions: `Use ${token} to push` }, 'instructions');
    bad({ chatPrompt: `key: ${token}` }, 'chatPrompt');
    bad({ styles: [{ name: 'a', description: 'd', keepCodingInstructions: true, body: `Bearer ${token}${token}` }] }, 'styles.0.body');
    bad({ styles: [{ name: 'a', description: `with ${token}`, keepCodingInstructions: true, body: 'b' }] }, 'styles.0.description');
    bad({ agents: [{ name: 'a', description: 'd', prompt: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----', tools: [], disallowedTools: [], model: '', effort: null, maxTurns: null }] }, 'agents.0.prompt');
    bad({ instructions: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }, 'instructions');
    assert.throws(() => h.pools.create('context', { name: 'Leaky', content: { body: `token ${token}` } }), field('body', /looks like a secret/));
  } finally {
    h.done();
  }
});

/* ---------- Drafts, publishing and assignment ---------- */

test('FR10, FR14: a save can be a draft; only a published persona can be assigned; publishing makes it current', async () => {
  const h = await setup();
  try {
    const draft = create(h, 'Reviewer', { instructions: 'Be careful.' }, true);
    assert.deepEqual([draft.status, draft.revision, draft.latestRevision], ['draft', 0, 1]);
    assert.throws(() => h.pools.setAssignments(WS, 'persona', [{ poolId: draft.id }]), (e) => code('CONFLICT')(e) && /hasn’t been published yet/.test((e as Error).message));
    assert.throws(() => h.pools.assignToMany(draft.id, [WS]), code('CONFLICT'));
    assert.deepEqual(h.pools.checkAddOns({}), {});

    const published = h.publish(draft);
    assert.deepEqual([published.status, published.revision], ['deliverable', 1]);
    h.pools.setAssignments(WS, 'persona', [{ poolId: draft.id }]);
    assert.equal(h.file('/etc/claude-code/CLAUDE.md'), 'Be careful.\n');

    // A new draft changes nothing until it's published; then workspaces following it get it.
    const next = h.pools.update(draft.id, { content: persona({ instructions: 'Be very careful.' }), draft: true, note: 'second' });
    assert.deepEqual([next.revision, next.latestRevision, next.status], [1, 2, 'draft']);
    assert.equal(h.file('/etc/claude-code/CLAUDE.md'), 'Be careful.\n');
    h.requests.length = 0;
    h.publish(next);
    assert.equal(h.file('/etc/claude-code/CLAUDE.md'), 'Be very careful.\n');
    assert.deepEqual(h.requests, [WS], 'the workspace following it is asked to deliver');
  } finally {
    h.done();
  }
});

test('one persona per workspace: setting two is refused, bulk assignment and the picker swap it with a removal record', async () => {
  const h = await setup();
  try {
    const a = create(h, 'A', { instructions: 'Role A.' });
    const b = create(h, 'B', { instructions: 'Role B.' });
    assert.throws(() => h.pools.setAssignments(WS, 'persona', [{ poolId: a.id }, { poolId: b.id }]), code('VALIDATION_FAILED'));
    h.pools.setAssignments(WS, 'persona', [{ poolId: a.id }]);
    const r = h.pools.assignToMany(b.id, [WS, 'docker/ws2']);
    assert.deepEqual([r.assigned, r.replaced], [[WS, 'docker/ws2'], [WS]]);
    assert.equal(h.file('/etc/claude-code/CLAUDE.md'), 'Role B.\n');
    assert.deepEqual(h.pools.assignmentsFor(WS).filter((x) => x.type === 'persona').map((x) => [x.poolName, x.state]), [['B', 'assigned'], ['A', 'removing']]);
  } finally {
    h.done();
  }
});

/* ---------- Delivery ---------- */

test('§10.1: what a persona writes, and only that: managed CLAUDE.md, styles, subagents, the chat prompt and its drop-in', async () => {
  const h = await setup();
  try {
    const p = create(h, 'Reviewer', {
      instructions: '# Role\nReview security first.',
      styles: [
        { name: 'Terse', description: 'Short: "answers" # not a comment', keepCodingInstructions: false, body: 'At most two sentences.' },
        { name: 'Verbose', description: 'Long answers', keepCodingInstructions: true, body: 'Explain everything.' },
      ],
      defaultStyle: 'Terse',
      agents: [
        { name: 'security-reviewer', description: 'Reviews a diff for security problems', prompt: 'You review diffs.\n\n---\nstill the prompt', tools: ['Read', 'Grep'], disallowedTools: [], model: 'sonnet', effort: 'high', maxTurns: 8 },
        { name: 'free', description: 'Inherits everything', prompt: 'Help.', tools: [], disallowedTools: [], model: '', effort: null, maxTurns: null },
      ],
      model: 'claude-sonnet-4-6',
      effort: 'low',
      chatPrompt: 'Answer in Indonesian.',
    });
    h.pools.setAssignments(WS, 'persona', [{ poolId: p.id }]);
    const b = h.compiled();
    const paths = b.files.map((f) => f.path);
    assert.deepEqual(paths.filter((x) => x.startsWith('/etc/claude') && !x.startsWith('/etc/claudepilot/bin/')).sort(), [
      '/etc/claude-code/.claude/agents/free.md',
      '/etc/claude-code/.claude/agents/security-reviewer.md',
      '/etc/claude-code/.claude/output-styles/Terse.md',
      '/etc/claude-code/.claude/output-styles/Verbose.md',
      '/etc/claude-code/CLAUDE.md',
      '/etc/claude-code/managed-settings.d/00-claudepilot-base.json'.replace('00-claudepilot-base', '50-claudepilot-persona'),
      '/etc/claudepilot/persona/chat-prompt.md',
    ].sort());
    // Root-owned, world-readable: Claude Code reads them as the workspace user.
    for (const f of b.files.filter((x) => x.path.includes('/.claude/') || x.path.endsWith('CLAUDE.md'))) assert.deepEqual([f.mode, f.uid, f.gid], [0o644, 0, 0], f.path);
    assert.equal(h.file('/etc/claude-code/CLAUDE.md'), '# Role\nReview security first.\n');
    const dropIn = JSON.parse(h.file(DROP_IN)!) as { env?: Record<string, string> };
    assert.match(dropIn.env?.CLAUDEPILOT_PERSONA ?? '', /^[0-9a-f]{12}$/, 'a stamp of what the persona delivers');
    assert.deepEqual({ ...dropIn, env: undefined }, { outputStyle: 'Terse', model: 'claude-sonnet-4-6', effortLevel: 'low', env: undefined });
    assert.equal(h.file('/etc/claudepilot/persona/chat-prompt.md'), 'Answer in Indonesian.\n');
    // The empty managed folders exist even when a persona has no styles or subagents (§10.2).
    assert.ok(b.dirs.some((d) => d.path === '/etc/claude-code/.claude/agents') && b.dirs.some((d) => d.path === '/etc/claude-code/.claude/output-styles'));

    // Frontmatter comes from a serializer: parsed back as YAML it says exactly what was configured (FR12).
    const style = parseSkillMd(h.file('/etc/claude-code/.claude/output-styles/Terse.md')!);
    assert.deepEqual(style.frontmatter, { name: 'Terse', description: 'Short: "answers" # not a comment', 'keep-coding-instructions': false });
    assert.equal(style.body.trim(), 'At most two sentences.');
    const agent = parseSkillMd(h.file('/etc/claude-code/.claude/agents/security-reviewer.md')!);
    assert.deepEqual(agent.frontmatter, { name: 'security-reviewer', description: 'Reviews a diff for security problems', model: 'sonnet', effort: 'high', maxTurns: 8, tools: 'Read, Grep' });
    assert.equal(agent.body.trim(), 'You review diffs.\n\n---\nstill the prompt', 'a --- line in the prompt stays in the prompt');
    // An agent with no tools or model says nothing about them: it inherits every tool.
    assert.deepEqual(parseSkillMd(h.file('/etc/claude-code/.claude/agents/free.md')!).frontmatter, { name: 'free', description: 'Inherits everything' });
  } finally {
    h.done();
  }
});

test('§11: the drop-in carries a stamp of what the persona delivers, so running sessions re-read an edit; an equal save changes nothing', async () => {
  const h = await setup();
  try {
    const p = create(h, 'Reviewer', { instructions: 'Role one.' });
    h.pools.setAssignments(WS, 'persona', [{ poolId: p.id }]);
    const dropIn = () => JSON.parse(h.file(DROP_IN)!) as { env: { CLAUDEPILOT_PERSONA: string } };
    const stamp = () => dropIn().env.CLAUDEPILOT_PERSONA;
    const first = stamp();
    assert.deepEqual(Object.keys(dropIn()), ['env'], 'instructions only: the drop-in exists and holds just the stamp');
    h.pools.update(p.id, { content: persona({ instructions: 'Role one.' }), note: 'the same' });
    assert.equal(h.pools.get(p.id).latestRevision, 1, 'an equal save makes no revision');
    assert.equal(stamp(), first);
    // Every part that reaches the workspace moves the stamp: the text, a style, a subagent, the defaults.
    const seen = new Set([first]);
    const next = (content: Partial<PersonaContent>) => {
      h.pools.update(p.id, { content: persona({ instructions: 'Role one.', ...content }) });
      assert.ok(!seen.has(stamp()), JSON.stringify(Object.keys(content)));
      seen.add(stamp());
    };
    next({ instructions: 'Role two.' });
    next({ instructions: 'Role two.', styles: [{ name: 'Terse', description: 'd', keepCodingInstructions: true, body: 'Short.' }] });
    next({ instructions: 'Role two.', styles: [{ name: 'Terse', description: 'd', keepCodingInstructions: true, body: 'Shorter.' }] });
    next({ instructions: 'Role two.', model: 'sonnet' });
    // The same content on another persona gives the same stamp: it's a hash of what's delivered, not of a time or an id.
    const twin = create(h, 'Twin', { instructions: 'Role two.', model: 'sonnet' });
    h.pools.update(p.id, { content: persona({ instructions: 'Role two.', model: 'sonnet' }) });
    const before = stamp();
    h.pools.setAssignments(WS, 'persona', [{ poolId: twin.id }]);
    assert.equal(stamp(), before);
    // Nothing delivered, nothing written: an empty persona has no drop-in at all.
    const empty = create(h, 'Empty', {});
    h.pools.setAssignments(WS, 'persona', [{ poolId: empty.id }]);
    assert.equal(h.file(DROP_IN), undefined);
  } finally {
    h.done();
  }
});

test('an empty persona writes no instructions and no drop-in; unassigning removes every persona file after the grace period', async () => {
  const h = await setup();
  try {
    const p = create(h, 'Empty', {});
    h.pools.setAssignments(WS, 'persona', [{ poolId: p.id }]);
    const b = h.compiled();
    assert.ok(!b.files.some((f) => f.path === '/etc/claude-code/CLAUDE.md' || f.path === DROP_IN), 'nothing to say, nothing written');
    assert.equal(b.manifest.pools.find((x) => x.type === 'persona')?.id, p.id, 'but the manifest names the persona');

    // Through the engine, on an in-memory workspace: deliver, then unassign.
    const q = create(h, 'Reviewer', { instructions: 'Role.', model: 'sonnet' });
    h.pools.setAssignments(WS, 'persona', [{ poolId: q.id }]);
    await h.reconciler.request(WS, 'test');
    assert.equal(h.reconciler.row(WS)?.status, 'synced', h.reconciler.row(WS)?.reason ?? '');
    assert.equal(h.ws.files.get('/etc/claude-code/CLAUDE.md')?.content, 'Role.\n');
    assert.deepEqual(Object.keys(JSON.parse(h.ws.files.get(DROP_IN)!.content) as object).sort(), ['env', 'model']);
    h.pools.setAssignments(WS, 'persona', []);
    await h.reconciler.request(WS, 'unassign');
    const rows = JSON.parse(h.reconciler.row(WS)!.pending_deletes) as { since?: number }[];
    h.store.db!.prepare('UPDATE workspace_delivery SET pending_deletes = ? WHERE workspace_id = ?').run(JSON.stringify(rows.map((r) => (r.since ? { ...r, since: r.since - 120_000 } : r))), WS);
    await h.reconciler.request(WS, 'grace over');
    assert.ok(!h.ws.files.has('/etc/claude-code/CLAUDE.md'), 'the managed instructions are gone');
  } finally {
    h.done();
  }
});

test('the persona never writes claudeMd, agent or anything outside its keys: the compiler enforces the ownership declaration', async () => {
  const h = await setup();
  try {
    const { compile: build } = await import('../delivery/compile.js');
    const now = new Date();
    const base = { portalId: 'p', generation: 1, claudeVersion: '2.1.296 (Claude Code)', now };
    assert.throws(() => build({ ...base, fragments: [{ owner: 'persona', settings: { agent: 'reviewer' } }] }), /may not set agent/);
    assert.throws(() => build({ ...base, fragments: [{ owner: 'persona', settings: { permissions: { allow: ['Bash(*)'] } } }] }), /may not set permissions/);
    assert.throws(() => build({ ...base, fragments: [{ owner: 'persona', files: [{ path: '/etc/claude-code/.claude/rules/cpx-x.md', content: 'x', mode: 0o644, uid: 0, gid: 0 }] }] }), /may not write/);
    assert.throws(() => build({ ...base, fragments: [{ owner: 'persona', files: [{ path: '/etc/passwd', content: 'x', mode: 0o644, uid: 0, gid: 0 }] }] }), /may not write/);
    assert.throws(() => build({ ...base, fragments: [{ owner: 'context', files: [{ path: '/etc/claude-code/CLAUDE.md', content: 'x', mode: 0o644, uid: 0, gid: 0 }] }] }), /may not write/);
  } finally {
    h.done();
  }
});

/* ---------- Instruction contexts (PRD A9) ---------- */

const ctx = (h: H, name: string, body: string) => h.pools.create('context', { name, content: { body } satisfies ContextContent });

test('A9: a context is one managed rule file, assigned on its own; several per workspace, names that clash get a number', async () => {
  const h = await setup();
  try {
    const a = ctx(h, 'Coding standards', 'Use 2 spaces.');
    const b = ctx(h, 'Coding Standards!', 'Prefer small functions.');
    const c = ctx(h, 'Security checklist', 'Never log tokens.');
    h.pools.setAssignments(WS, 'context', [{ poolId: a.id }, { poolId: b.id }, { poolId: c.id }]);
    const files = h.compiled().files.filter((f) => f.path.startsWith('/etc/claude-code/.claude/rules/'));
    assert.deepEqual(files.map((f) => f.path).sort(), ['/etc/claude-code/.claude/rules/cpx-coding-standards-2.md', '/etc/claude-code/.claude/rules/cpx-coding-standards.md', '/etc/claude-code/.claude/rules/cpx-security-checklist.md']);
    const std = files.find((f) => f.path.endsWith('cpx-coding-standards.md'))!;
    assert.match(std.content, /^<!-- Instruction context “Coding standards” r1, delivered by the portal\. -->\nUse 2 spaces\.\n$/);
    assert.deepEqual([std.mode, std.uid, std.gid], [0o644, 0, 0]);
    // Each assigned context is named in the manifest.
    assert.deepEqual(h.compiled().manifest.pools.filter((p) => p.type === 'context').map((p) => p.id).sort(), [a.id, b.id, c.id].sort());
    // A context needs a body, and a body that isn't a secret.
    assert.throws(() => h.pools.create('context', { name: 'Empty', content: { body: '  ' } }), field('body', /Write the instructions/));
    assert.throws(() => h.pools.create('context', { name: 'Big', content: { body: 'x'.repeat(20 * 1024 + 1) } }), field('body', /at most 20 KB/));
  } finally {
    h.done();
  }
});

test('A9: a persona holds contexts and they are delivered with it; one both assigned and held is delivered once; a held one is not named as a pool', async () => {
  const h = await setup();
  try {
    const standards = ctx(h, 'Coding standards', 'Use 2 spaces.');
    const checklist = ctx(h, 'Security checklist', 'Never log tokens.');
    const p = create(h, 'Reviewer', { instructions: 'Role.', contexts: [standards.id, checklist.id] });
    h.pools.setAssignments(WS, 'persona', [{ poolId: p.id }]);
    const rules = () => h.compiled().files.filter((f) => f.path.startsWith('/etc/claude-code/.claude/rules/')).map((f) => f.path.split('/').pop());
    assert.deepEqual(rules(), ['cpx-coding-standards.md', 'cpx-security-checklist.md']);
    assert.deepEqual(h.compiled().manifest.pools.filter((x) => x.type === 'context'), [], 'held contexts belong to the persona’s lifecycle, not the manifest');

    // Assigning one directly as well changes nothing about the files: each context is delivered once.
    h.pools.setAssignments(WS, 'context', [{ poolId: standards.id }]);
    assert.deepEqual(rules(), ['cpx-coding-standards.md', 'cpx-security-checklist.md']);
    assert.deepEqual(h.compiled().manifest.pools.filter((x) => x.type === 'context').map((x) => x.id), [standards.id]);

    // I5: a read API says where each comes from.
    const view = h.personas.personaFor(WS);
    assert.equal(view.persona?.name, 'Reviewer');
    assert.deepEqual(view.contexts.map((c) => [c.name, c.via]), [['Coding standards', 'assigned'], ['Security checklist', 'persona']]);
    assert.equal(view.parts.instructionLines, 1);

    // Editing a context reaches every workspace that gets it, by either route.
    h.pools.update(checklist.id, { content: { body: 'Never log tokens or keys.' } });
    assert.match(h.file('/etc/claude-code/.claude/rules/cpx-security-checklist.md')!, /Never log tokens or keys\./);

    // Dropping the persona takes its contexts with it, except the one assigned on its own.
    h.pools.setAssignments(WS, 'persona', []);
    assert.deepEqual(rules(), ['cpx-coding-standards.md']);
    assert.equal(h.personas.personaFor(WS).persona, null);
  } finally {
    h.done();
  }
});

test('A9: a context a persona holds can’t be deleted; the persona can drop it first; a context with no published revision is skipped', async () => {
  const h = await setup();
  try {
    const standards = ctx(h, 'Coding standards', 'Use 2 spaces.');
    const p = create(h, 'Reviewer', { contexts: [standards.id] });
    assert.throws(() => h.pools.delete(standards.id), (e) => code('CONFLICT')(e) && /“Reviewer” holds this context/.test((e as Error).message));
    h.pools.update(p.id, { content: persona({ contexts: [] }) });
    h.pools.delete(standards.id);
    // A context that only has a draft has nothing deliverable: a persona holding it delivers the rest.
    const draft = h.pools.create('context', { name: 'Draft only', content: { body: 'Later.' }, draft: true });
    const q = create(h, 'Holder', { instructions: 'Role.', contexts: [draft.id] });
    h.pools.setAssignments(WS, 'persona', [{ poolId: q.id }]);
    assert.ok(!h.compiled().files.some((f) => f.path.includes('/rules/')));
    assert.equal(h.file('/etc/claude-code/CLAUDE.md'), 'Role.\n');
  } finally {
    h.done();
  }
});

test('contexts through the engine: delivered to a workspace, removed with the grace period, never touching the repository’s files', async () => {
  const h = await setup();
  try {
    const a = ctx(h, 'Coding standards', 'Use 2 spaces.');
    h.pools.setAssignments(WS, 'context', [{ poolId: a.id }]);
    await h.reconciler.request(WS, 'test');
    assert.equal(h.reconciler.row(WS)?.status, 'synced', h.reconciler.row(WS)?.reason ?? '');
    assert.match(h.ws.files.get('/etc/claude-code/.claude/rules/cpx-coding-standards.md')!.content, /Use 2 spaces\./);
    h.pools.setAssignments(WS, 'context', []);
    await h.reconciler.request(WS, 'unassign');
    const rows = JSON.parse(h.reconciler.row(WS)!.pending_deletes) as { since?: number }[];
    h.store.db!.prepare('UPDATE workspace_delivery SET pending_deletes = ? WHERE workspace_id = ?').run(JSON.stringify(rows.map((r) => (r.since ? { ...r, since: r.since - 120_000 } : r))), WS);
    await h.reconciler.request(WS, 'grace over');
    assert.ok(!h.ws.files.has('/etc/claude-code/.claude/rules/cpx-coding-standards.md'));
  } finally {
    h.done();
  }
});

const CONTEXT_DROP_IN = '/etc/claude-code/managed-settings.d/55-claudepilot-context.json';

test('A9: the contexts’ drop-in holds only a stamp that moves when a rule file does, and is absent when there are no contexts', async () => {
  const h = await setup();
  try {
    assert.equal(h.file(CONTEXT_DROP_IN), undefined);
    const a = ctx(h, 'Coding standards', 'Use 2 spaces.');
    h.pools.setAssignments(WS, 'context', [{ poolId: a.id }]);
    const stamp = () => (JSON.parse(h.file(CONTEXT_DROP_IN)!) as { env: { CLAUDEPILOT_CONTEXT: string } }).env.CLAUDEPILOT_CONTEXT;
    assert.deepEqual(Object.keys(JSON.parse(h.file(CONTEXT_DROP_IN)!) as object), ['env']);
    const first = stamp();
    h.pools.update(a.id, { content: { body: 'Use 4 spaces.' } });
    assert.notEqual(stamp(), first);
    assert.ok(h.compiled().dirs.some((d) => d.path === '/etc/claude-code/.claude/rules'), 'the rules folder is created with its first rule');
    // A persona's contexts use the contexts' drop-in, not the persona's.
    h.pools.setAssignments(WS, 'context', []);
    const holder = create(h, 'Holder', { contexts: [a.id] });
    h.pools.setAssignments(WS, 'persona', [{ poolId: holder.id }]);
    assert.ok(h.file(CONTEXT_DROP_IN));
    assert.equal(h.file(DROP_IN), undefined, 'an empty persona delivers nothing of its own');
  } finally {
    h.done();
  }
});

test('A9: a change to a context only a persona holds is delivered to its workspaces without waiting for a timer', async () => {
  const h = await setup();
  try {
    const standards = ctx(h, 'Coding standards', 'Use 2 spaces.');
    const p = create(h, 'Reviewer', { instructions: 'Role.', contexts: [standards.id] });
    h.pools.setAssignments(WS, 'persona', [{ poolId: p.id }]);
    h.compiled(); // what the reconciler last delivered
    h.requests.length = 0;
    const settle = () => new Promise((r) => setImmediate(r));
    h.pools.update(standards.id, { content: { body: 'Use 4 spaces.' } });
    await settle();
    assert.deepEqual(h.requests, [WS], 'nothing has the context assigned, yet the persona’s workspace is asked');
    // A save that changes nothing, a draft nobody gets and a context nobody holds ask for nothing.
    h.compiled();
    h.requests.length = 0;
    h.pools.update(standards.id, { content: { body: 'Use 4 spaces.' }, note: 'the same' });
    h.pools.update(standards.id, { content: { body: 'Use 8 spaces.' }, draft: true });
    ctx(h, 'Unused', 'Nobody holds this.');
    await settle();
    assert.deepEqual(h.requests, []);
    // Publishing that draft is a change again.
    h.pools.approve(standards.id, h.pools.get(standards.id).latestRevision);
    await settle();
    assert.deepEqual(h.requests, [WS]);
  } finally {
    h.done();
  }
});

test('I5: the read API says what a workspace gets, never anything secret', async () => {
  const h = await setup();
  try {
    assert.deepEqual(h.personas.personaFor(WS), { workspaceId: WS, persona: null, contexts: [], parts: { instructionLines: 0, styles: [], defaultStyle: null, agents: [], model: null, effort: null, hasChatPrompt: false } });
    const p = h.pools.create('persona', {
      name: 'Reviewer',
      description: 'Reviews pull requests',
      content: persona({ instructions: 'a\nb\nc', styles: [{ name: 'Terse', description: 'd', keepCodingInstructions: true, body: 'b' }], defaultStyle: 'Terse', model: 'opus', effort: 'high', chatPrompt: 'Chat only.' }),
    });
    h.pools.setAssignments(WS, 'persona', [{ poolId: p.id }]);
    const v = h.personas.personaFor(WS);
    assert.deepEqual(v.persona, { poolId: p.id, name: 'Reviewer', revision: 1, description: 'Reviews pull requests', avatar: null });
    assert.deepEqual(v.parts, { instructionLines: 3, styles: ['Terse'], defaultStyle: 'Terse', agents: [], model: 'opus', effort: 'high', hasChatPrompt: true });
    assert.equal(h.personas.chatPrompt(WS), 'Chat only.');
    assert.equal(h.personas.chatPrompt('docker/none'), null);
  } finally {
    h.done();
  }
});

test('T-490 (D-63): a role’s model is its agent’s in the workspace persona; none for no persona, no such agent, empty or inherit', async () => {
  const h = await setup();
  try {
    assert.equal(h.personas.roleModel(WS, 'qa-verifier'), null, 'no persona');
    const agent = (name: string, model: string) => ({ name, description: 'd', prompt: 'p', tools: [], disallowedTools: [], model, effort: null, maxTurns: null });
    const p = h.pools.create('persona', { name: 'Crew', content: persona({ agents: [agent('qa-verifier', 'sonnet'), agent('implementer', ''), agent('scribe', 'inherit'), agent('reviewer', 'claude-sonnet-5-5')] }) });
    h.pools.setAssignments(WS, 'persona', [{ poolId: p.id }]);
    assert.deepEqual(
      ['qa-verifier', 'implementer', 'scribe', 'reviewer', 'nobody'].map((r) => h.personas.roleModel(WS, r)),
      ['sonnet', null, null, 'claude-sonnet-5-5', null],
    );
    assert.equal(h.personas.roleModel('docker/none', 'qa-verifier'), null, 'another workspace');
  } finally {
    h.done();
  }
});
