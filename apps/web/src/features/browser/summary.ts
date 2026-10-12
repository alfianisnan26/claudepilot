import type { BrowserPoolContent, PoolSummary } from '@portal/contracts';

export const poolContent = (p: PoolSummary) => p.content as BrowserPoolContent | null;

const TIER = { headless: 'Headless', browser: 'Browser', desktop: 'Desktop' } as const;

/** The line a pool card shows: "Browser · 1280×800 · sleeps after 30 min". */
export function poolSummary(p: PoolSummary): string {
  const c = poolContent(p);
  if (!c) return '';
  return [TIER[c.tier], c.display.replace('x', '×'), c.idleMinutes ? `sleeps after ${c.idleMinutes} min` : 'never sleeps'].join(' · ');
}
