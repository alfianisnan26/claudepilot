// The panel chat's tool activity rows (PILOT-1111, owner: "tool grouping on the session chat, like the pilot approach"): calls between two
// text lines fold into one row with the portal's row model, labels and icons; the row renders collapsed, opens to one line per call, and
// follows new calls as they stream in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReporterChatMessage } from '@portal/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ACTIVITY_FIRST, chatItems, runTook, stepText, type ChatItem } from './chatModel';
import { ToolActivity } from './ToolActivity';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const base = { from: null, tool: null, images: [] };
const text = (seq: number, kind: 'user' | 'assistant' = 'assistant'): ReporterChatMessage => ({ ...base, seq, at: at(seq), kind, text: `m${seq}` });
const call = (seq: number, tool: string, arg = '', id = `c${seq}`): ReporterChatMessage => ({ ...base, seq, at: at(seq), kind: 'tool', tool, text: arg, toolId: id });
const done = (seq: number, id: string, error?: string): ReporterChatMessage => ({ ...base, seq, at: at(seq), kind: 'tool_result', text: error ?? '', toolId: id, ok: !error });

const activities = (items: ChatItem[]) => items.filter((i): i is Extract<ChatItem, { type: 'activity' }> => i.type === 'activity');

test('chatItems: the calls between two text lines are one activity; results join their calls and are never a line of their own', () => {
  const items = chatItems(
    [text(1, 'user'), call(2, 'Read', '/src/a.tsx'), done(3, 'c2'), call(4, 'Bash', 'npm test'), done(5, 'c4'), text(6), call(7, 'Edit', '/src/a.tsx'), done(8, 'c7'), text(9)],
    false,
  );
  assert.deepEqual(
    items.map((i) => (i.type === 'line' ? i.m.kind : `activity:${i.steps.length}`)),
    ['user', 'activity:2', 'assistant', 'activity:1', 'assistant'],
  );
  const [a] = activities(items);
  assert.equal(a!.key, 'a2', 'keyed by its first call, so it keeps its state as calls join it');
  assert.ok(a!.steps.every((s) => s.result), 'each call has its result');
  assert.ok(!a!.live);
});

test('chatItems: a run of read-only calls folds as in the portal (one group row "2 files read · 1 search"); others stay rows', () => {
  const [a] = activities(
    chatItems([call(1, 'Read', '/a.ts'), done(2, 'c1'), call(3, 'Read', '/b.ts'), done(4, 'c3'), call(5, 'Grep', 'hero'), done(6, 'c5'), call(7, 'Bash', 'npm run build'), done(8, 'c7')], false),
  );
  assert.deepEqual(
    a!.rows.map((r) => r.type),
    ['group', 'tool'],
  );
  const html = renderToStaticMarkup(createElement('ol', null, createElement(ToolActivity, { item: a!, initiallyOpen: true })));
  assert.match(html, /2 files read · 1 search/);
  assert.match(html, /npm run build/);
});

test('chatItems: running only while the session works and the run is the newest thing; a failure is marked with its one-line error', () => {
  const lines = [text(1, 'user'), call(2, 'Bash', 'npm test'), done(3, 'c2', 'exit 1: 2 tests failed'), call(4, 'Read', '/x.ts')];
  const [live] = activities(chatItems(lines, true));
  assert.ok(live!.live);
  assert.equal(live!.steps[1]!.result, null, 'the read still runs');
  assert.equal(live!.steps[0]!.result!.isError, true);
  assert.equal(live!.steps[0]!.result!.text, 'exit 1: 2 tests failed');
  const [idle] = activities(chatItems(lines, false));
  assert.ok(!idle!.live, 'an idle session runs nothing (a call whose result never came is not spinning forever)');
  const [older] = activities(chatItems([...lines, text(5)], true));
  assert.ok(!older!.live, 'a run with text after it is done');
  const approval: ReporterChatMessage = { ...base, seq: 6, at: at(6), kind: 'approval', text: 'Run a command: npm test' };
  const [waiting] = activities(chatItems([...lines, approval], true));
  assert.ok(waiting!.live, 'an approval the run waits on does not end it');
  const split = chatItems([call(1, 'Bash', 'npm test'), { ...approval, seq: 2 }, done(3, 'c1'), call(4, 'Read', '/a.ts')], false);
  assert.deepEqual(
    split.map((i) => (i.type === 'line' ? i.m.kind : `activity:${i.steps.length}`)),
    ['activity:2'],
    'approval lines are not rows (as in the portal transcript): they never split a run',
  );
  assert.notEqual(live!.sig, idle!.sig);
});

