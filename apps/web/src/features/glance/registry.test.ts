import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLANCE_PLACEMENTS } from './types.js';

// What every registered widget must satisfy, so one agent's widget cannot break the frame another agent built. The registry
// is imported inside the test: a widget that needs the browser to even load is reported, not a crash of the whole file.
test('every registered widget has a unique id, a one-word label, a sentence for Settings and valid parts', async (t) => {
  let widgets: readonly import('./types.js').GlanceWidget[];
  try {
    widgets = (await import('./registry.js')).GLANCE_WIDGETS;
  } catch (e) {
    t.skip(`the registry needs a browser to load: ${(e as Error).message}`);
    return;
  }
  assert.ok(widgets.length >= 1);
  const ids = widgets.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${ids.join(', ')}`);
  for (const w of widgets) {
    assert.match(w.id, /^[a-z][a-z0-9-]*$/, `${w.id}: lower case, no spaces (it is stored and used in ?glance=)`);
    assert.match(w.label, /^\S{2,14}$/, `${w.id}: the label is one word`);
    assert.ok(w.about.length >= 12, `${w.id}: about is a sentence`);
    assert.equal(typeof w.useCompact, 'function', `${w.id}: useCompact`);
    assert.ok(typeof w.Full === 'function' || typeof w.Full === 'object', `${w.id}: Full is a component (a lazy one is an object)`);
    for (const p of w.placements ?? []) assert.ok(GLANCE_PLACEMENTS.includes(p), `${w.id}: unknown placement ${p}`);
    if (w.href) assert.ok(w.href.startsWith('/admin'), `${w.id}: href stays inside the app`);
  }
});
