import { useCallback, useEffect, useRef, useState } from 'react';
import { useLive } from '@/lib/live';
import { isForbidden } from './api';

/**
 * One read of the portal for a tab: loaded on mount and whenever `key` changes, again on each `claudeusage` push (a budget or spike alert
 * fired, a reading landed) and every minute while the page shows (`live: false` for a report over a window, which is read on purpose only, so
 * its rows never move under the reader). It keeps the last answer while a new one loads, so a tab never blinks to empty. `forbidden` is a refusal (the viewer may not see this: several users are coming), `failed` any other failure of the first load.
 */
export function useLoad<T>(read: () => Promise<T>, key: string, opts: { live?: boolean } = {}) {
  const live = opts.live !== false;
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const asked = useRef(0);
  const latest = useRef(read);
  useEffect(() => {
    latest.current = read;
  });
  const load = useCallback(async () => {
    const ask = ++asked.current;
    setLoading(true);
    try {
      const next = await latest.current();
      if (ask !== asked.current) return;
      setData(next);
      setFailed(false);
      setForbidden(false);
    } catch (e) {
      if (ask !== asked.current) return;
      setForbidden(isForbidden(e));
      setFailed(true);
    } finally {
      if (ask === asked.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    if (!live) return;
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), 60_000);
    return () => window.clearInterval(t);
    // `key` is what the read depends on (a range, a dimension): a new key is a new read.
  }, [load, key, live]);
  useLive('claudeusage', () => void load(), live);
  return { data, failed: failed && !data, forbidden, loading, reload: load, set: setData };
}
