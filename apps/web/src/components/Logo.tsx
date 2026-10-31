import { cn } from '@isnanme/ui';
import { Link } from 'react-router';
import { LogoMark } from './LogoMark';

export { LogoMark };

export const BRAND_NAME = 'pilot';

export function Logo({ to = '/', className, label = true }: { to?: string; className?: string; label?: boolean }) {
  return (
    <Link
      to={to}
      aria-label={BRAND_NAME}
      // The padding makes a 44 px tap target; the negative margin keeps the layout as it was.
      className={cn('-my-2 inline-flex items-center gap-2 rounded-lg py-2 font-extrabold tracking-tight', className)}
    >
      <LogoMark />
      {label && <span className="text-[17px]">{BRAND_NAME}</span>}
    </Link>
  );
}
