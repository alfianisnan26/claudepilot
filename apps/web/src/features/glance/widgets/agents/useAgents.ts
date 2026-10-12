import { useMemo } from 'react';
import type { GlanceCompact, GlanceContext } from '../../types';
import { useGlance } from '../shared/store';
import { agentsCompact } from './model';

/** The Agents chip, from the shared snapshot (no request of its own). */
export function useAgentsCompact(_ctx: GlanceContext): GlanceCompact {
  const { data, failed, stale } = useGlance();
  return useMemo(() => agentsCompact({ data, failed, stale }), [data, failed, stale]);
}
