// T-109: a move to a Claude without the chat's model. The Move flow asks the destination for the model, reads back what APPLIES
// (`get_settings`), walks down the catalogue's chain when it is refused or another one runs, stores what applies on the row (never what was
// asked) with the chat's model before as `originalModel`, carries effort only where the model has it, and says so in the transcript and
// the audit trail. A fake Claude Code on the new run answers the controls the way 2.1.296 does.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ChatStore } from './store.js';
import { controls, fail, line, liveSession, ok, sleep, until, USAGE_API_KEY, type Live } from './testkit.js';

const FULL: Record<string, string> = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-4-5', haiku: 'claude-haiku-4-5' };
const full = (m: string) => FULL[m] ?? m;
const familyOf = (m: string) => Object.keys(FULL).find((f) => m.includes(f)) ?? m;

interface FakeCC {
  /** What list_models offers: family to effort levels. */
  models: Record<string, string[]>;
  /** Families whose set_model is refused. */
  refuse?: string[];
  /** Families whose set_model is accepted but leave the model as it was (a verification mismatch). */
  ignore?: string[];
  /** The model the new process starts on. */
  start?: string;
}

/** Answers the new run's controls like Claude Code until stopped; records set_model and the effort it was asked for. */
function fakeClaudeCode(s: Live, cc: FakeCC) {
  const seen = new Set<string>();
  let current = full(cc.start ?? 'sonnet');
  let effort: string | null = 'medium';
  const asked: string[] = [];
  const efforts: string[] = [];
  let stop = false;
  const newId = () => s.controller.get(s.id)!.claudeSessionId;
  const loop = (async () => {
    while (!stop) {
      const id = newId();
      if (id !== s.id) {
        const mine = new Set(s.ws.sends.filter((x) => x.args[1] === id).map((x) => x.line));
        for (const c of controls(s.ws)) {
          if (seen.has(c.id)) continue;
          const sent = [...mine].some((l) => l.includes(c.id));
          if (!sent) continue;
          const sub = c.request.subtype as string;
          const tail = s.ws.tails.at(-1)!;
          if (sub === 'get_usage') continue; // the turn's, answered by the test
          seen.add(c.id);
          if (sub === 'get_settings') tail.push(ok(c.id, { applied: { model: current, effort, ultracode: false, ultracodeAvailable: true } }));
          else if (sub === 'list_models')
            tail.push(ok(c.id, { models: Object.entries(cc.models).map(([f, levels]) => ({ value: f, displayName: f, resolvedModel: full(f), supportedEffortLevels: levels })) }));
          else if (sub === 'set_model') {
            const m = String(c.request.model);
            asked.push(familyOf(m));
            if (cc.refuse?.includes(familyOf(m)) || !cc.models[familyOf(m)]) tail.push(fail(c.id, `model ${m} is not available`));
            else {
              if (!cc.ignore?.includes(familyOf(m))) current = full(familyOf(m));
              tail.push(ok(c.id, {}));
            }
          } else if (sub === 'apply_flag_settings') {
            const e = (c.request.settings as { effortLevel?: string; effort?: string } | undefined) ?? {};
            const v = e.effortLevel ?? e.effort;
            if (v) (efforts.push(v), (effort = v));
            tail.push(ok(c.id, {}));
          } else tail.push(ok(c.id, {}));
        }
      }
      await sleep(5);
    }
  })();
  return {
    asked,
    efforts,
    current: () => current,
    async done() {
      stop = true;
      await loop;
    },
  };
}

/** The new run takes the opening: its init (on the model that applies), a line, its result and the usage check after it. */
async function acknowledge(s: Live, model: string) {
  await until(() => s.controller.get(s.id)!.claudeSessionId !== s.id);
  const id = s.controller.get(s.id)!.claudeSessionId;
  await until(() => s.ws.sends.some((x) => x.args[1] === id && x.line.includes('transferred_context')), 5000);
  const tail = s.ws.tails.at(-1)!;
  tail.push(line({ type: 'system', subtype: 'init', session_id: id, model, permissionMode: 'default', apiKeySource: 'apiKeyHelper' }));
  tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Got it.' }] }, parent_tool_use_id: null, uuid: randomUUID() }));
  tail.push(line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: id }));
  tail.push(ok((await s.take('get_usage')).id, USAGE_API_KEY));
}

