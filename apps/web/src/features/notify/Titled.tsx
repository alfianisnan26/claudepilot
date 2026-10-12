import type { ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';

/** A section title with its explanation behind an ⓘ (the text diet: words only where a decision depends on them). */
export function Titled({ title, children }: { title: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {title}
      <InfoTip label={`About ${title}`}>{children}</InfoTip>
    </span>
  );
}
