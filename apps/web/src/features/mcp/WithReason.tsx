import type { ReactNode } from 'react';

/**
 * A disabled control with its reason: the kit's disabled buttons ignore the pointer, so a `title` on the button itself would
 * never show. The reason sits on a wrapper, where hovering works; on a phone the page also says it behind an ⓘ.
 */
export function WithReason({ reason, children }: { reason?: string | null; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <span title={reason} className="inline-flex">
      {children}
    </span>
  );
}
