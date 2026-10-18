import { APP_PORTS_API, type AppPortItem, type AppPortList, type OpenAppPortResult } from '@portal/contracts';
import { request } from './api';
import type { AppTarget } from './appAddress';
import { isAppOff } from './appOpen';

/** The names given to a workspace's ports on this device (owner, 2026-10-18: `8765-tradingbot-isnan-pod…`). */
const NAMES_KEY = (workspaceId: string) => `cp.appNames.${workspaceId}`;
export function appNames(workspaceId: string): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(NAMES_KEY(workspaceId)) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}
export function setAppName(workspaceId: string, port: number, name: string): void {
  try {
    const all = appNames(workspaceId);
    if (name.trim()) all[String(port)] = name.trim().slice(0, 40);
    else delete all[String(port)];
    localStorage.setItem(NAMES_KEY(workspaceId), JSON.stringify(all));
  } catch {
    // storage unavailable: the name lasts this page only (the host goes back to <port>-<workspace>)
  }
}

export const appProxy = {
  /** Mints a one-time code and returns the URL on the app host; the frame loads it within 30 seconds, once. The port's name goes in the host. */
  open: (workspaceId: string, t: AppTarget) => {
    const name = appNames(workspaceId)[String(t.port)];
    return request<OpenAppPortResult>('POST', APP_PORTS_API.open(workspaceId), { port: t.port, path: t.path, ...(name ? { name } : {}) });
  },
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
