import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canGoBack, canGoForward, closeTab, currentTarget, emptyTabs, nativeHistory, navigate, openTab, reload, setError, setSrc, step, switchTab } from './appTabs';

const t = (port: number, path = '/') => ({ port, path });

test('tabs: open makes the new one active, switch changes it, an unknown id changes nothing', () => {
  let s = openTab(emptyTabs(), t(3000));
  s = openTab(s, t(4000));
  assert.deepEqual(s.tabs.map((x) => x.id), [1, 2]);
  assert.equal(s.active, 2);
  s = switchTab(s, 1);
  assert.equal(s.active, 1);
  assert.equal(switchTab(s, 99), s);
});

test('tabs: closing the active one picks the right neighbour, else the left, else none', () => {
  let s = emptyTabs();
  for (const p of [3000, 4000, 5000]) s = openTab(s, t(p));
  s = switchTab(s, 2);
  s = closeTab(s, 2);
  assert.equal(s.active, 3);
  s = closeTab(s, 3);
  assert.equal(s.active, 1);
  s = closeTab(s, 99);
  assert.deepEqual(s.tabs.map((x) => x.id), [1]);
  s = closeTab(s, 1);
  assert.equal(s.active, null);
  assert.equal(s.tabs.length, 0);
});

test('tabs: closing a background tab keeps the active one', () => {
  let s = emptyTabs();
  for (const p of [3000, 4000, 5000]) s = openTab(s, t(p));
  s = closeTab(s, 1);
  assert.equal(s.active, 3);
});

test('history fallback: back and forward walk what was typed, a new address drops the forward entries', () => {
  let s = openTab(emptyTabs(), t(3000));
  s = navigate(s, 1, t(3000, '/a'));
  s = navigate(s, 1, t(4000));
  const tab = () => s.tabs[0]!;
  assert.equal(tab().entries.length, 3);
  assert.equal(canGoBack(tab()), true);
  assert.equal(canGoForward(tab()), false);
  s = step(s, 1, 'back');
  assert.deepEqual(currentTarget(tab()), t(3000, '/a'));
  assert.equal(canGoForward(tab()), true);
  s = step(s, 1, 'back');
  assert.deepEqual(currentTarget(tab()), t(3000));
  assert.equal(canGoBack(tab()), false);
  const before = s;
  s = step(s, 1, 'back');
  assert.equal(tab().index, before.tabs[0]!.index);
  s = step(s, 1, 'forward');
  assert.deepEqual(currentTarget(tab()), t(3000, '/a'));
  s = navigate(s, 1, t(5000));
  assert.deepEqual(tab().entries, [t(3000), t(3000, '/a'), t(5000)]);
  assert.equal(canGoForward(tab()), false);
});

test('history fallback: the same address twice is one entry', () => {
  let s = openTab(emptyTabs(), t(3000));
  s = navigate(s, 1, t(3000));
  assert.equal(s.tabs[0]!.entries.length, 1);
});

test('native history: used when the frame allows it, false when it throws (cross-origin)', () => {
  const calls: string[] = [];
  const open = { history: { back: () => void calls.push('back'), forward: () => void calls.push('forward') } };
  assert.equal(nativeHistory(open, 'back'), true);
  assert.equal(nativeHistory(open, 'forward'), true);
  assert.deepEqual(calls, ['back', 'forward']);
  const crossOrigin = {
    get history(): never {
      throw new DOMException('Blocked a frame', 'SecurityError');
    },
  };
  assert.equal(nativeHistory(crossOrigin, 'back'), false);
  assert.equal(nativeHistory(null, 'back'), false);
});

test('reload and src: a new URL remounts the frame, an error is kept per tab', () => {
  let s = openTab(emptyTabs(), t(3000));
  s = setSrc(s, 1, 'https://app-x-3000.example.test/__pilot/auth?code=c1');
  assert.equal(s.tabs[0]!.state, 'ready');
  const n = s.tabs[0]!.nonce;
  s = reload(s, 1);
  assert.equal(s.tabs[0]!.state, 'loading');
  s = setSrc(s, 1, 'https://app-x-3000.example.test/__pilot/auth?code=c2');
  assert.equal(s.tabs[0]!.nonce, n + 1);
  s = setError(s, 1, 'No.');
  assert.equal(s.tabs[0]!.state, 'error');
  assert.equal(s.tabs[0]!.error, 'No.');
});
