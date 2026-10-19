// What a spike event says (docs/prd/claude-usage.md §24): the heuristics' evidence in words, and the sensitivity they ran with. A spike is a rule of
// thumb, always labelled so, never proof; the numbers behind it are shown with how they are known (dollars are estimates). Pure and tested.

import { reasonText, type SpendFigure, type SpikeEvidence, type SpikeKind, type SpikeSettings } from '@portal/contracts';

export const KIND_WORD: Record<SpikeKind, string> = { rate: 'Rate', burst: 'Burst', outlier: 'Outlier' };

// Worded as the portal words the line above it (usagespend/spikes.ts): "$1.20", "$12", "4x", so a row and its evidence read the same.
const money = (v: number): string => `$${v < 10 ? v.toFixed(2) : Math.round(v).toString()}`;
const usd = (f: SpendFigure): string => (f.basis === 'unavailable' ? '-' : money(f.value));
const times = (f: SpendFigure): string => (f.basis === 'unavailable' ? '-' : `${f.value >= 10 ? Math.round(f.value) : Math.round(f.value * 10) / 10}x`);

/** The evidence of one event as a sentence for its ⓘ. Every dollar is an estimate and says so once at the end. */
export function evidenceText(e: SpikeEvidence): string {
  switch (e.kind) {
    case 'rate':
      if (e.baselineUsd.basis === 'unavailable') return `${usd(e.spentUsd)} in the last ${e.windowMin} minutes. Nothing to compare it with: ${reasonText(e.baselineUsd.reason)} Dollars are estimates.`;
      return (
        `${usd(e.spentUsd)} in the last ${e.windowMin} minutes, against a usual ${usd(e.baselineUsd)} (the 90th percentile of ${e.periods} active ${e.windowMin}-minute periods in the 7 days before): ${times(e.factor)}.` +
        `${e.topSession ? ` ${Math.round(e.topSession.share)} % of it was one session.` : ''} Dollars are estimates.`
      );
    case 'burst':
      return `${e.requests} finished requests in ${e.windowMin} minutes by one agent; the limit is ${e.threshold}. They cost ${usd(e.spentUsd)}. Dollars are estimates.`;
    case 'outlier':
      if (e.medianUsd.basis === 'unavailable') return `One ${usd(e.costUsd)} request. Nothing to compare it with: ${reasonText(e.medianUsd.reason)} Dollars are estimates.`;
      return `One ${usd(e.costUsd)} request, ${times(e.factor)} the median of ${usd(e.medianUsd)} over ${e.requests} requests in the 7 days before. Dollars are estimates.`;
  }
}

/** The sensitivity the heuristics ran with (Settings → Usage), for the list's ⓘ. */
export function sensitivityText(s: SpikeSettings): string {
  if (!s.enabled) return 'Spike detection is off in Settings.';
  return (
    `Rules of thumb, not proof that anything is wrong: they alert and never act. ` +
    `Rate: the last 15 minutes cost ${s.rateFactor}x the usual or more. Burst: ${s.burstRequests} requests in ${s.burstWindowMin} minutes by one agent. ` +
    `Outlier: one request ${s.outlierFactor}x the median or more. Nothing under ${money(s.minUsd)}.`
  );
}
