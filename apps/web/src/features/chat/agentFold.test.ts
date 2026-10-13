// Sub-agents never take the main agent's place (ticket T-31): their live text stays out of the main reply, and their stored lines fold
// into the activity row of the turn that started them, however late they come.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatEvent } from '@portal/contracts';
import { agentLatest, buildItems, latestLine, modelShort, type Item } from './agentFold';
import { foldLive, NO_LIVE, settleLive, type DeltaMessage, type LiveState } from './motion/deltas';
import { buildRows } from './ToolRows';

let seq = 0;
const ev = (e: Omit<ChatEvent, 'seq' | 'at'>): ChatEvent => ({ seq: ++seq, at: '2026-10-13T08:00:00.000Z', ...e });
const user = (text: string) => ev({ kind: 'user', text });
const call = (id: string, name = 'Agent', text = 'A task', parent?: string) =>
  ev({ kind: 'tool_use', toolName: name, toolUseId: id, text, ...(parent ? { parentToolUseId: parent, agentLabel: parent } : {}) });
const result = (id: string, text = 'ok', parent?: string) => ev({ kind: 'tool_result', toolUseId: id, text, ...(parent ? { parentToolUseId: parent, agentLabel: parent } : {}) });
const reply = (text: string, parent?: string) => ev({ kind: 'assistant', text, ...(parent ? { parentToolUseId: parent, agentLabel: `label of ${parent}` } : {}) });
const done = () => ev({ kind: 'result', costUsd: 0.01 });

/** The items as short strings: rows by their kind and text, activity rows by their rows' heads. */
function shape(events: ChatEvent[]) {
  const finals = new Set<number>();
  let pending: number | null = null;
  for (const e of events) {
    if (e.parentToolUseId) continue;
    if (e.kind === 'assistant') pending = e.seq;
    else if (e.kind === 'tool_use' || e.kind === 'user') pending = null;
    else if (e.kind === 'result' && pending !== null) (finals.add(pending), (pending = null));
  }
  if (pending !== null) finals.add(pending);
  const { items, agentRows } = buildItems({ rows: buildRows(events, true), finals, moves: new Map(), base: 0, details: false });
  const head = (i: Item) =>
    i.kind === 'done'
      ? 'done'
      : i.kind === 'row'
        ? `${i.row.type === 'event' ? i.row.event.kind : i.row.type}:${i.row.type === 'event' ? i.row.event.text : ''}`
        : `activity[${i.rows.map((r) => (r.type === 'tool' ? `${r.call.toolName}` : r.type === 'event' ? `${r.event.kind}:${r.event.text}` : r.type)).join(',')}]${i.agents.length ? ` agents=${i.agents.join('+')}` : ''}`;
  const own = Object.fromEntries([...agentRows].map(([k, rows]) => [k, rows.map((r) => (r.type === 'tool' ? `tool:${r.call.toolName}` : r.type === 'event' ? `${r.event.kind}:${r.event.text}` : r.type))]));
  return { items: items.map(head), own };
}

describe('buildItems: sub-agents fold into the turn that started them', () => {
  it('a background agent’s lines after the main result join the starting turn, not the flow after the reply', () => {
    const s = shape([
      user('go'),
      call('toolu_a', 'Agent', 'Scan'),
      result('toolu_a', 'Async agent launched'),
      reply('Started it.'),
      done(),
      // The main agent is idle; the agent keeps writing.
      call('toolu_r', 'Read', '/etc/hostname', 'toolu_a'),
      result('toolu_r', 'kohi', 'toolu_a'),
      reply('All read.', 'toolu_a'),
    ]);
    assert.deepEqual(s.items, ['user:go', 'activity[Agent] agents=toolu_a', 'assistant:Started it.', 'done']);
    assert.deepEqual(s.own, { toolu_a: ['tool:Read', 'assistant:All read.'] });
  });

  it('two agents interleaved: each line goes to its own agent, in order', () => {
    const s = shape([
      user('go'),
      call('toolu_a', 'Agent', 'A'),
      call('toolu_b', 'Agent', 'B'),
      reply('a1', 'toolu_a'),
      reply('b1', 'toolu_b'),
      call('toolu_x', 'Bash', 'ls', 'toolu_b'),
      reply('a2', 'toolu_a'),
      result('toolu_x', 'files', 'toolu_b'),
      result('toolu_a', 'A finished'),
      result('toolu_b', 'B finished'),
      reply('Both done.'),
      done(),
    ]);
    assert.deepEqual(s.items, ['user:go', 'activity[Agent,Agent] agents=toolu_a+toolu_b', 'assistant:Both done.', 'done']);
    assert.deepEqual(s.own, { toolu_a: ['assistant:a1', 'assistant:a2'], toolu_b: ['assistant:b1', 'tool:Bash'] });
  });

  it('a main reply while an agent writes stays the turn’s reply; the agent’s line is not a reply', () => {
    const s = shape([user('go'), call('toolu_a'), reply('agent text', 'toolu_a'), reply('Main answer.'), done(), reply('late agent text', 'toolu_a')]);
    assert.deepEqual(s.items, ['user:go', 'activity[Agent] agents=toolu_a', 'assistant:Main answer.', 'done']);
    assert.deepEqual(s.own.toolu_a, ['assistant:agent text', 'assistant:late agent text']);
  });

  it('an agent started by an agent belongs to the agent the main one started; lines of an unknown call stay in the flow', () => {
    const s = shape([
      user('go'),
      call('toolu_a'),
      call('toolu_n', 'Agent', 'nested', 'toolu_a'),
      reply('from nested', 'toolu_n'),
      reply('stray', 'toolu_unknown'),
      reply('Main.'),
      done(),
    ]);
    assert.deepEqual(s.own, { toolu_a: ['tool:Agent', 'assistant:from nested'] });
    assert.deepEqual(s.items, ['user:go', 'activity[Agent,assistant:stray] agents=toolu_a', 'assistant:Main.', 'done']);
  });
});

