// Usage spend: the attribution report as a CSV file (docs/prd/claude-usage.md §22.5). Titles of sessions come from people and agents, so a cell that
// a spreadsheet could read as a formula (it starts with =, +, -, @, a tab or a carriage return) is prefixed with an apostrophe, the same rule as
// the Requests export. Dollars are named as estimates in the header; token and request columns are stored counts.

import type { AttributionReport } from '@portal/contracts';

export const ATTRIBUTION_CSV_HEADER = [
  'by',
  'key',
  'label',
  'state',
  'reason',
  'cost_usd_estimate',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'requests',
  'agents',
  'own_cost_usd_estimate',
  'own_requests',
  'share_pct_estimate',
  'sessions',
  'first_at',
  'last_at',
  'depth',
  'parent_id',
  'workspace',
  'claude',
  'ticket',
  'session_exists',
] as const;

/** One cell: a number as it is; text quoted when it holds a comma, a quote or a line break, and neutralised when it could be a formula. */
export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function attributionCsv(report: AttributionReport): string {
  const lines = [ATTRIBUTION_CSV_HEADER.join(',')];
  for (const r of report.rows) {
    const s = r.session;
    lines.push(
      [
        r.by,
        r.key,
        r.label,
        r.state,
        r.reason ?? '',
        r.total.costUsd,
        r.total.input,
        r.total.output,
        r.total.cacheRead,
        r.total.cacheWrite,
        r.total.requests,
        r.total.agents,
        r.own.costUsd,
        r.own.requests,
        r.share.value,
        r.sessions,
        r.firstAt,
        r.lastAt,
        s?.depth ?? '',
        s?.parentId ?? '',
        s?.workspaceName ?? '',
        s?.claudeName ?? '',
        s?.ticketId ?? '',
        s ? s.exists : '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
