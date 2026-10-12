import { cn } from '@isnanme/ui';
import { useId, type ReactNode } from 'react';

/** A real checkbox: the library has none, and a review ticks items one by one (Skillset §11.2). */
export function Check({
  checked,
  onChange,
  children,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn('flex min-h-11 cursor-pointer items-start gap-3 py-1.5 text-[14px] text-ink', disabled && 'cursor-not-allowed opacity-60', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 shrink-0 cursor-pointer rounded-md border-line-strong accent-[var(--color-accent)]"
      />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

/** A small bar: how much of a budget is used. Over 75% it warns, over 100% it turns red (Skillset §12). */
export function Meter({ label, value, fraction }: { label: string; value: string; fraction: number }) {
  const pct = Math.min(100, Math.max(2, fraction * 100));
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="text-ink-soft">{label}</span>
        <span className="truncate font-medium tabular-nums text-ink-soft">{value}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <div className={cn('h-full rounded-full transition-[width] duration-500', fraction > 1 ? 'bg-danger' : fraction > 0.75 ? 'bg-flame' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