const delta = (text: string, parent?: string, thinking = false): DeltaMessage => ({
  type: 'delta',
  session: 's',
  agentLabel: parent ? `label of ${parent}` : null,
  ...(parent ? { parentToolUseId: parent } : {}),
  text,
  ...(thinking ? { thinking: true } : {}),
});
const fold = (msgs: DeltaMessage[], from: LiveState = NO_LIVE) => msgs.reduce(foldLive, from);

describe('foldLive and settleLive: the main reply is only ever the main agent’s', () => {
  it('a background agent’s deltas after the main result never become the main reply', () => {
    let l = fold([delta('Main '), delta('answer.')]);
    l = settleLive(l, [{ kind: 'assistant' }, { kind: 'result' }]);
    assert.equal(l.main, null);
    l = fold([delta('agent is ', 'toolu_a'), delta('still writing', 'toolu_a')], l);
    assert.equal(l.main, null, 'nothing in the main reply slot');
    assert.equal(l.agents.get('toolu_a')?.text, 'agent is still writing');
  });

  it('two agents interleaved keep their own text', () => {
    const l = fold([delta('a1 ', 'toolu_a'), delta('b1 ', 'toolu_b'), delta('a2', 'toolu_a'), delta('b2', 'toolu_b')]);
    assert.equal(l.agents.get('toolu_a')?.text, 'a1 a2');
    assert.equal(l.agents.get('toolu_b')?.text, 'b1 b2');
    assert.equal(l.main, null);
  });

  it('a main reply while an agent streams: neither breaks the other, and each one’s stored block ends only its own', () => {
    let l = fold([delta('Hel'), delta('agent', 'toolu_a'), delta('lo')]);
    assert.equal(l.main?.text, 'Hello');
    assert.equal(l.main?.agentLabel, null);
    l = settleLive(l, [{ kind: 'assistant', parentToolUseId: 'toolu_a', agentLabel: 'label of toolu_a' }]);
    assert.equal(l.main?.text, 'Hello', 'the agent’s stored block leaves the main reply alone');
    assert.equal(l.agents.has('toolu_a'), false);
    l = fold([delta('more', 'toolu_a')], l);
    l = settleLive(l, [{ kind: 'assistant' }]);
    assert.equal(l.main, null);
    assert.equal(l.agents.get('toolu_a')?.text, 'more', 'the main block leaves the agent alone');
  });

  it('thinking: an agent’s shows on the agent, ends with its own stored thinking', () => {
    let l = fold([delta('', 'toolu_a', true)]);
    assert.equal(l.agents.get('toolu_a')?.thinking, true);
    assert.equal(l.main, null);
    l = settleLive(l, [{ kind: 'thinking' }]);
    assert.equal(l.agents.get('toolu_a')?.thinking, true, 'the main agent’s thinking block isn’t the agent’s');
    l = settleLive(l, [{ kind: 'thinking', parentToolUseId: 'toolu_a' }]);
    assert.equal(l.agents.has('toolu_a'), false);
  });

  it('an older server without parentToolUseId still keeps agents apart by their label', () => {
    const l = fold([{ type: 'delta', session: 's', agentLabel: 'Scan', text: 'x' }, { type: 'delta', session: 's', agentLabel: null, text: 'main' }]);
    assert.equal(l.agents.get('Scan')?.text, 'x');
    assert.equal(l.main?.text, 'main');
  });
});

describe('labels', () => {
  it('modelShort: the family, else the id as reported; null stays null (unavailable)', () => {
    assert.equal(modelShort('claude-sonnet-5-5'), 'sonnet');
    assert.equal(modelShort('claude-opus-4-6[1m]'), 'opus');
    assert.equal(modelShort('claude-fable-5-1'), 'fable');
    assert.equal(modelShort('us.anthropic.claude-haiku-4-5-20251001-v1:0'), 'haiku');
    assert.equal(modelShort('my-custom-model'), 'my-custom-model');
    assert.equal(modelShort(null), null);
  });

  it('latestLine and agentLatest: what the agent writes now, else its latest stored line', () => {
    assert.equal(latestLine('first\n\n  second line  \n'), 'second line');
    assert.equal(latestLine('x'.repeat(200)).length, 120);
    assert.equal(agentLatest(undefined, { text: 'a\nb', thinking: false }), 'b');
    assert.equal(agentLatest(undefined, { text: '', thinking: true }), 'Thinking');
    const rows = buildRows([call('t1', 'Read', '/etc/hostname', 'toolu_a')], false);
    assert.equal(agentLatest(rows, undefined), 'Read hostname');
    assert.equal(agentLatest([], undefined), null);
  });
});
