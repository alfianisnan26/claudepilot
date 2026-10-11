import { cn } from '@isnanme/ui';
import type { ReactNode } from 'react';

/** One line of a settings list: an icon, a label with a short status under it, and a control at the end. */
export function SettingRow({
  icon,
  label,
  sub,
  trailing,
  tone = 'neutral',
}: {
  icon: ReactNode;
  /** The name, and anything that sits beside it (a badge, an ⓘ). */
  label: ReactNode;
  sub?: ReactNode;
  trailing?: ReactNode;
  tone?: 'neutral' | 'accent' | 'warning' | 'danger';
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          tone === 'accent' && 'bg-accent-soft text-accent',
          tone === 'warning' && 'bg-gold-soft text-gold',
          tone === 'danger' && 'bg-danger-soft text-danger',
          tone === 'neutral' && 'bg-surface-2 text-ink-soft',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 font-semibold">{label}</div>
        {sub && <p className="truncate text-[13px] text-muted">{sub}</p>}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
    </li>
  );
}
