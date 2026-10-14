import { SETTINGS_API, type AgentEnvStatus, type LockdownStatus, type SettingChange, type SettingsView, type SettingUpdate, type SettingView } from '@portal/contracts';
import { poolRequest } from '@/features/pools/request';

/** The shared settings store (`/api/settings`): the page lists what areas define, a change is audited, the lockdown status is per workspace. */
export const settingsApi = {
  list: () => poolRequest<SettingsView>('GET', SETTINGS_API.list),
  set: (key: string, body: SettingUpdate) => poolRequest<SettingView>('PUT', SETTINGS_API.one(key), body),
  audit: (limit = 50) => poolRequest<SettingChange[]>('GET', `${SETTINGS_API.audit}?limit=${limit}`),
  lockdown: (workspaceId: string) => poolRequest<LockdownStatus>('GET', SETTINGS_API.lockdown(workspaceId)),
  agentEnv: (workspaceId: string) => poolRequest<AgentEnvStatus>('GET', SETTINGS_API.agentEnv(workspaceId)),
};
