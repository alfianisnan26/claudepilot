// T-561 (chat-sessions PRD FR53, D-63): a crew lead, under the policy `sessions.leadRules` (off by default), launches with the lead
// rules: one more `--settings` value, a PreToolUse hook that refuses Edit, Write, MultiEdit and NotebookEdit outside its status files, its
// notes folder and /tmp, with a message that names D-63. The hook is run for real here; the launch is checked on the fake host.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { settingDef } from '../settings/registry.js';
import { SETTINGS_POLICIES } from '../settings/authz.js';
import { isLead, LEAD_RULES_MATCHER, LEAD_RULES_SETTING, leadAllowedDirs, leadHookScript, leadRulesSettings } from './leadRules.js';
import { APPLIED, init, liveSession, ok, sleep, until, type Live } from './testkit.js';

const FLAG = '--allow-dangerously-skip-permissions';
const REPO = '/home/node/work/repo';

/** The lead-rules `--settings` value of a start (the inline JSON one), or null. */
const leadSettingsOf = (args: string[]): string | null => {
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '--settings' && args[i + 1]!.startsWith('{')) return args[i + 1]!;
  return null;
};
/** The command line of the hook in a lead-rules `--settings` value. */
const hookCommand = (settings: string): string => {
  const parsed = JSON.parse(settings) as { hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] } };
  const entry = parsed.hooks.PreToolUse[0]!;
  assert.equal(entry.matcher, LEAD_RULES_MATCHER);
  assert.equal(entry.hooks[0]!.type, 'command');
  return entry.hooks[0]!.command;
};
/** Runs the hook as Claude Code does (`sh -c`, the PreToolUse input on stdin). */
const runHook = (command: string, input: unknown) => {
  const r = spawnSync('/bin/sh', ['-c', command], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, stderr: r.stderr };
};
const edit = (tool: string, path: string, key = 'file_path') => ({ hook_event_name: 'PreToolUse', tool_name: tool, cwd: REPO, tool_input: { [key]: path } });

function controlsOf(s: Live) {
  return s.ws.sends.flatMap((x) => {
    try {
      const o = JSON.parse(x.line) as { type?: string; request_id?: string; request?: Record<string, unknown> };
      return o.type === 'control_request' && o.request_id && o.request ? [{ id: o.request_id, request: o.request }] : [];
    } catch {
      return [];
    }
  });
}

/** The newest process answers every control request the portal asks (settings, modes) until `p` settles. */
async function answered<T>(s: Live, p: Promise<T>): Promise<T> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  const seen = new Set<string>(controlsOf(s).map((c) => c.id));
  while (!settled) {
    for (const c of controlsOf(s)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const tail = s.ws.tails.at(-1)!;
      if (c.request.subtype === 'get_settings') tail.push(ok(c.id, APPLIED));
      else if (c.request.subtype === 'set_permission_mode') tail.push(ok(c.id, { mode: String(c.request.mode) }));
      else tail.push(ok(c.id));
    }
    await sleep(5);
  }
  return p;
}

function policy(s: Live, on: boolean) {
  const state = { on };
  s.controller.leadRulesOn = () => state.on;
  return state;
}

/** Starts another session (a lead when `lead`), waits until it is idle; its reader is the newest tail. */
async function another(s: Live, req: { lead?: boolean; cwd?: string } = {}, opts: Parameters<Live['controller']['create']>[1] = {}) {
  const before = s.ws.tails.length;
  const made = await s.controller.create({ workspaceId: 'docker/ws1', ...req }, opts);
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(made.id)?.state === 'idle');
  await sleep(20);
  return { id: made.id, tail: s.ws.tails.at(-1)!, args: s.ws.startArgs.at(-1)! };
}

/* ---------- The hook itself ---------- */

