import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { frameTask, setFrameSource } from './frames';

/** A frame source the test steps by hand. */
function fakeFrames() {
  let queue: ((now: number) => void)[] = [];
  let next = 1;
  setFrameSource({
    request: (cb) => {
      queue.push(cb);
      return next++;
    },
    cancel: () => {
      queue = [];
    },
  });
  return {
    pending: () => queue.length,
    step: (now: number) => {
      const run = queue;
      queue = [];
      for (const cb of run) cb(now);
    },
  };
}

describe('frame loop', () => {
  afterEach(() => setFrameSource(null));

  it('runs tasks in order within a frame, and sleeps when none wants another', () => {
    const f = fakeFrames();
    const log: string[] = [];
    const second = frameTask(20, () => (log.push('follow'), false));
    const first = frameTask(10, () => (log.push('reveal'), false));
    second.wake();
    first.wake();
    assert.equal(f.pending(), 1, 'one frame request for both');
    f.step(16);
    assert.deepEqual(log, ['reveal', 'follow']);
    assert.equal(f.pending(), 0, 'asleep');
    first.dispose();
    second.dispose();
  });

  it('keeps going while a task returns true, with the time since the last frame', () => {
    const f = fakeFrames();
    const dts: number[] = [];
    let n = 0;
    const task = frameTask(10, (_now, dt) => {
      dts.push(Math.round(dt));
      return ++n < 3;
    });
    task.wake();
    f.step(100);
    f.step(116);
    f.step(150);
    assert.equal(f.pending(), 0);
    assert.deepEqual(dts.slice(1), [16, 34]);
    task.dispose();
  });

  it('does not run a disposed task, and tolerates a task disposing itself mid-frame', () => {
    const f = fakeFrames();
    let ran = 0;
    const a = frameTask(10, () => {
      ran++;
      a.dispose();
      return true;
    });
    const b = frameTask(20, () => (ran++, false));
    a.wake();
    b.wake();
    f.step(16);
    assert.equal(ran, 2);
    f.step(32);
    assert.equal(ran, 2);
    b.dispose();
  });
});
