import { cn } from '@isnanme/ui';
import type { Dot as DotKind } from './view';

const COLOR: Record<DotKind, string> = {
  connected: 'bg-accent',
  'scanned-up': 'bg-accent',
  partial: 'bg-amber-500',
  offline: 'bg-danger',
  'scanned-down': 'bg-danger',
  pending: 'bg-muted',
};
const NAME: Record<DotKind, string> = {
  connected: 'Connected',
  'scanned-up': 'Reachable',
  partial: 'Partly connected',
  offline: 'Offline',
  'scanned-down': 'Unreachable',
  pending: 'Waiting',
};

/** The status dot. Colour alone is not the signal: it carries its name for screen readers, and the row's line says the same in words. */
export function Dot({ kind, className }: { kind: DotKind; className?: string }) {
  return <span role="img" aria-label={NAME[kind]} className={cn('inline-block size-2.5 shrink-0 rounded-full', COLOR[kind], className)} />;
}
