// T-460: the supervisor's bestClaude (docs/dev-sessions/supervisor.mjs) never starts a lead on a Claude auto move would leave: it asks the portal
// (`GET /api/autotransfer/leaving`, the server's one projection rule) and skips those. Runs the real script against a fake portal.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'supervisor-t460-'));
Object.assign(process.env, {
  PORTAL_URL: 'http://portal.test',
  PORTAL_SERVER_CODE: `t${Math.random().toString(36).slice(2, 10)}`,
  STATE_DIR: dir,
  MAIN_FOLDER: dir,
  ROUND_S: '0',
  STAGGER_S: '0',
  DRY_RUN: '0',
});

const portal = {
  /** claudeId -> highest used percent; leaving: the ids the portal says auto move would leave; leavingStatus: how /leaving answers. */
  used: {} as Record<string, number>,
  leaving: [] as string[],
  leavingStatus: 200,
  calls: [] as string[],
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  portal.calls.push(url.pathname);
  if (url.pathname === '/api/login') return json(200, { data: {} }, { 'set-cookie': `s=${Math.random().toString(36).slice(2)}; Path=/` });
  if (url.pathname === '/api/chat/claudes') return json(200, { data: ['rossi', 'satria', 'hasyim'].map((name) => ({ name, id: `c-${name}` })) });
  if (url.pathname === '/api/claude-usage') return json(200, { data: { claudes: Object.entries(portal.used).map(([claudeId, usedPct]) => ({ claudeId, windows: [{ usedPct }] })) } });
  if (url.pathname === '/api/autotransfer/leaving') {
    if (portal.leavingStatus !== 200) return json(portal.leavingStatus, { error: { code: 'NOT_FOUND', message: 'no such route' } });
    return json(200, { data: { claudes: Object.keys(portal.used).map((claudeId) => ({ claudeId, leaves: portal.leaving.includes(claudeId) })) } });
  }
  return json(404, { error: { code: 'NOT_FOUND', message: `fake portal: no ${url.pathname}` } });
}) as typeof fetch;

const sup = (await import(pathToFileURL(resolve(import.meta.dirname, '../../../../docs/dev-sessions/supervisor.mjs')).href)) as {
  bestClaude: (names: string[]) => Promise<{ name: string; id: string; used: number } | null>;
};

test('T-460: bestClaude skips a Claude auto move would leave although it is the least used; with all of them leaving, the least used; no answer: not filtering', async () => {
  // rossi is the least used by the percent, but projected to run out: auto move leaves it five minutes after the lead starts there.
  Object.assign(portal, { used: { 'c-rossi': 22, 'c-satria': 40, 'c-hasyim': 60 }, leaving: ['c-rossi'], leavingStatus: 200 });
  assert.equal((await sup.bestClaude(['rossi', 'satria', 'hasyim']))?.name, 'satria');

  portal.leaving = ['c-rossi', 'c-satria', 'c-hasyim'];
  assert.equal((await sup.bestClaude(['rossi', 'satria', 'hasyim']))?.name, 'rossi', 'all leaving: the least used of them');

  portal.leaving = [];
  assert.equal((await sup.bestClaude(['rossi', 'satria', 'hasyim']))?.name, 'rossi', 'none leaving: the least used');

  portal.leaving = ['c-rossi'];
  portal.leavingStatus = 404; // an older portal without the route
  assert.equal((await sup.bestClaude(['rossi', 'satria', 'hasyim']))?.name, 'rossi', 'the answer failed: the old behaviour');
});
