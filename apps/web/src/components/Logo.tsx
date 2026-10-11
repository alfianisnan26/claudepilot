import { cn } from '@isnanme/ui';
import { Link } from 'react-router';

export const BRAND_NAME = 'pilot';

/**
 * A heading arrow in pay's mark style (ink tile, primary-ink stroke, a green light) but a symbol, not
 * a letter, so it never reads as pay's "p": the arrow steers toward the pilot light at its tip.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden="true">
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <path
        d="M16 7.6 22.6 23.6 16 19.9 9.4 23.6Z"
        transform="rotate(45 16 16)"
        fill="none"
        className="stroke-primary-ink"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <circle cx="23.6" cy="8.4" r="2.2" fill="#34d399" />
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
