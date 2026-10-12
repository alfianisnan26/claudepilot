import { Button, LoadError } from '@isnanme/ui';
import type { ReactNode } from 'react';

// The states every glance full form shares (QA standards A4): rows shaped like the list while the first reading is on its way, a failure
// with its message and another try, a refusal, an empty line, and the note that what is shown may be old.

/** Rows in the list's own shape, not a spinner. */
export function GlanceSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading" className="flex flex-col gap-2 py-1">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex min-h-11 items-center gap-3">
          <span className="skeleton size-2 shrink-0 rounded-full" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="skeleton h-3.5 w-3/5 rounded-full" />
            <span className="skeleton h-3 w-2/5 rounded-full" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A reading that could not be loaded: what happened and another try. A refusal (403) is said as one and not retried. */
export function GlanceFailed({ reload, denied, message = 'Could not load.' }: { reload: () => Promise<void>; denied?: boolean; message?: string }) {
  if (denied)
    return (
      <p role="alert" className="py-3 text-center text-sm text-muted">
        Not allowed.
      </p>
    );
  return <LoadError onRetry={reload} message={message} className="flex flex-col items-center gap-2 py-3 text-center" />;
}

/** One short line, and the one thing to do about it when there is something. */
export function GlanceLine({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-3 text-center">
      <p className="text-sm text-muted">{children}</p>
      {action}
    </div>
  );
}

/** What is shown may be old (the live socket is down, or the last refresh failed): said politely, with a way to ask again. */
export function StaleNote({ reload }: { reload: () => Promise<void> }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-between gap-2 pb-1 text-xs text-muted">
      <span>May be out of date.</span>
      <Button size="sm" variant="ghost" onClick={reload}>
        Refresh
      </Button>
    </div>
  );
}
