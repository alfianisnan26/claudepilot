import type { ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';

/** A list of at most `max` items, then a "+N" that opens the rest in a tap-and-keyboard ⓘ (stable row height, deterministic order). */
export function Bounded({ items, max = 3, label }: { items: string[]; max?: number; label: string }) {
  const shown = items.slice(0, max);
  const rest = items.slice(max);
  return (
    <>
      {shown.join(', ')}
      {rest.length > 0 && (
        <>
          {' '}
          <InfoTip label={label} text={`+${rest.length}`}>
            {rest.join(', ')}
          </InfoTip>
        </>
      )}
    </>
  );
}

/** One line of dynamic text with the full text in `title` and for keyboard users (focusable only when it can be cut). */
export function Clamp({ children, text, className = '' }: { children?: ReactNode; text: string; className?: string }) {
  return (
    <span title={text} tabIndex={text.length > 28 ? 0 : undefined} className={`block min-w-0 truncate [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-ink ${className}`}>
      {children ?? text}
    </span>
  );
}
