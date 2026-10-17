import { APP_PORTS_API, type AppPortItem, type AppPortList, type OpenAppPortResult } from '@portal/contracts';
import { ApiError } from '@/lib/api';
import { request } from './api';
import type { AppTarget } from './appAddress';

/** The portal says the feature is off: 404 on either route, or `enabled: false` on the list (no `PORT_PROXY_HOST_SUFFIX`). Not an error. */
export const isAppOff = (e: unknown): boolean => e instanceof ApiError && e.status === 404;

export const appProxy = {
  /** Mints a one-time code and returns the URL on the app host; the frame loads it within 30 seconds, once. */
  open: (workspaceId: string, t: AppTarget) => request<OpenAppPortResult>('POST', APP_PORTS_API.open(workspaceId), { port: t.port, path: t.path }),
  /** The listening ports; `null` when the feature is off. */
  ports: async (workspaceId: string): Promise<AppPortItem[] | null> => {
    try {
      const list = await request<AppPortList>('GET', APP_PORTS_API.list(workspaceId));
      return list.enabled ? list.ports : null;
    } catch (e) {
      if (isAppOff(e)) return null;
      throw e;
    }
  },
};
