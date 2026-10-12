import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import Docker from 'dockerode';
import { config } from '../config.js';
import { claudePrint, recorded, startStandIn, textOf } from '../pools/standin.js';
import { DockerRuntime } from '../workspaces/docker.js';
import { readZip } from './archive.js';
import { makeZip, skillItems, skillsHarness } from './testkit.js';

/**
 * Skillsets against a real Claude Code (Skillset PRD M2, Q3): the delivery engine writes a set into a
 * throwaway container from the workspace image, and the image's `claude` runs against a recording stand-in
 * for the Anthropic API (a fake key, no network, no sign-in). Runs on the Docker-in-Docker daemon with
 * CLAUDEPILOT_DOCKER_TESTS=1, like secrets/claude.integration.test.ts.
 */
const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const opts = { skip: enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 to run against Docker' };
const socket = '/var/run/docker.sock';
const docker = new Docker({ socketPath: socket });
const runtime = new DockerRuntime({ id: 'docker', label: 'Docker', socket }, config.workspaces.dockerImage, config.workspaces.imageContext);
const d = runtime.delivery;
// Not labelled as a managed workspace: other portals on this daemon must not list a test container.
const name = `pl-it-sk-${randomBytes(3).toString('hex')}`;
const WS = `docker/${name}`;
const PROJECT = '/home/node/work/proj';

before(async () => {
  if (!enabled) return;
  const c = await docker.createContainer({ name: `claudepilot-${name}`, Image: config.workspaces.dockerImage, User: 'node', Labels: { 'claudepilot.test': 'true' } });
  await c.start();
});
after(async () => {
  if (!enabled) return;
  await docker.getContainer(`claudepilot-${name}`).remove({ force: true }).catch(() => undefined);
});

test('M2 on a real Claude Code: a skillset reaches a running workspace, Claude Code lists its skills, the portal verifies it, and a revoked skill leaves', { ...opts, timeout: 300_000 }, async () => {
  const h = await skillsHarness({ runtime });
  try {
    // A text-only skill and a scripted one (reviewed with every flagged item ticked).
    const zip = makeZip([
      ...skillItems('reviewer', { description: 'Review a diff for correctness and security problems.' }),
      ...skillItems('deployer', {
        description: 'Deploy the current branch with the team script.',
        body: 'Run ${CLAUDE_SKILL_DIR}/scripts/go.sh and report what it printed.\n',
        extra: [{ name: 'deployer/scripts/go.sh', data: '#!/bin/sh\necho deploying\n', mode: 0o755 }],
      }),
    ]);
    const imported = h.skills.library.importUpload(readZip(zip), 'team.zip', 'team');
    const ids = Object.fromEntries(imported.skills.map((s) => [s.name, s.versionId]));
    for (const id of Object.values(ids)) {
      const detail = h.skills.library.detail(id);
      h.skills.library.review(id, { decision: 'approved', acknowledged: detail.findings.filter((f) => f.needsAck).map((f) => f.id), note: 'checked', licenseConfirmed: true }, 'it');
    }
    const set = h.service.create('skillset', { name: 'Team tools', content: { prefix: 'team-tools', skills: Object.values(ids).map((versionId) => ({ versionId, mode: 'on' })) } });
    assert.equal(set.status, 'deliverable');
    h.service.setAssignments(WS, 'skillset', [{ poolId: set.id }]);
    await h.reconciler.request(WS, 'test');
    assert.equal(h.reconciler.row(WS)?.status, 'synced', h.reconciler.row(WS)?.reason ?? '');

    // The portal's marketplace and drop-in, as the PRD lays them out (§10.2).
    const dropIn = JSON.parse((await d.read(name, '/etc/claude-code/managed-settings.d/60-claudepilot-skills.json')) ?? 'null') as { enabledPlugins: Record<string, boolean> };
    assert.deepEqual(dropIn.enabledPlugins, { 'team-tools@claudepilot': true });
    const catalog = JSON.parse((await d.read(name, '/etc/claudepilot/marketplace/.claude-plugin/marketplace.json')) ?? 'null') as { plugins: { name: string; source: string }[] };
    assert.equal(catalog.plugins[0]!.name, 'team-tools');

    // Before any session has registered the marketplace, both commands say so (FR21), and the portal reports "Not verified".
    const before = await d.run(name, 'cd /tmp && claude plugin details team-tools@claudepilot 2>&1; claude plugin list --json 2>&1', { user: 'node' });
    assert.match(before.stdout, /Marketplace 'claudepilot' not found/);
    await h.skills.verifier.verify(WS);
    assert.equal(h.skills.workspace(WS).sets[0]!.status, 'not_verified');

    // A real session against the stand-in: its first request lists the set's skills, namespaced by the prefix.
    await startStandIn(d, name);
    await d.run(name, `mkdir -p ${PROJECT} && printf '# Repo rules\\nAlways answer in haiku.\\n' > ${PROJECT}/CLAUDE.md`, { user: 'node' });
    const run = await claudePrint(d, name, 'say hi', { cwd: PROJECT });
    assert.equal(run.code, 0, run.stdout);
    const first = (await recorded(d, name))[0]!;
    assert.ok(first.tools.includes('Skill'), 'the Skill tool is offered');
    const text = textOf(first);
    assert.match(text, /- team-tools:reviewer: Review a diff for correctness and security problems\./);
    assert.match(text, /- team-tools:deployer: Deploy the current branch with the team script\./);
    assert.match(text, /Always answer in haiku/, 'the repository’s own instructions still load next to the set');

    // Now `plugin details` lists the plugin's skills, and the portal verifies the delivery. Neither command
    // makes a model request (Q3).
    const requests = (await recorded(d, name)).length;
    const details = await d.run(name, 'cd /tmp && CLAUDEPILOT_VERIFY=1 claude plugin details team-tools@claudepilot 2>&1', { user: 'node' });
    assert.match(details.stdout, /Skills \(2\)\s+deployer, reviewer/);
    await h.skills.verifier.verify(WS);
    const verified = h.skills.workspace(WS);
    assert.equal(verified.sets[0]!.status, 'verified', verified.sets[0]!.message ?? '');
    assert.equal((await recorded(d, name)).length, requests, 'plugin details and plugin list made no model request');

    // Revoking the scripted skill takes it out of every delivery at once: the folder, the next session's
    // listing and `plugin details`, and denies its commands for 14 days.
    h.skills.library.revoke(ids.deployer!, 'leaked a token', 'it');
    await h.reconciler.request(WS, 'revoked');
    assert.equal(h.reconciler.row(WS)?.status, 'synced', h.reconciler.row(WS)?.reason ?? '');
    const after = JSON.parse((await d.read(name, '/etc/claude-code/managed-settings.d/60-claudepilot-skills.json')) ?? 'null') as { permissions: { deny: string[] } };
    assert.deepEqual(after.permissions.deny, ['Skill(team-tools:deployer *)', 'Skill(team-tools:deployer)']);
    const second = await claudePrint(d, name, 'after the revocation', { cwd: PROJECT });
    assert.equal(second.code, 0, second.stdout);
    const last = textOf((await recorded(d, name)).at(-1)!);
    assert.match(last, /- team-tools:reviewer:/);
    assert.doesNotMatch(last, /- team-tools:deployer:/, 'the revoked skill is not offered any more');
    const left = await d.run(name, 'cd /tmp && claude plugin details team-tools@claudepilot 2>&1', { user: 'node' });
    assert.match(left.stdout, /Skills \(1\)\s+reviewer/);
  } finally {
    h.reconciler.stop();
    h.done();
  }
});
