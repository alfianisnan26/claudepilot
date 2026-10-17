import { SETTINGS_API, type AgentEnvStatus, type CursorPage, type LockdownStatus, type SettingChange, type SettingsView, type SettingUpdate, type SettingView } from '@portal/contracts';
import { poolRequest } from '@/features/pools/request';

/** The shared settings store (`/api/settings`): the page lists what areas define, a change is audited, the lockdown status is per workspace. */
export const settingsApi = {
  list: () => poolRequest<SettingsView>('GET', SETTINGS_API.list),
  set: (key: string, body: SettingUpdate) => poolRequest<SettingView>('PUT', SETTINGS_API.one(key), body),
  /** One page of the trail, newest first (D-58): `next` goes back as `cursor`. */
  audit: (opts: { cursor?: string | null; limit?: number } = {}) => {
    const qs = new URLSearchParams({ limit: String(opts.limit ?? 25) });
    if (opts.cursor) qs.set('cursor', opts.cursor);
    return poolRequest<CursorPage<SettingChange>>('GET', `${SETTINGS_API.audit}?${qs}`);
  },
  lockdown: (workspaceId: string) => poolRequest<LockdownStatus>('GET', SETTINGS_API.lockdown(workspaceId)),
  agentEnv: (workspaceId: string) => poolRequest<AgentEnvStatus>('GET', SETTINGS_API.agentEnv(workspaceId)),
};
