import { useToast } from '@isnanme/ui';
import { useCallback, useEffect, useState } from 'react';
import { errorText } from '@/lib/api';
import { notifyApi } from './api';

/** "Notify when done" for one session (the session ⋯ menu): read from and written to the portal, which keeps it per person. */
export function useNotifyWhenDone(sessionId: string | undefined): { done: boolean; toggle: () => void } {
  const toast = useToast();
  const [done, setDone] = useState(false);
  useEffect(() => {
    setDone(false);
    if (!sessionId) return;
    let current = true;
    notifyApi.sessionDone(sessionId).then(
      (r) => current && setDone(r.done),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [sessionId]);
  const toggle = useCallback(() => {
    if (!sessionId) return;
    const next = !done;
    notifyApi.setSessionDone(sessionId, next).then(
      () => {
        setDone(next);
        toast(next ? 'You will hear when it is done' : 'Not notifying for this agent');
      },
      (e: unknown) => toast(errorText(e, 'Could not change it.'), 'error'),
    );
  }, [sessionId, done, toast]);
  return { done, toggle };
}
