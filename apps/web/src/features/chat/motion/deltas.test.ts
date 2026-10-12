import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDeltaBatcher, foldDelta, type DeltaMessage } from './deltas';

const text = (t: string, agentLabel: string | null = null): DeltaMessage => ({ type: 'delta', session: 's', agentLabel, text: t });
const thinking = (): DeltaMessage => ({ type: 'delta', session: 's', agentLabel: null, text: '', thinking: true });

/** A frame source the test steps by hand. */
function frames() {
  let cb: (() => void) | null = null;
  return {
    request: (f: () => void) => ((cb = f), 1),
    cancel: () => void (cb = null),
    pending: () => cb !== null,
    step: () => {
      const f = cb;
      cb = null;
      f?.();
    },
  };
}

describe('foldDelta', () => {
  it('appends text from the same agent, and starts afresh for another', () => {
    let d = foldDelta(null, text('Hel'));
    d = foldDelta(d, text('lo'));
    assert.equal(d.text, 'Hello');
    assert.equal(foldDelta(d, text('x', 'agent')).text, 'x');
  });

  it('a thinking start replaces the reply, and text after thinking starts afresh', () => {
    const t = foldDelta({ agentLabel: null, text: 'abc' }, thinking());
    assert.equal(t.text, '');
    assert.ok(t.thinking);
    assert.equal(foldDelta(t, text('new')).text, 'new');
    assert.equal(foldDelta(t, text('new')).thinking, undefined);
  });
});

describe('createDeltaBatcher', () => {
  it('applies a burst of deltas once, on the next frame, in order', () => {
    const f = frames();
    const applied: DeltaMessage[][] = [];
    const b = createDeltaBatcher((m) => applied.push(m), f.request, f.cancel);
    b.push(text('a'));
    b.push(text('b'));
    b.push(text('c'));
    assert.equal(applied.length, 0);
    f.step();
    assert.equal(applied.length, 1);
    assert.equal(applied[0]!.map((m) => m.text).join(''), 'abc');
    assert.equal(f.pending(), false);
  });

  it('joins runs of text but keeps a thinking start between them, so the result is the same as applying one by one', () => {
    const f = frames();
    const applied: DeltaMessage[][] = [];
    const b = createDeltaBatcher((m) => applied.push(m), f.request, f.cancel);
    const sent = [text('one '), text('two'), thinking(), text('three'), text(' four')];
    sent.forEach((m) => b.push(m));
    f.step();
    const batched = applied[0]!.reduce<ReturnType<typeof foldDelta> | null>((d, m) => foldDelta(d, m), null);
    const oneByOne = sent.reduce<ReturnType<typeof foldDelta> | null>((d, m) => foldDelta(d, m), null);
    assert.equal(batched!.text, oneByOne!.text);
    assert.equal(batched!.text, 'three four');
    assert.equal(applied[0]!.length, 3);
  });

  it('flush applies what is waiting at once (before the stored reply that supersedes it)', () => {
    const f = frames();
    const applied: DeltaMessage[][] = [];
    const b = createDeltaBatcher((m) => applied.push(m), f.request, f.cancel);
    b.push(text('a'));
    b.flush();
    assert.equal(applied.length, 1);
    assert.equal(f.pending(), false);
    b.flush();
    assert.equal(applied.length, 1);
  });

  it('cancel drops what is waiting', () => {
    const f = frames();
    const applied: DeltaMessage[][] = [];
    const b = createDeltaBatcher((m) => applied.push(m), f.request, f.cancel);
    b.push(text('a'));
    b.cancel();
    f.step();
    assert.equal(applied.length, 0);
  });
});
