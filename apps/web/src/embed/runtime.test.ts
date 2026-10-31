// The panel chat's session runtime (owner, 2026-10-31): one info line under the title (model · Claude · context %), a sheet with the rest;
// every value the portal's, "unavailable" where it has none.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReporterChatRuntime } from '@portal/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { contextPct, resetsIn, runtimeLine, runtimeRows } from './chatModel';
import { RuntimeSheet } from './RuntimeSheet';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const full: ReporterChatRuntime = {
  model: 'claude-opus-5-5',
  effort: 'high',
  mode: 'bypassPermissions',
  claude: 'Work',
  context: { usedTokens: 84_000, windowTokens: 200_000 },
  costUsd: 1.25,
  plan: { session: { usedPct: 42, resetsAt: new Date(NOW + (3 * 60 + 5) * 60_000).toISOString() }, week: { usedPct: 12.4, resetsAt: null } },
};
const empty: ReporterChatRuntime = { model: null, effort: null, mode: null, claude: null, context: null, costUsd: null, plan: null };

test('runtimeLine: model as the portal names it, the Claude by name, context percent; only what is known', () => {
  assert.equal(runtimeLine(full), 'Opus 5.5 · Work · 42%');
  assert.equal(runtimeLine({ ...empty, claude: 'Default', context: { usedTokens: 900, windowTokens: null } }), 'Default', 'no window, no percent');
  assert.equal(runtimeLine(empty), '');
  assert.equal(runtimeLine(undefined), '');
  assert.equal(contextPct({ usedTokens: 250_000, windowTokens: 200_000 }), 100);
});

test('runtimeRows: every row has a value or says unavailable; bypass is marked; plan windows with their reset', () => {
  const rows = Object.fromEntries(runtimeRows(full, 'Working', NOW).map((r) => [r.label, r]));
  assert.equal(rows.Status!.value, 'Working');
  assert.equal(rows.Model!.value, 'Opus 5.5 · high');
  assert.equal(rows.Mode!.value, 'Bypass');
  assert.equal(rows.Mode!.tone, 'danger');
  assert.equal(rows.Claude!.value, 'Work');
  assert.equal(rows.Context!.value, '42% · 84k of 200k');
  assert.equal(rows.Cost!.value, '$1.25');
  assert.equal(rows['Plan session']!.value, '42% · resets in 3h 05m');
  assert.equal(rows['Plan week']!.value, '12%');
  for (const r of runtimeRows(empty, 'Idle', NOW).slice(1)) assert.equal(r.value, 'unavailable', r.label);
  assert.equal(resetsIn(null), null);
  assert.equal(resetsIn(new Date(NOW + 30_000).toISOString(), NOW), 'now');
  assert.equal(resetsIn(new Date(NOW + 3 * 86_400_000).toISOString(), NOW), 'in 3d');
});

test('RuntimeSheet: a labelled dialog listing the rows, with a 44 px Close', () => {
  const html = renderToStaticMarkup(createElement(RuntimeSheet, { runtime: full, status: 'Working', onClose: () => undefined }));
  assert.match(html, /role="dialog"[^>]*aria-label="Session"/);
  for (const t of ['Opus 5.5 · high', 'Bypass', 'Work', '84k of 200k', '$1.25']) assert.ok(html.includes(t), t);
  assert.match(html, /aria-label="Close"/);
  const none = renderToStaticMarkup(createElement(RuntimeSheet, { runtime: undefined, status: 'Loading', onClose: () => undefined }));
  assert.ok((none.match(/unavailable/g) ?? []).length >= 7, 'unavailable, never a guess');
});
