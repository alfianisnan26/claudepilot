import { useToast } from '@isnanme/ui';
import { useEffect } from 'react';

/** The built app's entry script, which changes with every build. */
const entryOf = (html: string) => /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1] ?? null;

/**
 * Says when a newer build is being served, with Reload. An installed app (iOS especially) keeps
 * running the code it started with while it sits in the background, so it checks when it comes back
 * to the front, and every few minutes while it's open.
 */
export function useAppUpdate() {
  const toast = useToast();
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src') ?? null;
    if (!mine) return;
    let toldAt = 0;
    const check = async () => {
      if (document.visibilityState !== 'visible' || Date.now() - toldAt < 120_000) return;
      try {
        const served = entryOf(await (await fetch('/', { cache: 'no-store' })).text());
        if (!served || served === mine) return;
        toldAt = Date.now();
        toast('A new version is ready', 'success', { label: 'Reload', onClick: () => location.reload() });
      } catch {
        // offline or the server restarting: try again later
      }
    };
    const onVisible = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => void check(), 5 * 60_000);
    void check();
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [toast]);
}
