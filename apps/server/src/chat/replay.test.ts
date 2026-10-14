// T-265: the stream follower never reads a processed line again. One `tail` per reader (a second one counted every byte twice and pushed
// the cursor past the segment's end, after which GNU tail replayed the file from byte 0), and a cursor past the end heals instead of replaying.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatStore } from './store.js';
import { line, liveSession, sleep, until } from './testkit.js';

const said = (text: string, uuid: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid });

test('T-265: a tab attaching while a dropped tail is being checked opens no second follower, and the cursor counts every line once', async () => {
  const s = await liveSession();
  try {
    const store = new ChatStore(s.store);
    s.tail.exit(0); // the follower dropped; its status check is in flight…
    s.controller.attach(s.id); // …and a tab subscribes meanwhile
    await until(() => s.ws.tails.length === 2);
    await sleep(1_300); // longer than the re-follow delay: a second follower would have opened by now
    assert.equal(s.ws.tails.length, 2, 'one follower replaced the dropped one');
    const l1 = said('once', 'u-once');
    s.ws.tails[1]!.push(l1);
    await until(() => s.controller.history(s.id).some((e) => e.text === 'once'));
    await sleep(20);
    assert.equal(store.row(s.id)!.byte_offset, Buffer.byteLength(l1), 'the cursor moved by the line once');
    // The next follower starts exactly after the last processed line.
    s.ws.tails[1]!.exit(0);
    await until(() => s.ws.tails.length === 3);
    assert.deepEqual(s.ws.tailArgs[2], ['tail', s.id, '1', String(Buffer.byteLength(l1))]);
    assert.equal(s.controller.history(s.id).filter((e) => e.text === 'once').length, 1);
  } finally {
    await s.done();
  }
});

test('T-265: a cursor past the segment’s end (the host answers 6 with the size) heals to the size and follows from there', async () => {
  const s = await liveSession();
  try {
    const store = new ChatStore(s.store);
    const l1 = said('before', 'u-before');
    s.tail.push(l1);
    await until(() => s.controller.history(s.id).some((e) => e.text === 'before'));
    store.patchSession(s.id, { byteOffset: 999_999 }); // what two followers counting the same bytes left behind
    s.tail.exit(0);
    await until(() => s.ws.tails.length === 2);
    assert.equal(s.ws.tailArgs[1]!.at(-1), '999999');
    s.ws.tails[1]!.push(String(Buffer.byteLength(l1))); // the host: the segment is only this long
    s.ws.tails[1]!.exit(6);
    await until(() => s.ws.tails.length === 3);
    assert.deepEqual(s.ws.tailArgs[2], ['tail', s.id, '1', String(Buffer.byteLength(l1))]);
    assert.equal(store.row(s.id)!.byte_offset, Buffer.byteLength(l1));
    assert.notEqual(s.state(), 'ended');
    assert.equal(s.controller.history(s.id).filter((e) => e.text === 'before').length, 1, 'nothing read again');
  } finally {
    await s.done();
  }
});

test('T-265: an integrity ending is logged with its reason, the session, the line’s kind and byte position, never its content', async () => {
  const s = await liveSession();
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(' '));
  try {
    const first = said('first', 'u-first');
    s.tail.push(first);
    await until(() => s.controller.history(s.id).some((e) => e.text === 'first'));
    const bad = line({ type: 'control_response', response: { subtype: 'success', request_id: 'R-nobody', response: { mode: 'bypassPermissions' } } });
    s.tail.push(bad);
    await until(() => s.state() === 'ended');
    const entry = warned.find((w) => w.includes('ended for integrity'));
    assert.ok(entry, 'one log line');
    assert.ok(entry.includes(s.id.slice(0, 8)) && entry.includes('a control response for request R-nobody'), entry);
    assert.ok(entry.includes(`line control_response at byte ${Buffer.byteLength(first)} of segment 1`), entry);
    assert.ok(!entry.includes('bypassPermissions'), 'no content');
  } finally {
    console.warn = warn;
    await s.done();
  }
});