async function moveWith(cc: FakeCC, opts: { model?: string; effort?: string; original?: string; returnToOriginal?: boolean; ask?: string } = {}) {
  const s = await liveSession();
  s.controller.controlTimeoutMs = 300;
  s.controller.modelWindow = () => false;
  if (opts.returnToOriginal) s.controller.returnToOriginalModel = () => true;
  const chat = new ChatStore(s.store);
  chat.patchSession(s.id, { model: full(opts.model ?? 'fable'), effort: opts.effort ?? 'medium', ...(opts.original ? { originalModel: full(opts.original) } : {}) });
  const dest = await s.controller.createClaude('docker/ws1', 'Sekar');
  const fake = fakeClaudeCode(s, { start: 'sonnet', ...cc });
  const moving = s.controller.switchClaude(s.id, dest.id, { handoff: 'skip', ...(opts.ask ? { model: opts.ask } : {}) });
  // The ack's init says the model the fake runs once restore is done (the opening goes in after it).
  await until(() => s.ws.sends.some((x) => x.args[1] !== s.id && x.line.includes('transferred_context')), 5000);
  await acknowledge(s, fake.current());
  const moved = await moving;
  await fake.done();
  const notes = s.controller.history(s.id).filter((e) => e.kind === 'system' && /^Model|Couldn/.test(e.text ?? '')).map((e) => e.text);
  const audit = s.controller.audit({ kind: 'model', sessionId: s.id });
  return { s, moved, fake, notes, audit, row: () => chat.row(s.id)!, dest };
}

test('T-109: a Fable chat moved to a Claude without Fable gets Opus: applied and verified, stored with Fable as the original, one note and one audit row', async () => {
  const r = await moveWith({ models: { opus: ['low', 'medium', 'high'], sonnet: ['low', 'medium', 'high'], haiku: [] } });
  try {
    assert.deepEqual(r.fake.asked, ['opus'], 'Fable is not listed there, so it is not even tried');
    assert.equal(r.moved.model, FULL.opus);
    assert.equal(r.moved.originalModel, FULL.fable);
    assert.equal(r.row().original_model, FULL.fable);
    assert.deepEqual(r.notes, ['Model: Fable to Opus (Sekar has no Fable).']);
    assert.equal(r.audit.length, 1);
    assert.deepEqual(r.audit[0]!.detail && { from: r.audit[0]!.detail.from, to: r.audit[0]!.detail.to, original: r.audit[0]!.detail.original }, { from: 'fable', to: 'opus', original: 'fable' });
  } finally {
    await r.s.done();
  }
});

test('T-109: an Opus chat to a Claude that only has Sonnet runs on Sonnet; never up', async () => {
  const r = await moveWith({ models: { sonnet: ['low', 'medium', 'high'], fable: ['low', 'medium', 'high'] }, start: 'haiku' }, { model: 'opus' });
  try {
    assert.deepEqual(r.fake.asked, ['sonnet'], 'Fable is listed but above Opus: never tried');
    assert.equal(r.moved.model, FULL.sonnet);
    assert.equal(r.moved.originalModel, FULL.opus);
    assert.deepEqual(r.notes, ['Model: Opus to Sonnet (Sekar has no Opus).']);
  } finally {
    await r.s.done();
  }
});

test('T-109: set_model refused twice, the third works: Fable and Opus refused, Sonnet applies', async () => {
  const r = await moveWith({ models: { fable: [], opus: [], sonnet: [] }, refuse: ['fable', 'opus'], start: 'haiku' });
  try {
    assert.deepEqual(r.fake.asked, ['fable', 'opus', 'sonnet']);
    assert.equal(r.moved.model, FULL.sonnet, 'what applies is stored, never what was asked');
    assert.equal(r.moved.originalModel, FULL.fable);
    assert.deepEqual(r.notes, ['Model: Fable to Sonnet (Sekar has no Fable).']);
  } finally {
    await r.s.done();
  }
});

