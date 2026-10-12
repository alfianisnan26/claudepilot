// Claude usage: CSV and JSON export of the Requests report and of the plan readings (docs/prd/claude-usage.md §20.9). Pure formatting: the rows
// come from spend.ts and the store. Every cell is escaped, and a cell that a spreadsheet would read as a formula is made plain text.

import type { ChatUsageRange, ClaudeUsageHistory } from '@portal/contracts';
import { usageWindow } from '../chat/usage.js';
import { ClaudeIndex, zeroTotals, addRow, type ClaudeKey, type SpendReader } from './spend.js';

/** A CSV cell: quoted when it holds a comma, a quote or a line break; a leading `=`, `+`, `-`, `@`, tab or carriage return is defused with `'`. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v) : v;
  // A negative number is a number, not a formula; text that merely starts with a minus is text.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const nameOfWorkspace = (id: string) => id.split('/').pop() ?? id;

export const REQUESTS_CSV_HEADER = ['bucket_start', 'claude', 'workspace', 'model', 'requests', 'agents', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd_estimate'];

/**
 * One row per bucket, Claude and model that ran something, oldest bucket first (docs §20.9). Tokens and requests are stored counts; the dollar
 * column is named for what it is: Claude Code's price estimate, not a bill.
 */
export function requestsCsv(reader: SpendReader, range: ChatUsageRange, opts: { claudeId?: string; tzOffsetMin?: number; now: number; allow?: (claude: ClaudeKey) => boolean }): string {
  const w = usageWindow(range, opts.now, opts.tzOffsetMin);
  const index = new ClaudeIndex(reader.claudes());
  const cells = new Map<string, { bucket: number; claude: string; workspace: string; model: string; totals: ReturnType<typeof zeroTotals> }>();
  for (const r of reader.rowsBetween(w.start, w.end)) {
    const ref = index.resolve(r);
    if (opts.claudeId && ref.claudeId !== opts.claudeId && ref.key !== opts.claudeId) continue;
    if (opts.allow && !opts.allow(ref)) continue;
    const bucket = Math.floor((r.atMs - w.start) / w.bucket);
    if (bucket < 0 || bucket >= w.count) continue;
    const key = `${bucket}\u0000${ref.key}\u0000${r.model}`;
    let c = cells.get(key);
    if (!c) {
      c = { bucket, claude: ref.name, workspace: nameOfWorkspace(ref.workspaceId), model: r.model, totals: zeroTotals() };
      cells.set(key, c);
    }
    addRow(c.totals, r);
  }
  const rows = [...cells.values()]
    .sort((a, b) => a.bucket - b.bucket || a.workspace.localeCompare(b.workspace) || a.claude.localeCompare(b.claude) || a.model.localeCompare(b.model))
    .map((c) => [new Date(w.start + c.bucket * w.bucket).toISOString(), c.claude, c.workspace, c.model, c.totals.requests, c.totals.agents, c.totals.input, c.totals.output, c.totals.cacheRead, c.totals.cacheWrite, Math.round(c.totals.costUsd * 1e6) / 1e6]);
  return toCsv(REQUESTS_CSV_HEADER, rows);
}

export const QUOTA_CSV_HEADER = ['at', 'claude', 'workspace', 'window', 'used_pct'];

/** One row per stored reading: when, the Claude, its workspace, the window and the percent Claude Code reported. */
export function quotaCsv(histories: { claudeName: string; workspaceName: string; history: ClaudeUsageHistory }[]): string {
  const rows: (string | number)[][] = [];
  for (const { claudeName, workspaceName, history } of histories) {
    for (const s of history.series) for (const p of s.points) rows.push([p.at, claudeName, workspaceName, s.key, p.usedPct]);
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])) || String(a[3]).localeCompare(String(b[3])));
  return toCsv(QUOTA_CSV_HEADER, rows);
}

/** The file name of a download: only characters that are safe in a header. */
export const exportFileName = (what: string, range: string, format: string): string => `claudepilot-usage-${what}-${range}.${format}`.replace(/[^A-Za-z0-9._-]/g, '_');
