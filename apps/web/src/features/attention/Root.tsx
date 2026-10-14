import { cn } from '@isnanme/ui';
import { useEffect } from 'react';
import { forgetBadgeWidget, reportBadgeCount } from '@/features/glance/badge';
import { badgeText } from './model';
import { useLive, useLiveConnected } from '@/lib/live';
import { loadAttention, useAttention } from './store';

const BADGE_ID = 'needs-you';

/** The live topic, and a slow poll only while the socket is down. */
function useAttentionFeed(): void {
  useLive('attention', () => void loadAttention());
  const connected = useLiveConnected();
  useEffect(() => {
    if (connected) return;
    const t = window.setInterval(() => void loadAttention(), 60_000);
    return () => window.clearInterval(t);
  }, [connected]);
}

/**
 * Mounted once in the app frame: keeps the Needs you list fresh (the live topic) and adds to the app icon's badge what the glance's
 * Needs attention does not already count. The glance counts every open tool request, the deploys waiting and the tickets assigned to a
 * person (a superset of the approval tickets and the stuck approvals here), so only the MCP and skill versions waiting are added: the
 * icon counts each thing once.
 */
export function AttentionRoot() {
  useAttentionFeed();
  const { list, failed } = useAttention();
  const extra = list ? (list.counts.mcp_version ?? 0) + (list.counts.skill_version ?? 0) : failed ? 0 : null;
  useEffect(() => reportBadgeCount(BADGE_ID, extra), [extra]);
  useEffect(() => () => forgetBadgeWidget(BADGE_ID), []);
  return null;
}

/** The number on the nav's Needs you: nothing at zero, 99+ when large. `inline` is the phone's More list; otherwise it sits on the icon. */
export function AttentionBadge({ inline = false, className }: { inline?: boolean; className?: string }) {
  const { list } = useAttention();
  const text = badgeText(list?.total);
  if (!text) return null;
  return (
    <span
      role="img"
      aria-label={`${list!.total} need you`}
      data-attention-badge=""
      className={cn(
        'pointer-events-none inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] leading-none font-bold text-white tabular-nums',
        inline ? 'ml-auto' : 'absolute top-1.5 left-1/2 lg:static lg:ml-auto',
        className,
      )}
    >
      {text}
    </span>
  );
}
