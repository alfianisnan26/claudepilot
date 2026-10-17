import { useState, type ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';

/** What a row of the Glance settings looks like: the label with an ⓘ, a control at the end (the Settings page's own row). */
export function Row({ label, about, children }: { label: string; about?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-2">
      <span className="flex min-w-0 flex-1 items-center gap-1 font-semibold">
        <span className="line-clamp-2 break-words">{label}</span>
        {about && <InfoTip label={`About ${label}`}>{about}</InfoTip>}
      </span>
      {children}
    </div>
  );
}

/** A whole percent from `min` to `max`; a value outside it (or not a number) goes back to what it was. Saved on blur or Enter. */
export function Percent({ label, value, min, max, onCommit }: { label: string; value: number; min: number; max: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const n = Number(text);
    if (text.trim() !== '' && Number.isInteger(n) && n >= min && n <= max) {
      if (n !== value) onCommit(n);
    } else setText(String(value));
  };
  return (
    <span className="flex items-center gap-1.5">
      <input
        aria-label={label}
        value={text}
        inputMode="numeric"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className="h-10 w-20 rounded-xl border border-line bg-surface px-3 text-right text-base text-ink outline-hidden hover:border-line-strong focus:border-ink/40 focus:ring-4 focus:ring-[var(--ring)]"
      />
      <span className="text-muted">%</span>
    </span>
  );
}
