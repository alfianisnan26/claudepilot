import type { RepoWorkspaceSummary, ReposOverview, WorkspaceRepos } from '@portal/contracts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLive, useLiveConnected } from '@/lib/live';
import { ApiError } from '@/lib/api';
import { reposApi } from './api';

/* ---------- Every workspace's summary (the chips on the list) ---------- */

interface Snapshot {
  overview: ReposOverview | null;
  failed: boolean;
}

let snap: Snapshot = { overview: null, failed: false };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let loadedAt = 0;
/** A copy this young is not asked for again by a component that only mounted. */
const FRESH_MS = 10_000;

const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** Loads the overview (one request at a time, however many ask). */
export function reloadReposOverview(): Promise<void> {
  if (inflight) return inflight;
  inflight = reposApi
    .overview()
    .then(
      (overview) => {
        snap = { overview, failed: false };
        loadedAt = Date.now();
      },
      () => {
        // Keep what was shown: a chip that blinks away because one request failed is worse than a stale one.
        snap = { overview: snap.overview, failed: true };
      },
    )
    .finally(() => {
      inflight = null;
      emit();
    });
  return inflight;
}

/**
 * Each workspace's repository summary, by workspace id, kept fresh: loaded on first use, again on each `repos` push and after the
 * socket reconnects. A workspace that was never scanned (or can't be, like a Kubernetes one) has no entry.
 */
export function useReposOverview(): { byWorkspace: ReadonlyMap<string, RepoWorkspaceSummary>; failed: boolean } {
  const s = useSyncExternalStore(subscribe, () => snap);
  const connected = useLiveConnected();
  useLive('repos', () => void reloadReposOverview());
  useEffect(() => {
    if (!snap.overview || Date.now() - loadedAt > FRESH_MS) void reloadReposOverview();
  }, []);
  useEffect(() => {
    // The socket came back: whatever changed meanwhile wasn't pushed.
    if (connected && Date.now() - loadedAt > 5_000) void reloadReposOverview();
  }, [connected]);
  const byWorkspace = useMemo(() => new Map((s.overview?.workspaces ?? []).map((w) => [w.workspaceId, w] as const)), [s.overview]);
  return { byWorkspace, failed: s.failed && !s.overview };
}

/* ---------- One workspace's tree ---------- */

/**
 * A workspace's repositories as the last scan left them, loaded while `enabled` and again on each `repos` push, after the socket
 * reconnects and after anything this page does (`reload`). `replace` puts an answer the page already has (a scan's) in at once.
 */
export function useWorkspaceRepos(workspaceId: string, enabled = true) {
  const [data, setData] = useState<WorkspaceRepos | null>(null);
  // Why the last load failed (the portal's own words: "Could not reach the server."), until one succeeds.
  const [failed, setFailed] = useState<string | null>(null);
  // The portal said no (403): its reason, to show instead of a tree.
  const [denied, setDenied] = useState<string | null>(null);
  const current = useRef(workspaceId);
  useLayoutEffect(() => {
    current.current = workspaceId;
  });
  const connected = useLiveConnected();
  const wasConnected = useRef(connected);

  const reload = useCallback(async () => {
    const id = workspaceId;
    try {
      const next = await reposApi.workspace(id);
      if (current.current !== id) return;
      setData(next);
      setFailed(null);
      setDenied(null);
      // The chips on the list follow (not while a scan is still going: its end asks again).
      if (!next.scan.running) void reloadReposOverview();
    } catch (e) {
      if (current.current !== id) return;
      if (e instanceof ApiError && e.status === 403) setDenied(e.message);
      else setFailed(e instanceof Error ? e.message : 'Couldn’t load the repos.');
    }
  }, [workspaceId]);

  useEffect(() => {
    setData(null);
    setFailed(null);
    setDenied(null);
    if (enabled) void reload();
  }, [reload, enabled]);
  useLive('repos', () => void reload(), enabled);
  useEffect(() => {
    // The socket came back: whatever changed meanwhile wasn't pushed.
    if (connected && !wasConnected.current && enabled) void reload();
    wasConnected.current = connected;
  }, [connected, enabled, reload]);

  // A scan that is running when the tree arrives says so; one that changed nothing is not pushed when it ends, so ask again until it has.
  const polls = useRef(0);
  const scanning = !!data?.scan.running;
  useEffect(() => {
    if (!enabled || !scanning) {
      polls.current = 0;
      return;
    }
    if (polls.current >= 40) return;
    const t = window.setTimeout(() => {
      polls.current++;
      void reload();
    }, 1500);
    return () => window.clearTimeout(t);
  }, [enabled, scanning, data, reload]);

  const replace = useCallback((next: WorkspaceRepos) => {
    setData(next);
    setFailed(null);
    void reloadReposOverview();
  }, []);
  // `failed`: nothing to show and why; `stale`: what is shown is the last copy, because the latest load failed.
  return { data, failed: data ? null : failed, stale: data ? failed : null, denied: data ? null : denied, reload, replace };
}
