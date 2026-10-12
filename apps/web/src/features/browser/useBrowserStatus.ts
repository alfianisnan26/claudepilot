import type { BrowserStatus } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { browserApi } from './api';

/** The browser's status, fresh every couple of seconds while the page is in front, and whenever pools change. */
export function useBrowserStatus(workspaceId: string, device: string) {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await browserApi.status(workspaceId, device));
      setError(null);
    } catch (e) {
      setError(errorText(e, 'Could not load the browser.'));
    }
  }, [workspaceId, device]);

  useEffect(() => {
    void load();
    const tick = () => document.visibilityState === 'visible' && void load();
    const timer = setInterval(tick, 2000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);
  useLive('pools', () => void load());

  return { status, error, reload: load };
}