test('the hook refuses an edit outside the allowed folders with the D-63 text, and allows the status files, the notes folder and /tmp', () => {
  const command = hookCommand(leadRulesSettings(REPO));
  const refused = runHook(command, edit('Edit', `${REPO}/apps/server/src/index.ts`));
  assert.equal(refused.code, 2, 'exit 2 stops the tool call in every permission mode');
  assert.match(refused.stderr, /D-63/);
  assert.match(refused.stderr, /Dispatch a worker/);
  assert.match(refused.stderr, /apps\/server\/src\/index\.ts/, 'it says which path');

  assert.equal(runHook(command, edit('Edit', `${REPO}/docs/dev-sessions/status/orchestrator.md`)).code, 0, 'its status file');
  assert.equal(runHook(command, edit('Write', `${REPO}/docs/dev-sessions/notes/plan.md`)).code, 0, 'its notes folder');
  assert.equal(runHook(command, edit('Write', '/tmp/scratch/out.txt')).code, 0, 'the scratch folder');
  assert.equal(runHook(command, edit('NotebookEdit', '/tmp/a.ipynb', 'notebook_path')).code, 0, 'NotebookEdit names its path differently');
  assert.equal(runHook(command, edit('Write', 'docs/dev-sessions/status/x.md')).code, 0, 'a relative path resolves against the call’s folder');

  assert.equal(runHook(command, edit('NotebookEdit', `${REPO}/apps/a.ipynb`, 'notebook_path')).code, 2);
  assert.equal(runHook(command, edit('Edit', `${REPO}/docs/dev-sessions/status/../../../apps/x.ts`)).code, 2, 'no way out with ..');
  assert.equal(runHook(command, edit('Edit', `${REPO}/docs/dev-sessions/statusx/a.md`)).code, 2, 'a folder that only starts the same');
  assert.equal(runHook(command, edit('Edit', '/tmpfoo/a')).code, 2);
  assert.equal(runHook(command, edit('Write', `${REPO}/docs/dev-sessions/README.md`)).code, 2);
  assert.equal(runHook(command, 'not json').code, 2, 'input it cannot read is refused');
  assert.equal(runHook(command, { tool_input: {} }).code, 2, 'a call without a path is refused');
});

test('the allowed folders are the lead’s own folder’s status and notes, and /tmp; a folder that cannot be quoted is refused', () => {
  assert.deepEqual(leadAllowedDirs('/w/x/'), ['/w/x/docs/dev-sessions/status', '/w/x/docs/dev-sessions/notes', '/tmp']);
  assert.throws(() => leadHookScript("/w/it's"), /quoted/);
  assert.equal(isLead({ lead: 1 }, false), true);
  assert.equal(isLead({ lead: null }, true), true);
  assert.equal(isLead({ lead: null }, false), false);
});

test('the policy: off by default, a protective switch in Sessions, changed only through the settings route (platform manage)', () => {
  const def = settingDef(LEAD_RULES_SETTING)!;
  assert.equal(def.default, false);
  assert.equal(def.protective, true, 'turning it off again asks for a confirmation');
  assert.equal(def.group, 'sessions');
  assert.deepEqual(SETTINGS_POLICIES['PUT /api/settings/:key'], { kind: 'platform', area: 'settings', verb: 'manage' });
});

/* ---------- The launch ---------- */

test('a lead under the policy launches with the lead rules after the host’s arguments, and its info says so; a non-lead does not', async () => {
  const s = await liveSession();
  try {
    policy(s, true);
    const lead = await another(s, { lead: true, cwd: REPO });
    const settings = leadSettingsOf(lead.args);
    assert.equal(settings, leadRulesSettings(REPO));
    assert.ok(lead.args.indexOf('--settings') > lead.args.indexOf('--'), 'a flag of claude');
    assert.equal(s.controller.get(lead.id)!.lead, true);
    assert.equal(s.controller.get(lead.id)!.leadRules, true, 'shown in the session’s info');

    const plain = await another(s, { cwd: REPO });
    assert.equal(leadSettingsOf(plain.args), null, 'not a lead: no rules');
    assert.equal(s.controller.get(plain.id)!.leadRules, undefined);
    assert.equal(s.controller.get(plain.id)!.lead, undefined);
  } finally {
    await s.done();
  }
});

