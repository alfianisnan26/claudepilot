import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_ENDED_CREDENTIAL, CHAT_ENDED_INTEGRITY, type ChatSession } from '@portal/contracts';
import {
  agentFacets,
  agentStatus,
  buildAgentTrees,
  costLabel,
  costParts,
  DISMISS_KEY,
  DISMISS_MAX,
  dismissFailed,
  edgeFade,
  elapsedLabel,
  FILTER_KEY,
  filterTree,
  flatten,
  foldedLabel,
  isDismissed,
  modelMaker,
  readDismissed,
  readFilter,
  retryKind,
  writeFilter,
} from './agentTreeData';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const at = (sec: number) => new Date(NOW - sec * 1000).toISOString();
let n = 0;
/** A session; `born` is how many seconds ago it started, `last` its latest activity. */
function s(over: Partial<ChatSession> & { born?: number; last?: number } = {}): ChatSession {
  const { born = 100, last = 0, ...rest } = over;
  n++;
  return {
    id: `s${n}`,
    workspaceId: 'docker/ws',
    cwd: '/home/node',
    title: `S ${n}`,
    state: 'idle',
    origin: 'ui',
    model: null,
    mode: 'default',
    effort: null,
    ultracode: false,
    ultracodeAvailable: false,
    process: 'live',
    context: null,
    costUsd: 0,
    turns: 0,
    lastSeq: 0,
    waiting: 0,
    waitingFor: null,
    agentsRunning: 0,
    createdAt: at(born),
    lastActivityAt: at(last),
    endedReason: null,
    claudeId: '',
    claudeName: 'Default',
    previousClaudes: [],
    parentId: null,
    ticketId: null,
    worktree: null,
    pinnedAt: null,
    archivedAt: null,
    ...rest,
  } as ChatSession;
}

/** A store in memory, like localStorage. */
function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

