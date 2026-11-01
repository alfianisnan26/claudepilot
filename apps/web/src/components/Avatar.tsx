import { cn } from '@isnanme/ui';
import { useState } from 'react';

/** A person's round picture, or their initials when there is none (or it fails to load). Decorative: the name is always written beside it. */
export function Avatar({ src, initials, className }: { src: string | null; initials: string; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const show = src && broken !== src;
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/15 font-bold text-ink ring-1 ring-line select-none', className)}
    >
      {show ? <img src={src} alt="" className="size-full object-cover" onError={() => setBroken(src)} draggable={false} /> : <span className="leading-none">{initials}</span>}
    </span>
  );
}
