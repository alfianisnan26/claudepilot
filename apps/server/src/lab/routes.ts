// Efficiency lab: the read routes (docs/prd/claude-usage.md §28.10, LAB_API). Mounted by app.ts behind `requireSession` at /api/lab. Each
// handler asks the seam once (authz.ts): `view` on the platform area `usage`; an agent actor reads its own session only. A denial is the same
// 404 as a missing route. Counts and ids only: no transcript text is stored, so none can be returned.

import { AppError, success } from '@isnanme/core';
import { Hono, type Context } from 'hono';
import { CREW_WINDOWS, platformRef, type Actor, type CrewWindow, type LabPeriod } from '@portal/contracts';
import { actorOf, actorString, can } from '../authz/seam.js';
import { declareLabPolicies } from './authz.js';
import type { Lab, ViewFilter } from './index.js';
import { slicesPage } from './slicesPage.js';

declareLabPolicies();

const NOT_FOUND = () => new AppError('NOT_FOUND', 'Not found.');
const usageArea = platformRef('usage');

/** Who may read, and the one session an agent is held to (null: every session). Throws the 404 for anyone else. */
export function labReader(actor: Actor): { session: string | null } {
  if (actor.kind === 'agent') return { session: actor.sessionId };
  if (!can(actor, 'view', usageArea).allow) throw NOT_FOUND();
  return { session: null };
}

/** `since` as ms since the epoch or an ISO time; undefined when absent; a 400 when it is neither. */
export function parseSince(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = /^\d{1,15}$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n)) throw new AppError('VALIDATION_FAILED', 'since: ms since the epoch or an ISO time.', { details: { since: 'ms or ISO time' } });
  return n;
}

const ID = /^[A-Za-z0-9_.:=-]{1,120}$/;
const param = (c: Context, name: string): string | undefined => {
  const v = c.req.query(name);
  if (v === undefined || v === '') return undefined;
  if (!ID.test(v)) throw new AppError('VALIDATION_FAILED', `${name}: letters, digits and _ . : = - only.`, { details: { [name]: 'invalid' } });
  return v;
};

export function createLabRoutes(lab: Lab): Hono {
  const r = new Hono();

  // GET /api/lab/slices?session=&ticket=&role=&model=&experiment=&arm=&since=&limit=&cursor=: newest first, one page.
  r.get('/slices', (c) => {
    const who = labReader(actorOf(c));
    const asked = param(c, 'session');
    if (who.session && asked && asked !== who.session) throw NOT_FOUND();
    const session = who.session ?? asked;
    const since = parseSince(c.req.query('since'));
    const ticket = param(c, 'ticket'), role = param(c, 'role'), model = param(c, 'model'), experiment = param(c, 'experiment'), arm = param(c, 'arm');
    const filter: ViewFilter = {
      ...(session ? { sessionId: session } : {}),
      ...(ticket ? { ticket } : {}),
      ...(role ? { role } : {}),
      ...(model ? { model } : {}),
      ...(experiment ? { experiment } : {}),
      ...(arm ? { arm } : {}),
      ...(since !== undefined ? { fromMs: since } : {}),
    };
    // D-58: one page, `{ items, next }` (25 by default, 100 at most; `total` on the first page). The cursor is bound to the caller and every filter.
    const scope = `lab.slices|${JSON.stringify([actorString(actorOf(c)), session ?? '', ticket ?? '', role ?? '', model ?? '', experiment ?? '', arm ?? '', since ?? ''])}`;
    return c.json(success(slicesPage(lab.views(filter), { scope, cursor: c.req.query('cursor') || undefined, limit: c.req.query('limit') })));
  });

  // GET /api/lab/experiments: every experiment with its arms' counts and the primary with its interval. Not for an agent's own view.
  r.get('/experiments', (c) => {
    if (labReader(actorOf(c)).session) throw NOT_FOUND();
    return c.json(success(lab.experimentViews()));
  });

  // GET /api/lab/summary?period=day|week&since=
  r.get('/summary', (c) => {
    const who = labReader(actorOf(c));
    const p = c.req.query('period') ?? 'day';
    if (p !== 'day' && p !== 'week') throw new AppError('VALIDATION_FAILED', 'period: day or week.', { details: { period: 'day or week' } });
    const since = parseSince(c.req.query('since'));
    return c.json(success(lab.summary({ period: p as LabPeriod, ...(since !== undefined ? { sinceMs: since } : {}), ...(who.session ? { sessionId: who.session } : {}) })));
  });

  // GET /api/lab/scorecard?window=1h|6h|day|week&compare=0|1&program=: the crew scorecard (T-450). An agent: its own program only; another
  // program is the same 404 as one that does not exist.
  r.get('/scorecard', async (c) => {
    const who = labReader(actorOf(c));
    const w = c.req.query('window') ?? 'day';
    if (!(CREW_WINDOWS as readonly string[]).includes(w)) throw new AppError('VALIDATION_FAILED', 'window: 1h, 6h, day or week.', { details: { window: '1h, 6h, day or week' } });
    const cmp = c.req.query('compare');
    if (cmp !== undefined && cmp !== '0' && cmp !== '1') throw new AppError('VALIDATION_FAILED', 'compare: 0 or 1.', { details: { compare: '0 or 1' } });
    const program = param(c, 'program');
    const s = await lab.scorecardWithPace({ window: w as CrewWindow, compare: cmp !== '0', ...(program ? { program } : {}), ...(who.session ? { sessionId: who.session } : {}) });
    if (!s) throw NOT_FOUND();
    return c.json(success(s));
  });

  return r;
}
