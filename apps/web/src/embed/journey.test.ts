// The report journey's rules (owner, 2026-11-01): remembered choices, asking before throwing work away, Esc order, upload progress,
// straight to annotate after a capture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReporterAnnotation } from '@portal/contracts';
import { DEFAULT_PREFS, FRESH_MAX, autoAnnotate, editorEscape, freshKeys, hasUnsavedWork, marksChanged, parsePrefs, prefsKey, progressText, uploadCount, withPref } from './journey';

test('list: only rows that arrive after the first load animate in, and never a whole new list', () => {
  assert.deepEqual([...freshKeys(null, ['A-1', 'A-2'])], [], 'first load: nothing animates');
  const known = new Set(['A-1', 'A-2']);
  assert.deepEqual([...freshKeys(known, ['A-3', 'A-1', 'A-2'])], ['A-3'], 'a ticket just filed');
  assert.deepEqual([...freshKeys(known, ['A-2'])], [], 'a row gone animates nothing');
  const many = Array.from({ length: FRESH_MAX + 1 }, (_, i) => `B-${i}`);
  assert.deepEqual([...freshKeys(known, many)], [], 'a filter change just appears');
});

test('prefs: remembered per bucket, each field checked on its own, Whole page never on a touch screen', () => {
  assert.equal(prefsKey('KONF'), 'pilot-reporter:journey:KONF');
  assert.deepEqual(parsePrefs(null, false), DEFAULT_PREFS);
  assert.equal(DEFAULT_PREFS.tool, 'rect', 'a new capture opens on Rectangle');
  assert.deepEqual(parsePrefs('{bad json', false), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('"crop"', false), DEFAULT_PREFS, 'not an object');
  const saved = JSON.stringify(withPref(withPref(withPref(DEFAULT_PREFS, 'mode', 'crop'), 'priority', 'high'), 'tool', 'arrow'));
  assert.deepEqual(parsePrefs(saved, false), { mode: 'crop', priority: 'high', tool: 'arrow' });
  // One broken field keeps the others.
  assert.deepEqual(parsePrefs(JSON.stringify({ mode: 'everything', priority: 'high', tool: 'laser' }), false), { mode: 'viewport', priority: 'high', tool: 'rect' });
  assert.equal(parsePrefs(JSON.stringify({ mode: 'full' }), false).mode, 'full');
  assert.equal(parsePrefs(JSON.stringify({ mode: 'full' }), true).mode, 'viewport', 'a phone has no Whole page');
  assert.equal(parsePrefs(JSON.stringify({ priority: '__proto__' }), false).priority, 'normal');
});

test('discard: asks only when something would be lost', () => {
  const base = { title: 'Hero button on Home', suggested: 'Hero button on Home', details: '', shots: [{}] };
  assert.equal(hasUnsavedWork(base), false, 'a lone fresh shot goes without a question');
  assert.equal(hasUnsavedWork({ ...base, title: ' Hero button on Home ' }), false, 'spaces are not work');
  assert.equal(hasUnsavedWork({ ...base, title: 'Hero button cut off' }), true);
  assert.equal(hasUnsavedWork({ ...base, title: '' }), true, 'clearing the suggestion is a choice too');
  assert.equal(hasUnsavedWork({ ...base, details: 'on iOS only' }), true);
  assert.equal(hasUnsavedWork({ ...base, shots: [{}, {}] }), true);
  assert.equal(hasUnsavedWork({ ...base, shots: [{ annotations: [{}] }] }), true);
  assert.equal(hasUnsavedWork({ ...base, shots: [{ annotations: [] }] }), false);
});

test('editor: marks changed ignores ids; undoing back to the start is no change', () => {
  const a = { type: 'rect', color: '#ef233c', width: 4, rect: { x: 1, y: 2, w: 3, h: 4 } } as ReporterAnnotation;
  assert.equal(marksChanged(undefined, []), false);
  assert.equal(marksChanged([a], [{ ...a, id: 'm1' } as unknown as ReporterAnnotation]), false);
  assert.equal(marksChanged([], [a]), true);
  assert.equal(marksChanged([a], []), true);
  assert.equal(marksChanged([a], [{ ...a, rect: { x: 9, y: 2, w: 3, h: 4 } } as ReporterAnnotation]), true);
});

test('editor: Esc does the topmost thing only, and closes last', () => {
  const none = { drawing: false, help: false, asking: false, selected: false, changed: false };
  assert.equal(editorEscape({ ...none, drawing: true, help: true, asking: true, selected: true, changed: true }), 'drop-mark');
  assert.equal(editorEscape({ ...none, help: true, asking: true, selected: true }), 'close-help');
  assert.equal(editorEscape({ ...none, asking: true, selected: true }), 'keep');
  assert.equal(editorEscape({ ...none, selected: true, changed: true }), 'deselect');
  assert.equal(editorEscape({ ...none, changed: true }), 'ask-discard');
  assert.equal(editorEscape(none), 'close');
});

test('progress: filing, then one step per uploaded file', () => {
  const png = new Blob(['x']);
  const plain = { screenshot: png, previewUrl: 'blob:a' };
  const marked = { ...plain, annotations: [{ type: 'rect' }] as ReporterAnnotation[], annotated: png };
  const blurred = { ...plain, annotations: [{ type: 'blur' }] as ReporterAnnotation[] };
  // screenshot + evidence; screenshot + annotated + evidence; blurred screenshot + evidence.
  assert.equal(uploadCount([plain]), 2);
  assert.equal(uploadCount([marked]), 3);
  assert.equal(uploadCount([blurred]), 2);
  assert.equal(uploadCount([plain, marked, blurred]), 7);
  assert.equal(progressText({ stage: 'filing' }), 'Filing…');
  assert.equal(progressText({ stage: 'uploading', done: 0, total: 5 }), 'Uploading 1/5');
  assert.equal(progressText({ stage: 'uploading', done: 5, total: 5 }), 'Uploading 5/5', 'never past the total');
});

test('after a capture: the newest unmarked shot opens the editor once', () => {
  const seen = new Set<string>();
  assert.equal(autoAnnotate([], seen), null);
  assert.equal(autoAnnotate([{ captureId: 'a' }], seen), 'a');
  seen.add('a');
  assert.equal(autoAnnotate([{ captureId: 'a' }], seen), null, 'coming back to the tab does not open it again');
  assert.equal(autoAnnotate([{ captureId: 'a' }, { captureId: 'b' }], seen), 'b', 'an added shot opens too');
  assert.equal(autoAnnotate([{ captureId: 'c', annotations: [{}] }], seen), null, 'already marked');
});
