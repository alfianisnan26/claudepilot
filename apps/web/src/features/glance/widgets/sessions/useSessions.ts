import { useMemo } from 'react';
import type { GlanceCompact, GlanceContext } from '../../types';
import { useGlance } from '../shared/store';
import { sessionsCompact } from './model';

/** The Sessions chip, from the shared snapshot (no request of its own). */
export function useSessionsCompact(_ctx: GlanceContext): GlanceCompact {
  const { data, failed, stale } = useGlance();
  return useMemo(() => sessionsCompact({ data, failed, stale }), [data, failed, stale]);
}
