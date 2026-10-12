import { cn } from '@isnanme/ui';
import { useNotifyOverview } from './store';

/** The unread count on the nav's Bell: nothing at zero, 99+ when large. `inline` is the phone's More list; otherwise it sits on the icon. */
export function NavBadge({ inline = false }: { inline?: boolean }) {
  const { overview } = useNotifyOverview();
  const n = overview?.unread ?? 0;
  if (n <= 0) return null;
  const text = n > 99 ? '99+' : String(n);
  return (
    <span
      role="img"
      aria-label={`${n} unread`}
      className={cn(
        'pointer-events-none inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-bold text-primary-ink tabular-nums',
        inline ? 'ml-auto' : 'absolute top-1.5 left-1/2 lg:static lg:ml-auto',
      )}
    >
      {text}
    </span>
  );
}
