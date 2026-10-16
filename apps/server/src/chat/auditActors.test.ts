// T-723 S3b: the callers that must name their own actor when they ask the controller for a control. Each test goes red when its call
// drops the actor (the control then lands as `portal`, the default), so none of these is covered only by a test that fakes the whole path.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HANDOFF_ACTOR } from './handoff.js';
import { AUDIT_ACTOR_MAX, ChatStore } from './store.js';
import { line, liveSession, sleep, until, type Live } from './testkit.js';

const resultLine = (sessionId: string) =>
  line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: sessionId });

/** Replaces the controller's control with a recorder that answers at once: what was asked, of whom, and by which actor. */
function recordControls(s: Live) {
  const seen: { id: string; op: string; actor: string | undefined }[] = [];
  s.controller.control = async (id, op, _args, opts) => {
    seen.push({ id, op, actor: opts?.actor });
  };
  return seen;
}

test('T-723 S3b (G2): the auto hand-off sets the QA worker’s mode and model as `portal:handoff`, not as `portal`', async () => {
  const s = await liveSession();
  try {
    s.controller.setAutoHandoff(s.id, true);
    const before = s.ws.tails.length;
    const impl = await s.controller.create({ workspaceId: 'docker/ws1', title: 'Impl', agent: 'implementer', ticketId: 'T-12' }, { actor: `session:${s.id}`, parentId: s.id });
    await until(() => s.ws.tails.length === before + 1);
    await until(() => s.controller.get(impl.id)?.state === 'idle');
    await sleep(20); // let the tail attach its data handler
    const tail = s.ws.tails.at(-1)!;
    const seen = recordControls(s);

    // The worker's turn ends with `DONE <40 hex>` on line 1: the portal starts QA for that commit.
    const csid = s.controller.get(impl.id)!.claudeSessionId;
    await s.controller.send(impl.id, randomUUID(), 'Do T-12.', { actor: `session:${s.id}` });
    const msg = s.controller.history(impl.id).findLast((e) => e.kind === 'user')!;
    tail.push(line({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'started', uuid: randomUUID(), session_id: csid }));
    tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: `DONE ${'a'.repeat(40)}` }] }, parent_tool_use_id: null, uuid: randomUUID() }));
    tail.push(resultLine(csid));

    await until(() => seen.length >= 2, 6000);
    assert.deepEqual(seen.map((c) => c.op), ['mode', 'model']);
    assert.deepEqual(seen.map((c) => c.actor), [HANDOFF_ACTOR, HANDOFF_ACTOR]);
    const qa = s.controller.list({ parentId: s.id }).find((c) => c.agent === 'qa-verifier');
    assert.ok(qa, 'the QA worker was started');
    assert.deepEqual(new Set(seen.map((c) => c.id)), new Set([qa.id]), 'both controls went to the QA worker');
  } finally {
    await s.done();
  }
});

// T-723 S3c: what the audit actor sanitiser keeps and drops. Every special character is built at runtime: a raw one in this file
// would be one of the things under test.
test('T-723 S3c: the audit actor keeps ZWJ emoji and Persian ZWNJ words, drops a bidi override, stores an all-stripped actor as NULL, cuts on code points', async () => {
  const s = await liveSession();
  try {
    const chat = new ChatStore(s.store);
    const cp = (...codes: number[]) => String.fromCodePoint(...codes);
    const stored = (actor: string) => {
      chat.addAudit({ severity: 'info', kind: 'test.actor.s3c', sessionId: s.id, actor });
      return chat.audit({ kind: 'test.actor.s3c' })[0]!.actor;
    };
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467); // man, ZWJ, woman, ZWJ, girl
    assert.equal(stored(`ui ${family}`), `ui ${family}`, 'a ZWJ emoji survives whole');
    const persian = cp(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645); // a Persian word with ZWNJ
    assert.equal(stored(persian), persian, 'a Persian word with ZWNJ survives');
    assert.equal(stored(`ui${cp(0x200f)}x`), `ui${cp(0x200f)}x`, 'the RTL mark stays');
    assert.equal(stored(`ui${cp(0x202e)}nimda`), 'ui nimda', 'a bidi override is removed');
    assert.equal(stored(cp(0x202e, 0x2028, 0x0007, 0xfeff)), null, 'an actor of only stripped characters is NULL');
    assert.equal(stored('   '), null, 'an actor of only spaces is NULL');
    const long = stored(cp(0x1f600).repeat(AUDIT_ACTOR_MAX + 30))!;
    assert.equal(Array.from(long).length, AUDIT_ACTOR_MAX, 'cut at 120 code points');
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(long), 'no half of a surrogate pair is left');
  } finally {
    await s.done();
  }
});

// T-723 S3c: every call that asks the controller for a control, or wakes a session (`#live`), names its actor. The two known
// exceptions are listed by what they are; each must still exist, so a stale entry fails too.
test('T-723 S3c: every non-test control( and #live( call passes an actor (two known exceptions)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name) && !/\.(test|generated)\.ts$/.test(e.name)) files.push(p);
    }
  };
  walk(root);
  const EXCEPTIONS = [
    { file: 'portalmcp/tools/sessions.ts', line: "await chat.control(args.id, 'stop');" }, // a stop wakes nothing and names no actor
    { file: 'chat/controller.ts', line: 'await this.#live(sessionId, true, false);' },
  ];
  const seen = new Set<string>();
  const missing: string[] = [];
  let checked = 0;
  for (const f of files) {
    const rel = relative(root, f).split(sep).join('/');
    readFileSync(f, 'utf8').split('\n').forEach((raw, i) => {
      const code = raw.replace(/\s\/\/.*$/, '').trim();
      const isControl = /(?<![#\w])(?:this|chat|controller|ctl)\.control\(/.test(code) || /\)\.control\(/.test(code);
      const isLive = /this\.#live\(/.test(code);
      if (!isControl && !isLive) return;
      checked++;
      const ex = EXCEPTIONS.find((e) => e.file === rel && code.includes(e.line));
      if (ex) return void seen.add(ex.line);
      const ok = isLive ? /this\.#live\([^()]*,[^()]*,[^()]*,[^()]+\)/.test(code) : /\bactor\b/.test(code);
      if (!ok) missing.push(`${rel}:${i + 1}: ${code.slice(0, 100)}`);
    });
  }
  assert.ok(checked >= 15, `the scan found the calls (${checked})`);
  assert.deepEqual(missing, [], 'these calls pass no actor');
  assert.deepEqual([...seen].sort(), EXCEPTIONS.map((e) => e.line).sort(), 'both known exceptions still exist');
});
