// QA-006 at the controller: a secret the workspace was given (Secrets & env) never lands in the transcript, the stored
// requests and tasks, the events API or a socket frame, whatever form a tool printed it in; Claude Code still gets the
// original text, and a provider that fails leaves the credential shapes to do the work.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { line, liveSession, until } from './testkit.js';

const SECRET = 'Tr0ub4dor&3-internal/pass phrase';
const OTHER = 'rotated-in-value-9f3a71c2';
const delta = (text: string) => line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, parent_tool_use_id: null });
const blockStop = line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, parent_tool_use_id: null });
const assistantText = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid: randomUUID() });

test('every stored and shown text is redacted by value: raw, base64, URL-encoded and JSON-escaped; Claude Code gets the original', async () => {
  const s = await liveSession();
  try {
    s.controller.valuesCacheMs = 0;
    s.controller.secretValues = (ws) => (ws === 'docker/ws1' ? [SECRET] : []);
    const b64 = Buffer.from(`user:${SECRET}`).toString('base64');
    const url = encodeURIComponent(SECRET);
    const json = JSON.stringify({ password: SECRET });

    await s.controller.send(s.id, randomUUID(), `the password is ${SECRET}`);
    assert.ok(s.ws.sends.some((x) => x.line.includes(SECRET)), 'Claude Code was sent what was typed');
    s.tail.push(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_env', content: `PASSWORD=${SECRET}\nAUTH=Basic ${b64}\nURL=https://x/?p=${url}\nJSON=${json}` }] }, parent_tool_use_id: null }));
    s.tail.push(line({ type: 'control_request', request_id: 'R-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: `curl -u admin:${SECRET} https://api.example.com` }, tool_use_id: 'toolu_curl' } }));
    s.tail.push(line({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_t', status: 'completed', summary: `found ${SECRET} in the env` }));
    s.tail.push(line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `failed with ${SECRET}`, session_id: s.id }));
    await until(() => s.controller.history(s.id).some((e) => e.kind === 'error'));

    const rows = JSON.stringify(['chat_events', 'chat_requests', 'chat_tasks', 'chat_sessions'].map((t) => s.store.db!.prepare(`SELECT * FROM ${t}`).all()));
    const frames = JSON.stringify(s.messages);
    const api = JSON.stringify(s.controller.history(s.id));
    for (const where of [rows, frames, api]) {
      for (const form of [SECRET, JSON.stringify(SECRET).slice(1, -1), url, 'Tr0ub4dor']) assert.ok(!where.includes(form), `no ${form.slice(0, 12)}… anywhere`);
      assert.ok(!where.includes(b64.slice(8, 24)), 'no base64 of it');
    }
    const events = s.controller.history(s.id);
    assert.equal(events.find((e) => e.kind === 'user')!.text, 'the password is [redacted]');
    const result = events.find((e) => e.kind === 'tool_result')!.text!;
    assert.match(result, /^PASSWORD=\[redacted\]\nAUTH=Basic /);
    assert.ok(result.includes('URL=https://x/?p=[redacted]') && result.includes('JSON={"password":"[redacted]"}'));
    assert.equal(events.find((e) => e.kind === 'request')!.request!.detail, 'curl -u admin:[redacted] https://api.example.com');
    assert.equal(s.controller.get(s.id)!.waitingFor?.includes(SECRET), false);
    assert.equal(s.controller.tasks(s.id)[0]!.summary, 'found [redacted] in the env');
  } finally {
    await s.done();
  }
});

test('a value split across live deltas never reaches a tab, and what was held back goes out before the stored block', async () => {
  const s = await liveSession();
  try {
    s.controller.valuesCacheMs = 0;
    s.controller.secretValues = () => [SECRET];
    const said = `The password is ${SECRET}. Use it once.`;
    s.tail.push(delta('The password is Tr0ub4dor&3-int'));
    s.tail.push(delta('ernal/pass phrase. Use it on'));
    s.tail.push(delta('ce. Tr0ub'));
    s.tail.push(assistantText(`${said} Tr0ub`));
    s.tail.push(blockStop);
    await until(() => s.controller.history(s.id).some((e) => e.kind === 'assistant'));
    const frames = s.messages.flatMap((m) => (m.type === 'delta' ? [m.text] : []));
    assert.equal(frames.join(''), 'The password is [redacted]. Use it once. Tr0ub');
    for (const f of frames) assert.ok(!f.includes('Tr0ub4dor') && !f.includes('internal'), `frame ${JSON.stringify(f)}`);
    assert.equal(s.controller.history(s.id).find((e) => e.kind === 'assistant')!.text, 'The password is [redacted]. Use it once. Tr0ub');
  } finally {
    await s.done();
  }
});

test('a value rotated in is covered within the cache time, and the provider is asked per workspace', async () => {
  const s = await liveSession();
  try {
    const asked: string[] = [];
    let values: string[] = [SECRET];
    s.controller.valuesCacheMs = 0;
    s.controller.secretValues = (ws) => (asked.push(ws), values);
    s.tail.push(assistantText(`one ${OTHER}`));
    await until(() => s.controller.history(s.id).some((e) => e.kind === 'assistant'));
    assert.equal(s.controller.history(s.id).find((e) => e.kind === 'assistant')!.text, `one ${OTHER}`, 'not a secret yet');
    values = [SECRET, OTHER];
    s.tail.push(assistantText(`two ${OTHER}`));
    await until(() => s.controller.history(s.id).filter((e) => e.kind === 'assistant').length === 2);
    assert.equal(s.controller.history(s.id).filter((e) => e.kind === 'assistant')[1]!.text, 'two [redacted]');
    assert.ok(asked.length > 0 && asked.every((w) => w === 'docker/ws1'));
    assert.equal(s.controller.scrub('docker/ws1', `x ${OTHER} sk-ant-api03-${'Ab1_'.repeat(10)}`), 'x [redacted] [redacted]', 'values and shapes');
  } finally {
    await s.done();
  }
});

test('values are read once per cache time, not once per event', async () => {
  const s = await liveSession();
  try {
    let reads = 0;
    s.controller.valuesCacheMs = 60_000;
    s.controller.secretValues = () => (reads++, [SECRET]);
    for (let i = 0; i < 5; i++) s.tail.push(assistantText(`line ${i}`));
    await until(() => s.controller.history(s.id).filter((e) => e.kind === 'assistant').length === 5);
    assert.equal(reads, 1);
  } finally {
    await s.done();
  }
});

test('a provider that throws (Locked, no Secrets module) never stops a chat: shapes still apply, values are just not known', async () => {
  const s = await liveSession();
  try {
    s.controller.valuesCacheMs = 0;
    s.controller.secretValues = () => {
      throw new Error('locked');
    };
    s.tail.push(assistantText(`token ghp_${'a1B2'.repeat(6)} and ${SECRET}`));
    await until(() => s.controller.history(s.id).some((e) => e.kind === 'assistant'));
    assert.equal(s.controller.history(s.id).find((e) => e.kind === 'assistant')!.text, `token [redacted] and ${SECRET}`);
    assert.equal(s.controller.scrub('docker/ws1', `a ${SECRET}`), `a ${SECRET}`);
  } finally {
    await s.done();
  }
});
