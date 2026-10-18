// T-119 S2a: a fixed flow for the chart until the route (S2b) exists. Times are minutes after `start`, so the same fixture serves a test and a look.

import type { TicketFlow, TicketFlowActor, TicketFlowMarker, TicketFlowSpan, TicketFlowState } from '@portal/contracts';
import type { FlowChartRow } from './FlowChart';

const MIN = 60_000;
const who = (label: string, session: string | null = null): TicketFlowActor => ({ actor: session ? `session:${session}` : 'ui', label, session });

/** Four tickets: a clean run, a reopened one, one that waited for a person, one still open with nothing else. */
export function fixtureRows(start: number, now: number): FlowChartRow[] {
  const iso = (m: number): string => new Date(start + m * MIN).toISOString();
  const span = (state: TicketFlowState, from: number, to: number | null, by: TicketFlowActor | null, reason: string | null = null): TicketFlowSpan => ({
    state,
    start: iso(from),
    end: to === null ? null : iso(to),
    durationMs: to === null ? Math.max(0, now - (start + from * MIN)) : state === 'done' || state === 'wont_do' ? 0 : (to - from) * MIN,
    by,
    reason,
  });
  const mark = (kind: TicketFlowMarker['kind'], m: number, by: TicketFlowActor, detail: string | null): TicketFlowMarker => ({ kind, at: iso(m), by, detail });
  const flow = (spans: TicketFlowSpan[], markers: TicketFlowMarker[]): TicketFlow => {
    const totals: TicketFlow['totals'] = {};
    for (const s of spans) totals[s.state] = (totals[s.state] ?? 0) + s.durationMs;
    return { spans, markers, state: spans.at(-1)?.state ?? null, totals };
  };
  const admin = who('Admin');
  const lane = who('Build lane', 's1');
  const qa = who('QA', 's2');
  return [
    {
      id: 'T-101',
      title: 'Clean run',
      flow: flow(
        [span('open', 0, 10, admin), span('in_progress', 10, 70, lane), span('in_review', 70, 95, lane), span('done', 95, 95, qa, 'QA passed')],
        [mark('claimed', 10, lane, 's1'), mark('comment', 40, admin, 'Looks right')],
      ),
    },
    {
      id: 'T-102',
      title: 'Reopened',
      flow: flow(
        [span('open', 5, 20, admin), span('in_progress', 20, 50, lane), span('done', 50, 50, lane), span('in_progress', 80, 130, lane, 'QA found a gap'), span('in_review', 130, null, lane)],
        [mark('priority', 80, admin, 'normal → high')],
      ),
    },
    {
      id: 'T-103',
      title: 'Waited',
      flow: flow(
        [span('open', 0, 15, admin), span('in_progress', 15, 30, lane), span('waiting', 30, 85, lane, 'needs-a-person'), span('in_progress', 85, null, lane)],
        [mark('tags', 30, lane, '+needs-a-person'), mark('waiting', 30, lane, 'needs-a-person'), mark('tags', 85, admin, '-needs-a-person')],
      ),
    },
    { id: 'T-104', title: 'Blocked', flow: flow([span('open', 25, 40, admin), span('blocked', 40, null, lane, 'waiting for the lane')], [mark('assigned', 40, admin, 's1')]) },
  ];
}