test('T-109: a verification mismatch (set_model accepted, another model still runs) goes to the next one down', async () => {
  const r = await moveWith({ models: { fable: [], opus: [], sonnet: [] }, ignore: ['fable'], start: 'haiku' });
  try {
    assert.deepEqual(r.fake.asked, ['fable', 'opus']);
    assert.equal(r.moved.model, FULL.opus);
  } finally {
    await r.s.done();
  }
});

test('T-109: the effort is carried only where the model has it: xhigh becomes high on a model that tops out at high', async () => {
  const r = await moveWith({ models: { opus: ['low', 'medium', 'high'] } }, { effort: 'xhigh' });
  try {
    assert.equal(r.moved.model, FULL.opus);
    assert.deepEqual(r.fake.efforts, ['high']);
  } finally {
    await r.s.done();
  }
});

test('T-109: a destination with the chat’s model keeps it: no set_model beyond the one asked, no note, no original', async () => {
  const r = await moveWith({ models: { fable: [], opus: [] } });
  try {
    assert.deepEqual(r.fake.asked, ['fable']);
    assert.equal(r.moved.model, FULL.fable);
    assert.equal(r.moved.originalModel ?? null, null);
    assert.deepEqual(r.notes, []);
    assert.equal(r.audit.length, 0);
  } finally {
    await r.s.done();
  }
});

test('T-109: a person asks for a lower model in the switch request (the API’s model): applied, the original kept', async () => {
  const r = await moveWith({ models: { fable: [], opus: [], sonnet: [] }, start: 'haiku' }, { ask: 'sonnet' });
  try {
    assert.deepEqual(r.fake.asked, ['sonnet']);
    assert.equal(r.moved.model, FULL.sonnet);
    assert.equal(r.moved.originalModel, FULL.fable);
    assert.deepEqual(r.notes, ['Model: Fable to Sonnet.']);
  } finally {
    await r.s.done();
  }
});

test('T-109: back to the original model: with the setting on, a chat on Opus (was Fable) moved to a Claude with Fable goes back; off, it stays on Opus', async () => {
  const on = await moveWith({ models: { fable: [], opus: [] } }, { model: 'opus', original: 'fable', returnToOriginal: true });
  try {
    assert.deepEqual(on.fake.asked, ['fable']);
    assert.equal(on.moved.model, FULL.fable);
    assert.equal(on.moved.originalModel ?? null, null);
    assert.deepEqual(on.notes, ['Model: back to Fable.']);
  } finally {
    await on.s.done();
  }
  const off = await moveWith({ models: { fable: [], opus: [] } }, { model: 'opus', original: 'fable' });
  try {
    assert.deepEqual(off.fake.asked, ['opus']);
    assert.equal(off.moved.model, FULL.opus);
    assert.equal(off.moved.originalModel, FULL.fable, 'still remembered for later');
    assert.deepEqual(off.notes, [], 'the model that runs did not change');
  } finally {
    await off.s.done();
  }
});

test('T-109: the switch request refuses a model name that is not one', async () => {
  const s = await liveSession();
  try {
    const dest = await s.controller.createClaude('docker/ws1', 'Sekar');
    await assert.rejects(s.controller.switchClaude(s.id, dest.id, { handoff: 'skip', model: 'opus; rm -rf /' }), /Pick a model/);
  } finally {
    await s.done();
  }
});

test('T-109: the switch options say the model each Claude would run the chat on, before the move: Opus where Fable is not known, Fable where its window shows', async () => {
  const s = await liveSession();
  try {
    await new ChatStore(s.store).patchSession(s.id, { model: FULL.fable });
    const sekar = await s.controller.createClaude('docker/ws1', 'Sekar');
    const hasyim = await s.controller.createClaude('docker/ws1', 'Hasyim');
    s.controller.modelWindow = (claudeId, family) => claudeId === hasyim.id && family === 'fable';
    const r = await s.controller.switchOptions(s.id);
    const by = new Map(r.options.map((o) => [o.claude.id, o.model]));
    assert.deepEqual(by.get(sekar.id), { from: 'fable', to: 'opus', known: false });
    assert.deepEqual(by.get(hasyim.id), { from: 'fable', to: 'fable', known: false });
  } finally {
    await s.done();
  }
});
