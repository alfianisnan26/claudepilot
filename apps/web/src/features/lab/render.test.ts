// T-1852: the Lab and Crew pages on a text diet, rendered to markup (no browser): the basis words are no longer printed under each number,
// an estimate says "est.", a warn or breach has an icon with its word for screen readers, the basis stays on the element and in the tip.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CrewFigure, CrewProgramScore, CrewSummary, CrewSummaryWindow, CrewTarget } from '@portal/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgramCard } from './ScorecardTab';
import { SummaryView } from './SummaryBlock';

const fig = (value: number | null, basis: CrewFigure['basis'] = 'measured', reason?: CrewFigure['reason']): CrewFigure => ({ value, basis, source: 'a source', reason });
const gone = (reason: CrewFigure['reason'] = 'no_samples'): CrewFigure => fig(null, 'unavailable', reason);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const win = (): CrewSummaryWindow => ({
  fromMs: 0,
  toMs: 1,
  requestsPerHour: fig(120),
  usdPerHour: fig(2.5, 'estimate'),
  resolved: fig(45),
  wontDo: fig(3),
  resolvedByProgram: [{ program: 'p', title: 'ClaudePilot', count: 45 }],
  perResolvedUsd: fig(0.42, 'estimate'),
  createdPerClosed: fig(2.87),
  createdPerClosedByProgram: [],
});
const summary: CrewSummary = { pace: { ratio: fig(1), unusedAtResetPct: null, weekly: gone('no_source'), claudes: [] }, current: win(), previous: null };

const program = (targets: CrewTarget[]): CrewProgramScore => ({
  program: 'p',
  title: 'ClaudePilot',
  workspaceId: 'kubernetes/x',
  leads: ['p'],
  workers: 3,
  previous: null,
  targets,
  current: {
    fromMs: 0,
    toMs: 1,
    effectiveness: { done: fig(2), donePerHour: fig(0.5), reopened: fig(0), wontDo: fig(0), byType: [], reviewBacklog: fig(0), review: [], ciRuns: fig(0), ci: [], deploysCount: fig(0), deploys: [] },
    cost: { total: fig(10, 'estimate'), lead: fig(4, 'estimate'), workers: fig(6, 'estimate'), leadShare: gone('no_source'), perDoneAllIn: fig(5, 'estimate'), perDoneWorkers: fig(3, 'estimate') },
    efficiency: {} as CrewProgramScore['current']['efficiency'],
    health: {} as CrewProgramScore['current']['health'],
  },
});

test('summary tiles: no MEASURED / ESTIMATE lines, "est." on an estimate, no "on pace" or "per resolved" words; the basis stays on the tile', () => {
  const html = renderToStaticMarkup(createElement(SummaryView, { summary, expandable: false }));
  const t = text(html);
  assert.doesNotMatch(t, /MEASURED|ESTIMATE/);
  assert.doesNotMatch(t, /on pace|per resolved|backlog grows/);
  assert.match(t, /est\./);
  assert.match(t, /3 won’t do/, 'a number of its own stays');
  assert.equal((html.match(/data-basis="/g) ?? []).length, 5);
  assert.match(html, /data-basis="ESTIMATE"/);
});

test('program card: five tiles with their basis on the element, a state icon on a breach, workers as an icon and a count', () => {
  const breach: CrewTarget = { id: 'live_workers', decision: 'D-61', rule: 'r', state: 'breach', figure: fig(9), offenders: ['S1'] };
  const html = renderToStaticMarkup(createElement(ProgramCard, { p: program([breach]) }));
  const t = text(html);
  assert.equal((html.match(/data-tile="/g) ?? []).length, 5);
  assert.equal((html.match(/data-basis="/g) ?? []).length, 5);
  assert.doesNotMatch(t, /MEASURED|ESTIMATE|ok ·/);
  assert.doesNotMatch(t, /3 workers/, 'the count is an icon and a number; the words are its label');
  assert.match(html, /data-state-mark="breach"/);
  assert.match(t, /breach/, 'the state word is there for screen readers');
  assert.match(html, /aria-label="3 workers"/);
  assert.doesNotMatch(t, /QA\/review on opus/, 'the QA opus line is in the D-65 tip now');
  assert.match(t, /unavailable/, 'an unavailable figure reads the word, never 0');
});
