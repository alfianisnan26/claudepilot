// T-561 (chat-sessions PRD FR79, D-63): a crew lead, under the policy `sessions.leadRules` (off by default), launches with the lead
// rules: ONE `--settings` value (the project's permission rules merged with the lead rules), holding a PreToolUse hook that refuses Edit,
// Write, MultiEdit and NotebookEdit outside its status files, its notes folder and /tmp, with a message that names D-63. The hook is run
// for real here; the launch is checked on the fake host.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { settingDef } from '../settings/registry.js';
import { SETTINGS_POLICIES } from '../settings/authz.js';
import { isLead, LEAD_RULES_MATCHER, LEAD_RULES_SETTING, leadAllowedDirs, leadHookScript, leadRulesSettings } from './leadRules.js';
import { ChatStore } from './store.js';
import { APPLIED, EMPTY_SCAN, init, liveSession, ok, sleep, until, type Live } from './testkit.js';

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

test('the matcher names exactly the four file tools, MultiEdit included (a literal, not the constant against itself)', () => {
  const entry = (JSON.parse(leadRulesSettings(REPO)) as { hooks: { PreToolUse: { matcher: string }[] } }).hooks.PreToolUse[0]!;
  assert.equal(entry.matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  assert.deepEqual(entry.matcher.split('|').sort(), ['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
  const command = hookCommand(leadRulesSettings(REPO));
  assert.equal(runHook(command, edit('MultiEdit', `${REPO}/apps/a.ts`)).code, 2, 'MultiEdit is refused outside the folders');
  assert.equal(runHook(command, edit('MultiEdit', '/tmp/a.ts')).code, 0);
});

test('a path in another worktree of the same repository is refused, its own status folder allowed', () => {
  const command = hookCommand(leadRulesSettings(REPO));
  const other = '/home/node/work/repo.worktrees/ticket-t-1';
  assert.equal(runHook(command, edit('Edit', `${other}/apps/a.ts`)).code, 2);
  assert.equal(runHook(command, edit('Write', `${other}/docs/dev-sessions/status/x.md`)).code, 2, 'another folder’s status folder is not the lead’s');
});

test('hook input that carries agent_id (a sub-agent: a dispatch) is allowed; the same call without it is refused', () => {
  const command = hookCommand(leadRulesSettings(REPO));
  const call = edit('Edit', `${REPO}/apps/server/src/index.ts`);
  assert.equal(runHook(command, call).code, 2, 'the lead itself');
  assert.equal(runHook(command, { ...call, agent_id: 'agent-1', agent_type: 'implementer' }).code, 0, 'a sub-agent');
  assert.equal(runHook(command, { ...call, agent_id: '' }).code, 2, 'an empty agent_id is not one');
  assert.equal(runHook(command, { ...call, agent_id: 7 }).code, 2, 'nor a non-string');
});

test('a symlink inside an allowed folder cannot lead out of it, and a symlink to an allowed one is followed', () => {
  // Not under /tmp: /tmp is itself an allowed folder, so a fixture there would be allowed whatever the links do.
  const root = realpathSync(mkdtempSync(join(homedir(), 'lead-rules-')));
  try {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'docs', 'dev-sessions', 'status'), { recursive: true });
    mkdirSync(join(repo, 'apps'), { recursive: true });
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    symlinkSync(join(repo, 'apps'), join(scratch, 'x')); // scratch/x -> repo/apps
    symlinkSync(join(repo, 'apps'), join(repo, 'docs', 'dev-sessions', 'status', 'out'));
    symlinkSync(join(repo, 'docs', 'dev-sessions', 'status'), join(repo, 'link'));
    const command = hookCommand(leadRulesSettings(repo));
    const call = (path: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: repo, tool_input: { file_path: path } });
    assert.equal(runHook(command, call(join(repo, 'docs', 'dev-sessions', 'status', 'out', 'a.ts'))).code, 2, 'status/out -> apps: refused');
    assert.equal(runHook(command, call(join(repo, 'docs', 'dev-sessions', 'status', 'new', 'a.md'))).code, 0, 'a folder that does not exist yet, under an allowed one');
    assert.equal(runHook(command, call(join(repo, 'link', 'a.md'))).code, 0, 'a link that stays inside the allowed folder');
    // The same rule for /tmp: a link in it that leads into the repository. (/tmp itself is the allowed folder; build one under it.)
    const tmpLink = join(tmpdir(), `lead-rules-link-${process.pid}`);
    if (tmpdir() === '/tmp') {
      symlinkSync(join(repo, 'apps'), tmpLink);
      try {
        assert.equal(runHook(command, call(join(tmpLink, 'a.ts'))).code, 2, '/tmp/link -> repo/apps: refused');
      } finally {
        rmSync(tmpLink, { force: true });
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutation proof: the command’s `|| exit 2` is what refuses when node cannot run (without it the status is the shell’s 127)', () => {
  const command = hookCommand(leadRulesSettings(REPO));
  assert.ok(command.endsWith(' || exit 2'));
  const broken = (c: string) => c.replace('PATH=/usr/local/bin:/usr/bin:/bin', 'PATH=/nonexistent');
  assert.equal(runHook(broken(command), edit('Edit', '/tmp/a')).code, 2, 'node missing: refused');
  const mutated = broken(command).replace(/ \|\| exit 2$/, '');
  assert.notEqual(mutated, broken(command));
  assert.equal(runHook(mutated, edit('Edit', '/tmp/a')).code, 127, 'the mutant exits 127, which the check above tells apart from 2');
});

test('the merged value: the project’s rules and the lead rules in one JSON, deny lists joined, hooks joined, unreadable project input left out', () => {
  const project = JSON.stringify({ permissions: { allow: ['Bash(ls)', 'Read'], deny: ['Bash(rm *)'] } });
  const merged = JSON.parse(leadRulesSettings(REPO, project)) as { permissions: Record<string, string[]>; hooks: { PreToolUse: { matcher: string }[] } };
  assert.deepEqual(merged.permissions, { allow: ['Bash(ls)', 'Read'], deny: ['Bash(rm *)'] });
  assert.equal(merged.hooks.PreToolUse.length, 1);
  assert.equal(merged.hooks.PreToolUse[0]!.matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  const withHook = JSON.parse(leadRulesSettings(REPO, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] }, permissions: { deny: ['A', 'A'], allow: [3, 'B'] } }))) as typeof merged;
  assert.deepEqual(withHook.hooks.PreToolUse.map((h) => h.matcher), ['Bash', 'Edit|Write|MultiEdit|NotebookEdit'], 'their hook stays, the lead’s is added');
  assert.deepEqual(withHook.permissions, { allow: ['B'], deny: ['A'] });
  for (const bad of [null, '', 'not json', '[1]', '"x"']) assert.equal(leadRulesSettings(REPO, bad), leadRulesSettings(REPO), `${bad}`);
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

test('a lead in a folder with trusted project rules gets ONE --settings value holding both the project’s allow rules and the lead rules', async () => {
  const s = await liveSession();
  try {
    policy(s, true);
    const hash = 'a'.repeat(64);
    s.ws.scanFor = () => JSON.stringify({ ...EMPTY_SCAN, hash, files: ['.claude/settings.json'], allowRules: 2, rulesOnly: true, extras: [] });
    new ChatStore(s.store).saveFolderTrust('docker/ws1', REPO, hash, { files: ['.claude/settings.json'], invalid: [], mcpServers: [], hooks: [], plugins: [], allowRules: 2, envNames: [] }, 'ui');
    s.ws.psettingsOut = JSON.stringify({ permissions: { allow: ['Bash(ls)', 'Read'], deny: ['Bash(rm *)'] } });
    const lead = await another(s, { lead: true, cwd: REPO });
    assert.equal(lead.args.filter((a) => a === '--settings').length, 1, 'never two --settings flags');
    const value = lead.args[lead.args.indexOf('--settings') + 1]!;
    assert.ok(value.startsWith('{'), 'inline JSON, not the project’s file path');
    const merged = JSON.parse(value) as { permissions: { allow: string[]; deny: string[] }; hooks: unknown };
    assert.deepEqual(merged.permissions.allow, ['Bash(ls)', 'Read'], 'the project’s allow rules');
    assert.deepEqual(merged.permissions.deny, ['Bash(rm *)']);
    assert.equal(hookCommand(value).includes('exit 2'), true, 'and the lead rules');
    assert.equal(value, leadRulesSettings(REPO, s.ws.psettingsOut));
    assert.ok(s.ws.ops.includes('psettings'));
    assert.equal(s.controller.get(lead.id)!.leadRules, true, 'Session info reflects the merged value');

    // A host that cannot print the project's rules: the lead rules alone, still one flag, still shown as on.
    s.ws.psettingsOut = null;
    const alone = await another(s, { lead: true, cwd: REPO });
    assert.equal(alone.args.filter((a) => a === '--settings').length, 1);
    assert.equal(leadSettingsOf(alone.args), leadRulesSettings(REPO));
    assert.equal(s.controller.get(alone.id)!.leadRules, true);

    // Not a lead: the project's file path, as before (T-323).
    const plain = await another(s, { cwd: REPO });
    assert.equal(plain.args[plain.args.indexOf('--settings') + 1], `${REPO}/.claude/settings.json`);
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
