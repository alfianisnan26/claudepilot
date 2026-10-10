import { cn } from '@isnanme/ui';
import type { ReactNode } from 'react';

/** pay's surface card: 24 px corners, hairline border, no shadow. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-[24px] border border-line bg-surface', className)}>{children}</div>;
}
