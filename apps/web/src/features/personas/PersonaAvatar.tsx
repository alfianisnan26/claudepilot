import { cn } from '@isnanme/ui';
import { useState } from 'react';

const SIZES = { xs: 'size-5 text-[9px]', sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-12 text-base', xl: 'size-24 text-3xl' } as const;

/** Up to two initials: "Code reviewer" is CR, "Reviewer" is R, "!!!" is a question mark. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
  return letters.map((w) => [...(w ?? '')][0] ?? '').join('').toUpperCase() || '?';
}

/** A steady colour for a name: the same persona is the same colour everywhere, light and dark. */
function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}

/**
 * A persona on screen (interface I11): its avatar, or initials on a colour made from its name when it has none,
 * and its name when `showName` is on. The one component sessions, lists and tickets use, so a persona looks the
 * same everywhere. The image is the portal's own re-encoded PNG; if it fails to load the initials show instead.
 */
export function PersonaAvatar({
  name,
  avatar,
  size = 'md',
  showName = false,
  className,
}: {
  name: string;
  /** The image address (`PersonaIdentity.avatar`), or none. */
  avatar?: string | null;
  size?: keyof typeof SIZES;
  /** The name beside the circle. Without it the circle carries the name as its accessible label. */
  showName?: boolean;
  className?: string;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const image = avatar && broken !== avatar ? avatar : null;
  const circle = image ? (
    <img src={image} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(avatar ?? null)} className={cn('shrink-0 rounded-full bg-surface-2 object-cover', SIZES[size].split(' ')[0])} />
  ) : (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none', SIZES[size])}
      style={{ backgroundColor: `hsl(${hueOf(name)} 42% 40%)` }}
    >
      {initialsOf(name)}
    </span>
  );
  if (showName)
    return (
      <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
        {circle}
        <span className="min-w-0 truncate">{name}</span>
      </span>
    );
  return (
    <span role="img" aria-label={name} title={name} className={cn('inline-flex shrink-0', className)}>
      {circle}
    </span>
  );
}