test('chatItems: unknown and MCP tools, and a sub-agent call reading "Agent: <what it does>"', () => {
  const [a] = activities(chatItems([call(1, 'mcp__playwright__browser_click', 'Submit'), call(2, 'Frobnicate'), call(3, 'Task', 'Find the hero component')], false));
  assert.deepEqual(
    a!.steps.map(stepText),
    ['playwright · browser_click Submit', 'Frobnicate', 'Agent: Find the hero component'],
  );
  const html = renderToStaticMarkup(createElement('ol', null, createElement(ToolActivity, { item: a!, initiallyOpen: true })));
  assert.match(html, /Agent: Find the hero component/);
  assert.match(html, /playwright · browser_click/);
});

test('chatItems: a result whose call is not loaded (an older page) is left out; the memo key changes only with what shows', () => {
  const items = chatItems([done(1, 'gone'), text(2)], false);
  assert.deepEqual(
    items.map((i) => i.type),
    ['line'],
  );
  const a1 = activities(chatItems([call(1, 'Read', '/a')], true))[0]!;
  const a2 = activities(chatItems([call(1, 'Read', '/a')], true))[0]!;
  assert.equal(a1.sig, a2.sig);
  const a3 = activities(chatItems([call(1, 'Read', '/a'), done(2, 'c1')], true))[0]!;
  assert.notEqual(a1.sig, a3.sig, 'a result coming in re-renders the row');
});

test('runTook: from the first call to the last result, only once every call is done', () => {
  const [a] = activities(chatItems([call(1, 'Read', '/a'), call(2, 'Read', '/b'), done(5, 'c1'), done(13, 'c2')], false));
  assert.equal(runTook(a!.steps), '12 s');
  const [b] = activities(chatItems([call(1, 'Read', '/a')], false));
  assert.equal(runTook(b!.steps), null);
});

test('ToolActivity: collapsed by default, a button with aria-expanded and a readable label naming the latest step and failures', () => {
  const [a] = activities(chatItems([call(1, 'Bash', 'npm test'), done(2, 'c1', 'boom'), call(3, 'Read', '/src/hero.tsx'), done(4, 'c3')], false));
  const html = renderToStaticMarkup(createElement('ol', null, createElement(ToolActivity, { item: a! })));
  assert.match(html, /<button type="button" aria-expanded="false"/);
  assert.match(html, /aria-label="2 steps, 1 failed\. Latest: Read hero\.tsx"/);
  assert.match(html, /bg-danger-soft/, 'the failed step’s icon is red');
  assert.doesNotMatch(html, /boom/, 'the error shows only opened');
  const open = renderToStaticMarkup(createElement('ol', null, createElement(ToolActivity, { item: a!, initiallyOpen: true })));
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /boom/, 'opened, a failed call shows its one-line error');
  assert.match(open, /2 s/, 'and how long the run took');
});

test('ToolActivity: live, the latest step shimmers and the label follows each new call', () => {
  const lines = [call(1, 'Read', '/a.ts'), done(2, 'c1')];
  const first = activities(chatItems(lines, true))[0]!;
  const later = activities(chatItems([...lines, call(3, 'Bash', 'npm run build')], true))[0]!;
  const h1 = renderToStaticMarkup(createElement('ol', null, createElement(ToolActivity, { item: first })));
  const h2 = renderToStaticMarkup(createElement('ol', null, createElement(ToolActivity, { item: later })));
  assert.match(h1, /Latest: Read a\.ts/);
  assert.match(h2, /2 steps, running\. Latest: Bash npm run build/);
  assert.match(h2, /shimmer/);
  assert.equal(first.key, later.key, 'the same row (same React key), so an opened row stays open');
});

test('ToolActivity: a long run shows its first rows and "Show N more"', () => {
  const lines: ReporterChatMessage[] = [];
  // Edits never fold into a read-only group: each is its own row.
  for (let i = 1; i <= 12; i++) lines.push(call(i, 'Edit', `/src/f${i}.ts`));
  const [a] = activities(chatItems(lines, false));
  assert.equal(a!.rows.length, 12);
  const html = renderToStaticMarkup(createElement('ol', null, createElement(ToolActivity, { item: a!, initiallyOpen: true })));
  assert.match(html, new RegExp(`Show ${12 - ACTIVITY_FIRST} more`));
  assert.match(html, /f8\.ts/);
  assert.doesNotMatch(html, /f9\.ts/);
  assert.match(html, /\+6/, 'collapsed chips: five earlier icons, the rest as +N');
});
