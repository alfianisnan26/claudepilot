// T-971 H1: the refusal watcher. Grouping by (workspace, rule shape), de-dupe, redaction (a credential-shaped value built at runtime
// never reaches a ticket), the rate limit, and the stored-result query it reads. On a fake clock; no rule is ever changed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatStore, type RefusalEventRow } from '../chat/store.js';
import { bashShape, classify, groupRefusals, groupTag, RefusalSweep, RefusalWatcher, REFUSAL_TAG } from './refusals.js';
import { ticketsHarness, UI } from './testkit.js';

const WS = 'kubernetes/kohi-event';
const DENIED = "Permission to use Bash has been denied because Claude Code is running in don't ask mode.";

let n = 0;
const row = (over: Partial<RefusalEventRow> = {}): RefusalEventRow => ({
  sessionId: 's1',
  seq: ++n,
  at: new Date(Date.now() - 1000).toISOString(),
  workspaceId: WS,
  text: DENIED,
  toolName: 'Bash',
  command: 'git push origin main',
  ...over,
});

/** A source over an array: what is at or after `sinceAt`. */
const sourceOf = (rows: RefusalEventRow[]) => (since: string, limit: number) => rows.filter((r) => r.at >= since).slice(0, limit);

async function rig(rows: RefusalEventRow[], perHour?: number) {
  let at = Date.now();
  const h = await ticketsHarness({ now: () => new Date(at) });
  const w = new RefusalWatcher({ source: sourceOf(rows), tickets: h.tickets, now: () => new Date(at), ...(perHour ? { perHour } : {}) });
  return { h, w, rows, advance: (ms: number) => void (at += ms) };
}

test('bashShape: the program, and the subcommand of a program that has them; unreadable words give null', () => {
  assert.equal(bashShape('git push origin main'), 'git push');
  assert.equal(bashShape('git -C /tmp/x reset --hard'), 'git reset');
  assert.equal(bashShape('FOO=1 /home/node/work/claudepilot/scripts/job-run.sh --ref x'), 'job-run.sh');
  assert.equal(bashShape('npm test'), 'npm test');
  assert.equal(bashShape('ls -la'), 'ls');
  assert.equal(bashShape('$(evil) x'), null);
  assert.equal(bashShape('"quoted prog" x'), null);
  assert.equal(bashShape(''), null);
});

test('classify: a permission denial, a Portal MCP FORBIDDEN and FOLDER_UNTRUSTED; any other failure is not a refusal', () => {
  assert.deepEqual(classify({ text: DENIED, toolName: 'Bash', command: 'git push origin x' }), { kind: 'permission', shape: 'git push', proposed: 'Bash(git push:*)' });
  assert.equal(classify({ text: 'Permission to use Edit has been denied', toolName: 'Edit', command: null })?.shape, 'Edit');
  const f = classify({ text: '{"code":"FORBIDDEN","message":"Agents can act only in their own workspace"}', toolName: 'mcp__pilot__ticket_create', command: null });
  assert.equal(f?.kind, 'portal_forbidden');
  assert.equal(f?.shape, 'mcp__pilot__ticket_create');
  assert.equal(classify({ text: '409 FOLDER_UNTRUSTED', toolName: null, command: null })?.kind, 'folder_untrusted');
  assert.equal(classify({ text: 'exit code 1: no such file', toolName: 'Bash', command: 'cat x' }), null);
  assert.equal(classify({ text: DENIED, toolName: 'Bash', command: '$(x)' })?.proposed.startsWith('(none'), true, 'no line is proposed for a command it cannot read');
});

test('grouping: one group per (workspace, rule shape), counting events and sessions; another workspace or shape is another group', () => {
  const rows = [
    row({ command: 'git push origin a' }),
    row({ command: 'git push origin b', sessionId: 's2' }),
    row({ command: 'git push -f origin c', sessionId: 's2' }),
    row({ command: 'git reset --hard' }),
    row({ command: 'git push origin a', workspaceId: 'docker/other' }),
    row({ text: 'plain failure', command: 'cat nothing' }),
  ];
  const g = groupRefusals(rows);
  assert.equal(g.size, 3, 'push and reset here, push there; the plain failure is no refusal');
  const push = g.get(groupTag(WS, { kind: 'permission', shape: 'git push', proposed: '' }))!;
  assert.equal(push.count, 3);
  assert.deepEqual(push.sessions.sort(), ['s1', 's2']);
  assert.equal(g.get(groupTag('docker/other', { kind: 'permission', shape: 'git push', proposed: '' }))!.count, 1);
  assert.match(groupTag(WS, { kind: 'permission', shape: 'git push', proposed: '' }), /^refusal-[0-9a-f]{8}$/);
});

test('files ONE ticket per group FOR THE COORDINATOR, with the command, the rule and a proposed line; no rule is changed', async () => {
  const r = await rig([row(), row({ seq: 99 }), row({ command: 'git reset --hard HEAD~1' }), row({ toolName: 'mcp__pilot__ticket_close', text: 'FORBIDDEN', command: null })]);
  try {
    const filed = r.w.scan();
    assert.equal(filed.length, 3);
    const push = filed.find((t) => t.summary.includes('git push'))!;
    assert.match(push.summary, /^FOR THE COORDINATOR: git push refused in kubernetes\/kohi-event$/);
    const t = r.h.tickets.get(UI, push.id).ticket;
    assert.match(t.description, /^FOR THE COORDINATOR: Bash\(git push:\*\)/);
    assert.match(t.description, /Latest command \(redacted\): `git push origin main`/);
    assert.match(t.description, /refused 2 times/);
    assert.ok(t.tags.includes(REFUSAL_TAG) && t.tags.some((x) => /^refusal-[0-9a-f]{8}$/.test(x)));
    assert.equal(t.source, 'system');
  } finally {
    r.h.done();
  }
});

