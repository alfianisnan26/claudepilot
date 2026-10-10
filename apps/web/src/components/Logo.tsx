import { cn } from '@isnanme/ui';
import { Link } from 'react-router';

export const BRAND_NAME = 'claude pilot';

/** A "c" in pay's mark style: ink tile, primary-ink stroke, a green pilot light in its opening. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden="true">
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <path
        d="M21.4 11.6a6.6 6.6 0 1 0 0 8.8"
        fill="none"
        className="stroke-primary-ink"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="23" cy="16" r="2.2" fill="#34d399" />
    </svg>
  );
}

export function Logo({ to = '/', className, label = true }: { to?: string; className?: string; label?: boolean }) {
  return (
    <Link
      to={to}
      aria-label={BRAND_NAME}
      className={cn('inline-flex items-center gap-2 rounded-lg font-extrabold tracking-tight', className)}
    >
      <LogoMark />
      {label && <span className="text-[17px]">{BRAND_NAME}</span>}
    </Link>
  );
}
