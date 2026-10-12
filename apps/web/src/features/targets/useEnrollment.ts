import type { ConnectEnrollment, ConnectTargetView } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useLive, useLiveConnected } from '@/lib/live';
import { connectApi } from './api';
import { enrollmentLive, type EnrollmentLive } from './view';

export type LiveLineState = EnrollmentLive | { state: 'error'; message: string };

const FALLBACK_MS = 3_000;

/**
 * The wizard's live line: the target and the enrollment, loaded again when the portal says `connect` changed (the live topic), by a
 * slow poll only while the live socket is down, and once more at the moment the token expires.
 */
export function useEnrollment(targetId: string | null, enrollmentId: string | null, baseline: readonly string[]) {
  const [target, setTarget] = useState<ConnectTargetView | null>(null);
  const [enrollment, setEnrollment] = useState<ConnectEnrollment | null>(null);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    if (!targetId || !enrollmentId) return;
    try {
      const [t, list] = await Promise.all([connectApi.get(targetId), connectApi.enrollments(targetId)]);
      setTarget(t);
      setEnrollment(list.find((e) => e.id === enrollmentId) ?? null);
      setRemoved(false);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setRemoved(true);
      else setError(e instanceof Error ? e.message : 'Could not check.');
    }
  }, [targetId, enrollmentId]);

  useEffect(() => {
    setTarget(null);
    setEnrollment(null);
    setRemoved(false);
    setError(null);
    void refresh();
  }, [refresh]);

  const live = useLiveConnected();
  useLive('connect', () => void refresh(), !!targetId);
  useEffect(() => {
    if (live || !targetId) return;
    const t = setInterval(() => void refresh(), FALLBACK_MS);
    return () => clearInterval(t);
  }, [live, targetId, refresh]);

  // The expiry is a moment, not an event: tick once when it passes.
  const expiresAt = enrollment?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const wait = Date.parse(expiresAt) - Date.now();
    if (wait <= 0) return setNow(Date.now());
    const t = setTimeout(() => setNow(Date.now()), Math.min(wait + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [expiresAt]);

  const line: LiveLineState | null = !targetId
    ? null
    : error && !target
      ? { state: 'error', message: error }
      : removed
        ? { state: 'removed' }
        : target || enrollment
          ? enrollmentLive(target, enrollment, baseline, now)
          : null;
  return { target, enrollment, line, error, refresh };
}
