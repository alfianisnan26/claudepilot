// T-423 and D-65 in docs/dev-sessions/supervisor.mjs: an idle lead past the compaction line is told to `/compact` (at most once per gap), and a
// lead is left un-nudged only while every one of its worker slots is busy (one busy worker no longer holds free slots and an open backlog).
// The real script is imported (it does not run its loop on import); times are relative to now, never a fixed date.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'supervisor-t423-'));
Object.assign(process.env, {
  PORTAL_URL: 'http://portal.test',
  PORTAL_SERVER_CODE: `t${Math.random().toString(36).slice(2, 10)}`,
  STATE_DIR: dir,
  MAIN_FOLDER: dir,
  DRY_RUN: '0',
});

type Lead = { id: string; state: string; context?: { usedTokens: number } };
type Row = { id: string; parentId: string | null; state: string; lastActivityAt: string };
const sup = (await import(pathToFileURL(resolve(import.meta.dirname, '../../../../docs/dev-sessions/supervisor.mjs')).href)) as {
  compactDue: (cur: Lead, ts: { compactedAt?: number }, now?: number) => boolean;
  slotsFull: (sessions: Row[], cur: Lead, cap: number, now?: number) => boolean;
  COMPACT: string;
};

const MIN = 60_000;

test('T-423: an idle lead past 120k is due a compaction; not while it works, not under the line, not twice within 30 minutes', () => {
  const now = Date.now();
  assert.equal(sup.compactDue({ id: 'l', state: 'idle', context: { usedTokens: 156_000 } }, {}, now), true);
  assert.equal(sup.compactDue({ id: 'l', state: 'working', context: { usedTokens: 300_000 } }, {}, now), false, 'never mid-turn');
  assert.equal(sup.compactDue({ id: 'l', state: 'idle', context: { usedTokens: 80_000 } }, {}, now), false, 'under the line');
  assert.equal(sup.compactDue({ id: 'l', state: 'idle' }, {}, now), false, 'no context figure: nothing is done');
  assert.equal(sup.compactDue({ id: 'l', state: 'idle', context: { usedTokens: 200_000 } }, { compactedAt: now - 10 * MIN }, now), false, 'within the gap');
  assert.equal(sup.compactDue({ id: 'l', state: 'idle', context: { usedTokens: 200_000 } }, { compactedAt: now - 31 * MIN }, now), true, 'after the gap');
  // The command is one the portal lets MCP send (portalmcp/tools/sessions.ts SLASH_ALLOWED), with what the lead must keep.
  assert.match(sup.COMPACT, /^\/compact /);
  assert.match(sup.COMPACT, /crew/);
});

test('D-65: a lead is left alone only while all its worker slots are busy; idle, stale or other leads\' workers do not count', () => {
  const now = Date.now();
  const lead: Lead = { id: 'lead', state: 'idle' };
  const at = (min: number) => new Date(now - min * MIN).toISOString();
  const w = (id: string, state: string, min: number, parentId: string | null = 'lead'): Row => ({ id, parentId, state, lastActivityAt: at(min) });
  const one = [w('a', 'working', 1), w('b', 'idle', 2), w('c', 'idle', 20)];
  assert.equal(sup.slotsFull(one, lead, 5, now), false, 'one busy worker and free slots: the lead is nudged');
  const full = [1, 2, 3, 4, 5].map((i) => w(`w${i}`, 'working', i));
  assert.equal(sup.slotsFull(full, lead, 5, now), true, 'five busy of five: their reports wake it');
  const stale = [...full.slice(0, 4), w('w5', 'working', 40)];
  assert.equal(sup.slotsFull(stale, lead, 5, now), false, 'a worker silent for 40 min is not counted as busy');
  const others = [...full.slice(0, 4), w('x', 'working', 1, 'other-lead')];
  assert.equal(sup.slotsFull(others, lead, 5, now), false, 'another lead\'s worker does not fill this lead\'s slots');
});
