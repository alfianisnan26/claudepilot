import { Button, EmptyState } from '@isnanme/ui';
import { WifiOff } from 'lucide-react';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';

/** How long to wait between tries while the server can't be reached. */
const RETRY_MS = 4000;

/**
 * Shown instead of the sign-in page when the first check of the session gets no answer (a restart, a lost
 * connection): the sign-in form would suggest the session ended, and signing in would fail anyway. Retries by itself.
 */
export function Unreachable() {
  const { refresh } = useAuth();
  useEffect(() => {
    const timer = setInterval(() => void refresh(), RETRY_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  return (
    <div role="status" className="mx-auto flex min-h-dvh max-w-lg items-center px-4 py-10">
      <EmptyState
        className="w-full"
        icon={<WifiOff className="size-5" />}
        title="Can’t reach pilot"
        action={
          <Button variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        }
      >
        Check your connection or whether the server is running. This page tries again by itself.
      </EmptyState>
    </div>
  );
}
