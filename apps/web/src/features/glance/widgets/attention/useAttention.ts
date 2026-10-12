import { useMemo } from 'react';
import type { GlanceCompact, GlanceContext } from '../../types';
import { useGlance } from '../shared/store';
import { attentionCompact } from './model';

/** The Needs-attention chip and the app badge's count, from the shared snapshot (no request of its own). */
export function useAttentionCompact(_ctx: GlanceContext): GlanceCompact {
  const { data, failed, stale } = useGlance();
  return useMemo(() => attentionCompact({ data, failed, stale }), [data, failed, stale]);
}
