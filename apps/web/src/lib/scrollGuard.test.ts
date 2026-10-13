import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScrollGuard, GRACE_MS, lockIsStale, type GuardEnv } from './scrollGuard';

/** A body and a clock by hand: the guard decides from the style, the modals on screen and time. */
function world() {
  const w = {
    overflow: '',
    modals: 0,
    cleared: 0,
    now: 0,
    timers: new Map<number, { at: number; fn: () => void }>(),
    next: 1,
  };
  const env: GuardEnv = {
    overflow: () => w.overflow,
    clear: () => {
      w.overflow = '';
      w.cleared++;
    },
    modals: () => w.modals,
    setTimer: (fn, ms) => {
      const id = w.next++;
      w.timers.set(id, { at: w.now + ms, fn });
      return id;
    },
    clearTimer: (h) => void w.timers.delete(h as number),
  };
  const advance = (ms: number) => {
    const to = w.now + ms;
    for (;;) {
      const due = [...w.timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      w.now = due[1].at;
      w.timers.delete(due[0]);
      due[1].fn();
    }
    w.now = to;
  };
  return { w, env, advance };
}

/** What the kit's Dialog and the palette both do: save body's overflow, hide it, and put the saved value back on close. */
function lockLikeTheKit(w: { overflow: string }) {
  const saved = w.overflow;
  w.overflow = 'hidden';
  return () => {
    w.overflow = saved;
  };
}

test('a lock is stale only when body is hidden and no modal is on screen', () => {
  assert.equal(lockIsStale('hidden', 0), true);
  assert.equal(lockIsStale(' hidden ', 0), true);
  assert.equal(lockIsStale('hidden', 1), false);
  assert.equal(lockIsStale('', 0), false);
  assert.equal(lockIsStale('auto', 0), false);
});

test('the bug: two overlapping locks leave body hidden for good (what the kit and the palette do)', () => {
  const { w } = world();
  const first = lockLikeTheKit(w); // a dialog opens
  const second = lockLikeTheKit(w); // the next one opens before the first has left: it saves "hidden"
  first(); // the first one finishes leaving and puts "" back
  second(); // the second closes and puts back what it saved
  assert.equal(w.overflow, 'hidden', 'stuck: nothing holds the lock, nothing will release it');
});

test('the guard clears that stuck lock after the grace period, once', () => {
  const { w, env, advance } = world();
  const guard = createScrollGuard(env);
  const first = lockLikeTheKit(w);
  const second = lockLikeTheKit(w);
  first();
  second();
  guard.poke();
  advance(GRACE_MS - 1);
  assert.equal(w.overflow, 'hidden', 'not before the grace period: a leaving dialog is never cut short');
  advance(2);
  assert.equal(w.overflow, '');
  assert.equal(w.cleared, 1);
  advance(5 * GRACE_MS);
  assert.equal(w.cleared, 1, 'and it does not keep touching a page that is fine');
});

test('a lock held by an open modal is left alone, and released as soon as the modal is gone', () => {
  const { w, env, advance } = world();
  const guard = createScrollGuard(env);
  w.modals = 1;
  w.overflow = 'hidden';
  guard.poke();
  advance(10 * GRACE_MS);
  assert.equal(w.overflow, 'hidden');
  assert.equal(w.cleared, 0);
  w.modals = 0; // the dialog went away without putting anything back
  advance(GRACE_MS + 1);
  assert.equal(w.overflow, '');
  assert.equal(w.cleared, 1);
});

test('a page that is not locked costs nothing: no timers keep running', () => {
  const { w, env, advance } = world();
  const guard = createScrollGuard(env);
  guard.poke();
  advance(GRACE_MS + 1);
  assert.equal(w.timers.size, 0);
  assert.equal(w.cleared, 0);
});

test('many pokes make one pending check, and stop cancels it', () => {
  const { w, env, advance } = world();
  const guard = createScrollGuard(env);
  w.overflow = 'hidden';
  for (let i = 0; i < 20; i++) guard.poke();
  assert.equal(w.timers.size, 1);
  guard.stop();
  assert.equal(w.timers.size, 0);
  advance(5 * GRACE_MS);
  assert.equal(w.overflow, 'hidden', 'stopped: it does not act');
});
