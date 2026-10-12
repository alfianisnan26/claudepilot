import { headroomFrom, type ClaudeUsage, type ClaudeUsageReport, type ClaudeUsageWindow, type Headroom } from '@portal/contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLive, useLiveConnected } from '@/lib/live';
import { claudeUsageApi } from './api';

/**
 * One copy of the snapshot for every place that shows it (the Usage tab, the Claude rows, the switch dialog, the alert
 * watcher): the portal is asked once however many of them are on screen, and the live topic `claudeusage` says when to ask again.
 */
interface Snapshot {
  report: ClaudeUsageReport | null;
  failed: boolean;
}

let snap: Snapshot = { report: null, failed: false };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let loadedAt = 0;
/** A copy this young is not asked for again by a component that only mounted. */
const FRESH_MS = 15_000;
/** While the Usage tab is open, the portal is told every so often so it keeps reading at the faster interval. */
const WATCH_EVERY_MS = 45_000;

const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** Loads the snapshot (one request at a time, however many ask). `watch`: the Usage tab is open. */
export function reloadClaudeUsage(watch = false): Promise<void> {
  if (inflight) return inflight;
  inflight = claudeUsageApi
    .report(watch)
    .then(
      (report) => {
        snap = { report, failed: false };
        loadedAt = Date.now();
      },
      () => {
        snap = { report: snap.report, failed: true };
      },
    )
    .finally(() => {
      inflight = null;
      emit();
    });
  return inflight;
}

/** Puts one Claude's fresh row (from a check or a snooze) into the shared copy. */
export function replaceClaude(row: ClaudeUsage): void {
  if (!snap.report) return;
  snap = { ...snap, report: { ...snap.report, claudes: snap.report.claudes.map((c) => (c.claudeId === row.claudeId ? row : c)) } };
  emit();
}

/**
 * The snapshot, kept fresh: loaded on first use, again on each `claudeusage` push and after the socket reconnects. With
 * `watch` (the Usage tab) the portal is also told every 45 seconds that someone is looking.
 */
export function useClaudeUsage(opts: { watch?: boolean } = {}) {
  const s = useSyncExternalStore(subscribe, () => snap);
  const connected = useLiveConnected();
  const watch = !!opts.watch;
  useLive('claudeusage', () => void reloadClaudeUsage(watch));
  useEffect(() => {
    if (!snap.report || Date.now() - loadedAt > FRESH_MS || watch) void reloadClaudeUsage(watch);
  }, [watch]);
  useEffect(() => {
    // The socket came back: whatever changed meanwhile wasn't pushed.
    if (connected && Date.now() - loadedAt > 5_000) void reloadClaudeUsage(watch);
  }, [connected, watch]);
  useEffect(() => {
    if (!watch) return;
    const t = window.setInterval(() => document.visibilityState === 'visible' && void reloadClaudeUsage(true), WATCH_EVERY_MS);
    return () => window.clearInterval(t);
  }, [watch]);
  return { report: s.report, failed: s.failed && !s.report, stale: s.failed && !!s.report, reload: () => reloadClaudeUsage(watch) };
}

/** The time, updated every `ms` (countdowns count down without asking the portal). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** A window as it reads at `nowMs`: its reset time having passed makes the number old, whatever the portal said when it answered. */
export function windowAt(w: ClaudeUsageWindow, nowMs: number): ClaudeUsageWindow {
  return w.resetsAt && Date.parse(w.resetsAt) <= nowMs && w.level !== 'reset' ? { ...w, level: 'reset' } : w;
}

/** What a Claude has left, as the portal's `headroom(claudeId)` says it, from the shared snapshot (no request of its own). */
export function headroomOfClaude(c: ClaudeUsage, nowMs: number): Headroom {
  return headroomFrom({ claudeId: c.claudeId, runsOn: c.runsOn, windows: c.windows.map((w) => windowAt(w, nowMs)), checkedAt: c.checkedAt, stale: c.stale });
}

/** One Claude's row of the snapshot, or null while it loads or when it isn't listed. */
export function useClaudeRow(claudeId: string): ClaudeUsage | null {
  const { report } = useClaudeUsage();
  return report?.claudes.find((c) => c.claudeId === claudeId) ?? null;
}