test('a lead with workers and their workers is one tree; workers in spawn order; a session with no workers is no tree', () => {
  const list = [
    s({ id: 'lead', born: 300 }),
    s({ id: 'b', parentId: 'lead', born: 100 }),
    s({ id: 'a', parentId: 'lead', born: 200 }),
    s({ id: 'a1', parentId: 'a', born: 150 }),
    s({ id: 'alone', born: 50 }),
  ];
  const trees = buildAgentTrees(list, { now: NOW });
  assert.equal(trees.length, 1);
  const root = trees[0]!.root;
  assert.equal(root.session.id, 'lead');
  assert.deepEqual(
    root.children.map((c) => c.session.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    root.children[0]!.children.map((c) => c.session.id),
    ['a1'],
  );
  assert.equal(root.descendants, 3);
  assert.equal(root.children[0]!.descendants, 1);
  assert.deepEqual(
    flatten(root).map((x) => x.session.id),
    ['lead', 'a', 'a1', 'b'],
  );
});

test('a worker whose lead is not in the list leads its own tree; archived sessions are left out; newest lead first', () => {
  const list = [
    s({ id: 'old', born: 900 }),
    s({ id: 'old-w', parentId: 'old', born: 800 }),
    s({ id: 'orphan', parentId: 'gone', born: 500 }),
    s({ id: 'orphan-w', parentId: 'orphan', born: 400 }),
    s({ id: 'arch', born: 100, archivedAt: at(1) }),
    s({ id: 'arch-w', parentId: 'arch', born: 50 }),
  ];
  const trees = buildAgentTrees(list, { now: NOW });
  assert.deepEqual(
    trees.map((t) => t.root.session.id),
    ['orphan', 'old'],
  );
});

test('a cycle in parentId never loops', () => {
  const list = [s({ id: 'x', parentId: 'y' }), s({ id: 'y', parentId: 'x' })];
  assert.deepEqual(buildAgentTrees(list, { now: NOW }), []);
});

test('status mapping: running, waiting, failed, done, asleep, idle', () => {
  assert.equal(agentStatus(s({ state: 'working' })), 'running');
  assert.equal(agentStatus(s({ state: 'starting' })), 'running');
  assert.equal(agentStatus(s({ state: 'idle', agentsRunning: 2 })), 'running');
  assert.equal(agentStatus(s({ state: 'waiting' })), 'waiting');
  assert.equal(agentStatus(s({ state: 'working', waiting: 1 })), 'waiting');
  assert.equal(agentStatus(s({ state: 'interrupted', process: 'gone' })), 'failed');
  assert.equal(agentStatus(s({ state: 'ended', endedReason: `${CHAT_ENDED_INTEGRITY}odd line` })), 'failed');
  assert.equal(agentStatus(s({ state: 'ended', endedReason: `${CHAT_ENDED_CREDENTIAL}key in output` })), 'failed');
  assert.equal(agentStatus(s({ state: 'ended', endedReason: 'the run failed with an error' })), 'failed');
  assert.equal(agentStatus(s({ state: 'ended', endedReason: 'closed by operator' })), 'done');
  assert.equal(agentStatus(s({ state: 'ended', endedReason: null })), 'done');
  assert.equal(agentStatus(s({ state: 'idle', process: 'asleep' })), 'asleep');
  assert.equal(agentStatus(s({ state: 'idle', process: 'live' })), 'idle');
});

test('retry: an interrupted agent resumes, an integrity ending recovers, a credential ending has none', () => {
  assert.equal(retryKind(s({ state: 'interrupted' })), 'resume');
  assert.equal(retryKind(s({ state: 'ended', endedReason: `${CHAT_ENDED_INTEGRITY}x` })), 'recover');
  assert.equal(retryKind(s({ state: 'ended', endedReason: `${CHAT_ENDED_CREDENTIAL}x` })), null);
  assert.equal(retryKind(s({ state: 'ended', endedReason: 'crashed' })), null);
});

test('totals: agents, running, cost (with a running turn’s estimate) over the whole tree', () => {
  const list = [
    s({ id: 'lead', title: 'Lead', state: 'working', costUsd: 1, born: 66 }),
    s({ id: 'w1', parentId: 'lead', state: 'ended', costUsd: 0.25 }),
    s({ id: 'w2', parentId: 'lead', state: 'working', costUsd: 0.1, turnCostEstimateUsd: 0.05 }),
    s({ id: 'w2a', parentId: 'w2', state: 'interrupted', costUsd: 0.02 }),
  ];
  const [t] = buildAgentTrees(list, { now: NOW });
  assert.equal(t!.total, 4);
  assert.equal(t!.running, 2);
  assert.ok(Math.abs(t!.costUsd - 1.42) < 1e-9);
  assert.equal(t!.root.task, null);
  assert.equal(t!.root.name, 'Lead');
});

test('card: the role is the name and the title the task; the model is short; elapsed runs to now while going, else to the last activity', () => {
  const list = [
    s({ id: 'lead', agent: 'orchestrator', title: 'Launch the pricing page', model: 'claude-opus-5-5', state: 'working', born: 66 }),
    s({ id: 'w', parentId: 'lead', title: 'Write copy', model: 'claude-sonnet-5-5', state: 'ended', born: 100, last: 45 }),
  ];
  const root = buildAgentTrees(list, { now: NOW })[0]!.root;
  assert.equal(root.name, 'Orchestrator');
  assert.equal(root.task, 'Launch the pricing page');
  assert.equal(root.model, 'Opus 5.5');
  assert.equal(root.elapsedMs, 66_000);
  const w = root.children[0]!;
  assert.equal(w.name, 'Write copy');
  assert.equal(w.task, null);
  assert.equal(w.model, 'Sonnet 5.5');
  assert.equal(w.elapsedMs, 55_000);
});

test('failed list: in reading order, without the dismissed ones', () => {
  const list = [
    s({ id: 'lead' }),
    s({ id: 'f1', parentId: 'lead', state: 'interrupted', born: 90 }),
    s({ id: 'f2', parentId: 'lead', state: 'ended', endedReason: `${CHAT_ENDED_INTEGRITY}x`, born: 80 }),
    s({ id: 'ok', parentId: 'lead', state: 'ended', born: 70 }),
  ];
  assert.deepEqual(
    buildAgentTrees(list, { now: NOW })[0]!.failed.map((x) => x.session.id),
    ['f1', 'f2'],
  );
  const failed = buildAgentTrees(list, { now: NOW, dismissed: (x) => x.id === 'f1' })[0]!.failed;
  assert.deepEqual(
    failed.map((x) => x.session.id),
    ['f2'],
  );
});

test('query keeps the trees with an agent that matches', () => {
  const list = [s({ id: 'l1', title: 'Pricing' }), s({ id: 'w1', parentId: 'l1', title: 'checkout tests' }), s({ id: 'l2', title: 'Other' }), s({ id: 'w2', parentId: 'l2' })];
  assert.deepEqual(
    buildAgentTrees(list, { now: NOW, query: 'checkout' }).map((t) => t.root.session.id),
    ['l1'],
  );
});

test('labels: elapsed and cost', () => {
  assert.equal(elapsedLabel(45_000), '45s');
  assert.equal(elapsedLabel(66_000), '1m 06s');
  assert.equal(elapsedLabel(2 * 3600_000 + 5 * 60_000), '2h 05m');
  assert.equal(costLabel(1.52), '$1.52');
  assert.equal(costLabel(0.04), '$0.04');
  assert.equal(costLabel(0.003), '$0.003');
  assert.equal(costLabel(0), '$0.00');
});

test('T-1825: a cost in two parts, the cents apart (muted on the card)', () => {
  assert.deepEqual(costParts(1.52), { whole: '$1', fraction: '.52' });
  assert.deepEqual(costParts(0.003), { whole: '$0', fraction: '.003' });
  assert.deepEqual(costParts(0), { whole: '$0', fraction: '.00' });
  assert.deepEqual(costParts(123.4), { whole: '$123', fraction: '.40' });
});

test('T-1825: the model glyph: Claude for a Claude family or id, other for an id the portal cannot read, none before a report', () => {
  assert.equal(modelMaker('claude-opus-5-5'), 'claude');
  assert.equal(modelMaker('sonnet'), 'claude');
  assert.equal(modelMaker('us.anthropic.claude-haiku-4-5-20251001-v1:0'), 'claude');
  assert.equal(modelMaker('gpt-6-sol'), 'openai');
  assert.equal(modelMaker('openai/o4-mini'), 'openai');
  assert.equal(modelMaker('o3'), 'openai');
  assert.equal(modelMaker('gemini-3.8-flash'), 'gemini');
  assert.equal(modelMaker('ollama/qwen3:32b'), 'ollama');
  assert.equal(modelMaker('llama-4-scout'), 'other', 'a Llama may run anywhere: only an Ollama id says Ollama');
  assert.equal(modelMaker('mistral-large'), 'other');
  assert.equal(modelMaker('folio-2'), 'other', 'an o followed by letters is no OpenAI o-series');
  assert.equal(modelMaker(null), null);
  assert.equal(modelMaker('  '), null);
});

test('T-1825: card icons are facts of the session: its own worktree, Bypass on', () => {
  assert.deepEqual(agentFacets(s()), []);
  assert.deepEqual(
    agentFacets(s({ worktree: { path: '/w', branch: 'ticket/x', repo: '/r' } as ChatSession['worktree'], mode: 'bypassPermissions' })),
    ['branch', 'bypass'],
  );
  assert.deepEqual(agentFacets(s({ mode: 'auto' })), []);
});

test('T-1825: edge fade: none when it fits, the side with more beyond it otherwise', () => {
  assert.deepEqual(edgeFade(0, 800, 800), { left: false, right: false });
  assert.deepEqual(edgeFade(0, 1200, 800), { left: false, right: true });
  assert.deepEqual(edgeFade(200, 1200, 800), { left: true, right: true });
  assert.deepEqual(edgeFade(400, 1200, 800), { left: true, right: false });
  assert.deepEqual(edgeFade(399.5, 1200, 800), { left: true, right: false });
});

test('dismiss: kept in storage, read back, and holds only for the same failure', () => {
  const store = memory();
  const f = s({ id: 'f', state: 'interrupted', endedReason: 'lost' });
  const d = dismissFailed(f, readDismissed(store), store);
  assert.ok(isDismissed(d, f));
  assert.ok(isDismissed(readDismissed(store), f));
  // Retried, and it failed again for another reason: it counts again.
  assert.ok(!isDismissed(readDismissed(store), { ...f, endedReason: 'lost again' }));
});

test('dismiss: storage that throws or holds junk never breaks the view', () => {
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(readDismissed(throwing), {});
  const f = s({ id: 'f', state: 'interrupted' });
  const d = dismissFailed(f, {}, throwing);
  assert.ok(isDismissed(d, f), 'kept in memory for this visit');
  assert.deepEqual(readDismissed(memory({ [DISMISS_KEY]: 'not json' })), {});
  assert.deepEqual(readDismissed(memory({ [DISMISS_KEY]: '[1,2]' })), {});
  assert.deepEqual(readDismissed(memory({ [DISMISS_KEY]: '{"a":"x","b":3}' })), { a: 'x' });
  assert.deepEqual(readDismissed(null), {});
});

test('dismiss: at most DISMISS_MAX are kept, the oldest go first', () => {
  const store = memory();
  let d: Record<string, string> = {};
  for (let i = 0; i < DISMISS_MAX + 5; i++) d = dismissFailed(s({ id: `x${i}`, state: 'interrupted' }), d, store);
  const kept = readDismissed(store);
  assert.equal(Object.keys(kept).length, DISMISS_MAX);
  assert.ok(!('x0' in kept));
  assert.ok(`x${DISMISS_MAX + 4}` in kept);
});

/** T-1853: a lead (idle) → a (idle) → a1 (running); b (waiting); c (done); d (asleep) → d1 (failed). */
function crew() {
  const list = [
    s({ id: 'lead', born: 900 }),
    s({ id: 'a', parentId: 'lead', born: 800 }),
    s({ id: 'a1', parentId: 'a', born: 700, state: 'working' }),
    s({ id: 'b', parentId: 'lead', born: 600, waiting: 1 }),
    s({ id: 'c', parentId: 'lead', born: 500, state: 'ended', endedReason: 'closed' }),
    s({ id: 'd', parentId: 'lead', born: 400, process: 'asleep' }),
    s({ id: 'd1', parentId: 'd', born: 300, state: 'interrupted' }),
  ];
  return buildAgentTrees(list, { now: NOW })[0]!.root;
}
const ids = (n: ReturnType<typeof crew>) => flatten(n).map((x) => x.session.id);

test('T-1853: Active shows the agents at work and the leads above them; idle and ended fold behind a count', () => {
  const { root, folded } = filterTree(crew(), 'active');
  assert.deepEqual(ids(root), ['lead', 'a', 'a1', 'b'], 'a is idle but stays: it leads a running worker');
  assert.equal(root.descendants, 3, 'the toggle counts what is shown');
  assert.deepEqual(folded, { idle: 1, ended: 2, running: 0 });
  assert.equal(foldedLabel(folded), '+1 idle · 2 ended');
});

test('T-1853: Waiting shows only the waiting ones; All shows every agent, the same nodes, nothing folded', () => {
  const w = filterTree(crew(), 'waiting');
  assert.deepEqual(ids(w.root), ['lead', 'b']);
  assert.deepEqual(w.folded, { idle: 2, ended: 2, running: 1 });
  assert.equal(foldedLabel(w.folded), '+1 running · 2 idle · 2 ended');
  const full = crew();
  const all = filterTree(full, 'all');
  assert.equal(all.root, full, 'unchanged when nothing is folded');
  assert.equal(foldedLabel(all.folded), null);
});

test('T-1853: a tree with nobody at work still shows its lead, with the rest folded', () => {
  const quiet = buildAgentTrees([s({ id: 'l' }), s({ id: 'w', parentId: 'l', state: 'ended', endedReason: 'closed' })], { now: NOW })[0]!.root;
  const { root, folded } = filterTree(quiet, 'active');
  assert.deepEqual(ids(root), ['l']);
  assert.equal(root.descendants, 0);
  assert.equal(foldedLabel(folded), '+1 ended');
});

test('T-1853: the filter is kept per viewer; junk, missing or throwing storage reads as Active', () => {
  const store = memory();
  assert.equal(readFilter(store), 'active');
  writeFilter('all', store);
  assert.equal(store.m.get(FILTER_KEY), 'all');
  assert.equal(readFilter(store), 'all');
  assert.equal(readFilter(memory({ [FILTER_KEY]: 'bogus' })), 'active');
  const broken = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(readFilter(broken), 'active');
  assert.doesNotThrow(() => writeFilter('waiting', broken));
  assert.equal(readFilter(null), 'active');
});
