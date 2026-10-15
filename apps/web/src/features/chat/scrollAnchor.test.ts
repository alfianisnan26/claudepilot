// T-376: an older page goes in above and the reading position does not move (QA-STANDARDS A9).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatEvent } from '@portal/contracts';
import { anchorSeq, buildItems } from './agentFold';
import { nearTop, pickAnchor, restoreScroll, type MeasuredRow } from './scrollAnchor';
import { buildRows } from './ToolRows';

/** Rows of the given heights stacked with a gap, as the transcript lays them out. */
function layout(keys: string[], heights: number[], gap = 20, padTop = 80): MeasuredRow[] {
  let y = padTop;
  return keys.map((key, i) => {
    const row = { key, top: y, bottom: y + heights[i]! };
    y = row.bottom + gap;
    return row;
  });
}

describe('scroll anchor', () => {
  it('the first row in view is the anchor, with how far it is below the top of the view', () => {
    const rows = layout(['a', 'b', 'c'], [100, 300, 100]); // a 80–180, b 200–500, c 520–620
    assert.deepEqual(pickAnchor(rows, 250, 700), { key: 'b', offset: -50, scrollTop: 250, scrollHeight: 700 });
    assert.equal(pickAnchor(rows, 0, 700).key, 'a');
    // Between two rows (in the gap), the next one.
    assert.equal(pickAnchor(rows, 505, 700).key, 'c');
  });

  it('after older rows go in above, the anchor row is exactly where it was', () => {
    const before = layout(['b', 'c'], [300, 100]);
    const anchor = pickAnchor(before, 250, 600);
    // A page of 1,240 px goes in above; the row keeps its height.
    const after = layout(['x', 'y', 'b', 'c'], [600, 600, 300, 100]);
    const b = after.find((r) => r.key === 'b')!;
    const top = restoreScroll(anchor, { rowTop: b.top, scrollHeight: 1840 });
    assert.equal(b.top - top, before[0]!.top - 250); // the same distance from the view's top
    assert.equal(top, 250 + (b.top - before[0]!.top));
  });

  it('it holds even when the content also grew below (a live event while the page loaded)', () => {
    const anchor = pickAnchor(layout(['b', 'c'], [300, 100]), 120, 600);
    // Growth below changes scrollHeight but not the row: the row decides.
    assert.equal(restoreScroll(anchor, { rowTop: 80 + 500, scrollHeight: 5000 }), 120 + 500);
  });

  it('when the anchor row is gone, the growth of the content keeps the view', () => {
    const anchor = pickAnchor(layout(['b'], [300]), 100, 500);
    assert.equal(restoreScroll(anchor, { rowTop: null, scrollHeight: 1700 }), 1300);
    assert.equal(restoreScroll({ key: null, offset: 0, scrollTop: 0, scrollHeight: 0 }, { rowTop: 400, scrollHeight: 900 }), 900);
  });

  it('never above the top', () => {
    assert.equal(restoreScroll({ key: 'b', offset: 300, scrollTop: 0, scrollHeight: 100 }, { rowTop: 80, scrollHeight: 100 }), 0);
  });

  it('near the top: within a screen (at least 400 px)', () => {
    assert.equal(nearTop(0, 800), true);
    assert.equal(nearTop(799, 800), true);
    assert.equal(nearTop(801, 800), false);
    assert.equal(nearTop(399, 200), true);
    assert.equal(nearTop(401, 200), false);
  });
});

describe('anchorSeq: an item keeps its anchor when older rows join it', () => {
  const at = new Date().toISOString();
  const e = (seq: number, over: Partial<ChatEvent>): ChatEvent => ({ seq, at, kind: 'assistant', ...over });
  const all: ChatEvent[] = [
    e(1, { kind: 'user', text: 'go' }),
    e(2, { kind: 'tool_use', toolName: 'Read', toolUseId: 'r1', text: '/a' }),
    e(3, { kind: 'tool_result', toolUseId: 'r1', text: 'a' }),
    e(4, { kind: 'tool_use', toolName: 'Read', toolUseId: 'r2', text: '/b' }),
    e(5, { kind: 'tool_result', toolUseId: 'r2', text: 'b' }),
    e(6, { kind: 'tool_use', toolName: 'Bash', toolUseId: 'b1', text: 'npm test' }),
    e(7, { kind: 'tool_result', toolUseId: 'b1', text: 'ok' }),
    e(8, { kind: 'assistant', text: 'Done.' }),
    e(9, { kind: 'result' }),
  ];
  const items = (events: ChatEvent[]) => buildItems({ rows: buildRows(events, true), finals: new Set([8]), moves: new Map(), base: 99, details: false }).items;

  it('the turn read from its middle and then whole: its key changes, its anchor does not', () => {
    const part = items(all.slice(5)); // the page started at seq 6
    const whole = items(all);
    const turnPart = part.find((i) => i.kind === 'activity')!;
    const turnWhole = whole.find((i) => i.kind === 'activity')!;
    assert.notEqual(turnPart.key, turnWhole.key);
    assert.equal(anchorSeq(turnPart), anchorSeq(turnWhole));
    assert.equal(anchorSeq(turnWhole), 6);
  });

  it('a run of read-only calls by its latest call; a row by its own seq', () => {
    const head = buildItems({ rows: buildRows(all.slice(0, 5), true), finals: new Set(), moves: new Map(), base: 99, details: false }).items;
    assert.deepEqual(head.map(anchorSeq), [1, 4]);
  });
});
