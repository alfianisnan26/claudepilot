import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inTerminal, isMacPlatform, isPaletteShortcut, shortcutLabel, type KeyLike } from './keys.js';

const key = (over: Partial<KeyLike>): KeyLike => ({ key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

test('Ctrl+K opens the palette everywhere but on a Mac, where it is Cmd+K', () => {
  assert.equal(isPaletteShortcut(key({ ctrlKey: true }), false), true);
  assert.equal(isPaletteShortcut(key({ ctrlKey: true, key: 'K' }), false), true, 'caps lock');
  assert.equal(isPaletteShortcut(key({ metaKey: true }), true), true);
  // on a Mac Ctrl+K is the text field's kill-line; elsewhere the Windows key is not the shortcut
  assert.equal(isPaletteShortcut(key({ ctrlKey: true }), true), false);
  assert.equal(isPaletteShortcut(key({ metaKey: true }), false), false);
  assert.equal(isPaletteShortcut(key({ ctrlKey: true, metaKey: true }), true), false);
});

test('any other key or modifier leaves it alone, and so does a key something already handled or an input method', () => {
  assert.equal(isPaletteShortcut(key({}), false), false, 'plain k');
  assert.equal(isPaletteShortcut(key({ ctrlKey: true, key: 'j' }), false), false);
  assert.equal(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }), false), false, 'the browser console');
  assert.equal(isPaletteShortcut(key({ ctrlKey: true, altKey: true }), false), false);
  assert.equal(isPaletteShortcut(key({ ctrlKey: true, defaultPrevented: true }), false), false);
  assert.equal(isPaletteShortcut(key({ ctrlKey: true, isComposing: true }), false), false);
});

test('the terminal keeps Ctrl+K', () => {
  const inside = { closest: (s: string) => (s === '.xterm' ? {} : null) };
  const outside = { closest: () => null };
  assert.equal(inTerminal(inside), true);
  assert.equal(inTerminal(outside), false);
  assert.equal(inTerminal(null), false);
  assert.equal(inTerminal({}), false, 'a target that is not an element');
});

test('Apple platforms are recognised by what the browser reports, and the shortcut is named for the platform', () => {
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true);
  assert.equal(isMacPlatform({ platform: 'iPhone' }), true);
  assert.equal(isMacPlatform({ userAgentData: { platform: 'macOS' }, platform: 'Linux' }), true);
  assert.equal(isMacPlatform({ platform: 'Win32' }), false);
  assert.equal(isMacPlatform({ platform: 'Linux x86_64' }), false);
  assert.equal(isMacPlatform(undefined), false);
  assert.equal(shortcutLabel(true), '⌘K');
  assert.equal(shortcutLabel(false), 'Ctrl K');
});
