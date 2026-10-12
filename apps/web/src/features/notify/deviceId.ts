import { NOTIFY_API } from '@portal/contracts';

/** The destination id this browser's push registration has on the portal, kept so presence and sign-out can name it. */
const KEY = 'claudepilot.notify.device';

export const thisDeviceId = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export const rememberDevice = (id: string | null) => {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    // private window: presence just reports no device
  }
};

async function currentSubscription(): Promise<PushSubscription | null> {
  try {
    if (!('serviceWorker' in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Sign-out (PRD 11.4): this browser's push registration goes first, so the next push to it cannot arrive on a signed-out phone, and a
 * person who hands the phone on does not hear the first person's events. Never throws and never blocks a sign-out for long.
 */
export async function removeThisBrowserRegistration(): Promise<void> {
  const id = thisDeviceId();
  const done = (async () => {
    if (id) {
      try {
        await fetch(NOTIFY_API.destination(id), { method: 'DELETE', credentials: 'same-origin' });
      } catch {
        // the portal is unreachable: the browser side still goes
      }
    }
    try {
      await (await currentSubscription())?.unsubscribe();
    } catch {
      // nothing to unsubscribe
    }
    rememberDevice(null);
  })();
  await Promise.race([done, new Promise<void>((r) => setTimeout(r, 4000))]);
}

export { currentSubscription };