test('the policy off (the default): a lead launches without the rules', async () => {
  const s = await liveSession();
  try {
    const lead = await another(s, { lead: true });
    assert.equal(leadSettingsOf(lead.args), null, 'nothing installed: off');
    policy(s, false);
    const again = await another(s, { lead: true });
    assert.equal(leadSettingsOf(again.args), null);
    assert.equal(s.controller.get(again.id)!.leadRules, undefined);
    s.controller.leadRulesOn = () => {
      throw new Error('unreadable');
    };
    assert.equal(leadSettingsOf((await another(s, { lead: true })).args), null, 'an unreadable policy is off');
  } finally {
    await s.done();
  }
});

test('a session that started a worker is a lead at its next start; the worker is not', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    policy(s, true);
    assert.equal(leadSettingsOf(s.ws.startArgs[0]!), null);
    const worker = await another(s, {}, { actor: `session:${s.id}`, parentId: s.id });
    assert.equal(leadSettingsOf(worker.args), null, 'a worker gets no lead rules');
    // The parent's process started before it had a worker: the rules come with its next start.
    assert.equal(s.controller.get(s.id)!.leadRules, undefined);
    await until(() => s.controller.get(s.id)!.process === 'live');
    const starts = s.ws.startArgs.length;
    await answered(s, s.controller.restart(s.id, { why: 'mcp' }));
    assert.equal(s.ws.startArgs.length, starts + 1);
    assert.ok(leadSettingsOf(s.ws.startArgs.at(-1)!), 'a lead now');
    assert.equal(s.controller.get(s.id)!.leadRules, true);
  } finally {
    await s.done();
  }
});

test('Bypass keeps the rules: a bypass-capable lead starts with both flags, and a restart that keeps Bypass relaunches with both', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    policy(s, true);
    s.controller.bypassAllowed = () => true;
    s.controller.reauth = { fresh: (token) => token === 'tok' };
    const lead = await another(s, { lead: true, cwd: REPO }, { bypassOptIn: true });
    assert.ok(lead.args.includes(FLAG));
    assert.equal(leadSettingsOf(lead.args), leadRulesSettings(REPO));
    lead.tail.push(init(lead.id));
    lead.tail.push(ok((await s.take('get_settings')).id, APPLIED));
    await until(() => s.controller.get(lead.id)!.effort === 'medium');
    const entering = s.controller.enterBypass(lead.id, { acknowledged: true, sessionToken: 'tok' });
    lead.tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
    await entering;
    assert.equal(s.controller.get(lead.id)!.mode, 'bypassPermissions');
    assert.equal(s.controller.get(lead.id)!.leadRules, true, 'in Bypass the process still runs with them');

    const starts = s.ws.startArgs.length;
    // The relaunch asks for Bypass again through the grant: the new process answers.
    const restarted = await answered(s, s.controller.restart(lead.id));
    assert.equal(restarted.mode, 'bypassPermissions', 'Bypass kept');
    assert.equal(s.ws.startArgs.length, starts + 1);
    const relaunch = s.ws.startArgs.at(-1)!;
    assert.ok(relaunch.includes(FLAG) && relaunch.includes('--resume'));
    assert.equal(leadSettingsOf(relaunch), leadRulesSettings(REPO), 'the rules come back with every start, Bypass or not');
  } finally {
    await s.done();
  }
});

test('a continuation of a lead is a lead', async () => {
  const s = await liveSession();
  try {
    policy(s, true);
    const lead = await another(s, { lead: true });
    await s.controller.end(lead.id);
    const next = await s.controller.create({ workspaceId: 'docker/ws1', continuedFrom: lead.id });
    assert.equal(s.controller.get(next.id)!.lead, true);
  } finally {
    await s.done();
  }
});
