import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chase, jumpDuration, jumpTo } from './glide';

/** Runs the chase at 60 Hz toward a target that grows by `growth` px per second. */
function follow(growth: number, seconds: number, viewport = 800): { pos: number[]; target: number[] } {
  const pos = [0];
  const target = [0];
  for (let f = 1; f <= seconds * 60; f++) {
    const t = (growth * f) / 60;
    target.push(t);
    pos.push(chase(pos[f - 1]!, t, 1000 / 60, viewport));
  }
  return { pos, target };
}

describe('chase: the follower approaching the end of a growing reply', () => {
  it('never goes backwards or past the end, and settles on a target that stops growing', () => {
    let pos = 0;
    let last = -1;
    for (let f = 0; f < 120; f++) {
      pos = chase(pos, 500, 1000 / 60, 800);
      assert.ok(pos >= last && pos <= 500);
      last = pos;
    }
    assert.ok(500 - pos < 0.5);
  });

  it('trails a steadily growing reply by a little, never by a screen', () => {
    // 60 px a second (a line every 0.4 s) and a burst-like 600 px a second.
    const slow = follow(60, 10);
    const lagSlow = Math.max(...slow.pos.slice(60).map((p, i) => slow.target[i + 60]! - p));
    assert.ok(lagSlow < 20, `lag ${lagSlow.toFixed(1)} px`);
    const fast = follow(600, 10);
    const lagFast = Math.max(...fast.pos.slice(60).map((p, i) => fast.target[i + 60]! - p));
    assert.ok(lagFast < 400, `lag ${lagFast.toFixed(1)} px`);
  });

  it('moves in small, even steps while following (no jumps)', () => {
    const { pos } = follow(100, 6);
    const steps = pos.slice(1).map((p, i) => p - pos[i]!);
    const settled = steps.slice(60);
    assert.ok(Math.max(...settled) < 4, `largest step ${Math.max(...settled)}`);
    assert.ok(Math.max(...settled) - Math.min(...settled) < 0.5, 'steps are about equal once it has caught up');
  });

  it('closes a larger gap faster', () => {
    const near = chase(0, 100, 16, 800) / 100;
    const far = chase(0, 1000, 16, 800) / 1000;
    assert.ok(far > near);
  });
});

describe('jump to latest', () => {
  it('eases out from where it began to where the end is, landing on it', () => {
    assert.equal(jumpTo(0, 1000, 0, 500), 0);
    assert.equal(jumpTo(0, 1000, 500, 500), 1000);
    assert.equal(jumpTo(0, 1000, 900, 500), 1000);
    let prev = 0;
    for (let ms = 0; ms <= 500; ms += 16) {
      const p = jumpTo(0, 1000, ms, 500);
      assert.ok(p >= prev);
      prev = p;
    }
    // Fast at first, soft at the end.
    assert.ok(jumpTo(0, 1000, 100, 500) > 400);
    assert.ok(jumpTo(0, 1000, 490, 500) - jumpTo(0, 1000, 474, 500) < 10);
  });

  it('follows an end that moves while it goes', () => {
    assert.equal(jumpTo(0, 1500, 500, 500), 1500);
  });

  it('takes longer for a longer way, within bounds', () => {
    assert.ok(jumpDuration(100) < jumpDuration(1000));
    assert.equal(jumpDuration(1e6), jumpDuration(5e6));
    assert.ok(jumpDuration(0) > 0);
  });
});