test('de-dupe: a second pass, new refusals of a filed group and a restart (a new watcher) file nothing while the ticket is open', async () => {
  const rows = [row()];
  const r = await rig(rows);
  try {
    assert.equal(r.w.scan().length, 1);
    assert.equal(r.w.scan().length, 0, 'the same events again');
    rows.push(row({ command: 'git push origin z', at: new Date().toISOString() }));
    assert.equal(r.w.scan().length, 0, 'the same group, a new event');
    const restarted = new RefusalWatcher({ source: sourceOf(rows), tickets: r.h.tickets });
    assert.equal(restarted.scan().length, 0, 'an open ticket carries the group’s tag');
    assert.equal(r.h.tickets.list(UI, { tag: REFUSAL_TAG }).total, 1);
    // closed by the coordinator: a restart may raise it again (the rule is still missing)
    const id = r.h.tickets.list(UI, { tag: REFUSAL_TAG }).items[0]!.id;
    r.h.tickets.close(UI, id, { summary: 'line added' });
    assert.equal(new RefusalWatcher({ source: sourceOf(rows), tickets: r.h.tickets }).scan().length, 1);
  } finally {
    r.h.done();
  }
});

test('redaction: a credential-shaped value in the command or the refusal never reaches the ticket', async () => {
  const secret = `gh${'p'}_${'a1B2'.repeat(8)}`; // built at runtime
  const second = `sk-${'ant'}-${'x9Y8'.repeat(8)}`;
  const r = await rig([row({ command: `git push https://x:${secret}@example.test/r.git main`, text: `${DENIED} ${second}` })]);
  try {
    const [t] = r.w.scan();
    const full = r.h.tickets.get(UI, t!.id).ticket;
    for (const part of [full.summary, full.description]) {
      assert.ok(!part.includes(secret), 'the token is not in the ticket');
      assert.ok(!part.includes(second), 'nor the second one');
    }
    assert.ok(full.description.includes('[redacted]'));
  } finally {
    r.h.done();
  }
});

test('rate limit: at most perHour tickets in an hour; the rest wait, and are filed once the hour has passed', async () => {
  const rows = ['git push', 'git reset', 'git clean', 'git rebase', 'git restore'].map((c) => row({ command: `${c} x` }));
  const r = await rig(rows, 2);
  try {
    assert.equal(r.w.scan().length, 2);
    assert.equal(r.w.scan().length, 0, 'still inside the hour');
    r.advance(61 * 60_000);
    assert.equal(r.w.scan().length, 2, 'the held groups, two more');
    r.advance(61 * 60_000);
    assert.equal(r.w.scan().length, 1);
    assert.equal(r.h.tickets.list(UI, { tag: REFUSAL_TAG }).total, 5);
  } finally {
    r.h.done();
  }
});

test('the sweep runs a pass per interval, survives a failing pass and stops', () => {
  const timers: (() => void)[] = [];
  let calls = 0;
  const sweep = new RefusalSweep(
    {
      scan: () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return [];
      },
    },
    1000,
    (fn) => (timers.push(fn), {}),
    () => undefined,
  );
  const errors = console.error;
  console.error = () => undefined;
  try {
    sweep.start();
    timers.shift()!();
    timers.shift()!();
    assert.equal(calls, 2, 'the loop went on after the failing pass');
    sweep.stop();
    assert.equal(timers.length, 1);
    timers.shift()!();
    assert.equal(calls, 2, 'stopped');
  } finally {
    console.error = errors;
  }
});

test('the store query: failed tool results that read as refusals, with their workspace, tool and command; others are left out', async () => {
  const h = await ticketsHarness();
  try {
    const chat = new ChatStore(h.store);
    chat.create({ id: 'c1', workspaceId: WS, cwd: '/w', title: 't', origin: 'ui' });
    const before = new Date(Date.now() - 60_000).toISOString();
    chat.appendEvent('c1', { kind: 'tool_use', toolName: 'Bash', toolUseId: 'u1', toolInput: { command: 'git push origin main' } });
    chat.appendEvent('c1', { kind: 'tool_result', toolUseId: 'u1', text: DENIED, isError: true });
    chat.appendEvent('c1', { kind: 'tool_use', toolName: 'Bash', toolUseId: 'u2', toolInput: { command: 'cat x' } });
    chat.appendEvent('c1', { kind: 'tool_result', toolUseId: 'u2', text: 'no such file', isError: true });
    chat.appendEvent('c1', { kind: 'tool_use', toolName: 'Bash', toolUseId: 'u3', toolInput: { command: 'echo' } });
    chat.appendEvent('c1', { kind: 'tool_result', toolUseId: 'u3', text: `has been denied in a file it printed`, isError: false });
    const rows = chat.refusalEvents(before, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.workspaceId, WS);
    assert.equal(rows[0]!.toolName, 'Bash');
    assert.equal(rows[0]!.command, 'git push origin main');
    assert.equal(chat.refusalEvents(new Date(Date.now() + 60_000).toISOString(), 10).length, 0, 'nothing before the cursor comes back');
  } finally {
    h.done();
  }
});
