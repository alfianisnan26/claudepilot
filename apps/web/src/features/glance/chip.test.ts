import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chipShape } from './ui.js';

test('a widget with no number and no status (Shortcuts) is the icon alone: no number, no dot, no placeholder', () => {
  assert.deepEqual(chipShape({ value: null, level: 'idle' }), { number: null, dot: false });
  assert.deepEqual(chipShape({ value: '', level: 'idle' }), { number: null, dot: false }, 'an empty string is no number either');
});

test('a number or a status brings the dot: idle with a number (0 running), no number but a level, unknown while loading', () => {
  assert.deepEqual(chipShape({ value: '0', level: 'idle' }), { number: 'value', dot: true });
  assert.deepEqual(chipShape({ value: null, level: 'ok' }), { number: null, dot: true });
  assert.deepEqual(chipShape({ value: '3', level: 'critical' }), { number: 'value', dot: true });
  assert.deepEqual(chipShape({ value: null, level: 'unknown', loading: true }), { number: 'loading', dot: true });
  assert.deepEqual(chipShape({ value: '-', level: 'unknown' }), { number: 'value', dot: true }, '"-" is a value: unavailable data shows as a dash with a hollow dot');
});
