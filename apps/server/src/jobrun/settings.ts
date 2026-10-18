// The job-run Mac door's portal-wide settings (T-1083 S1b, docs/prd/local-git-ci.md §25), an admin's, group "CI". Both are read at each call.
// `jobrun.macWorkspace`: the workspace whose Docker runs Mac Jobs; empty (the default) means no Mac, and every Job runs in the cluster.
// `jobrun.macClients`: the workspaces whose sessions may call the door; empty (the default) means none, so the door is closed until an admin
// names both.

import { JOBRUN_MAC_CLIENTS_SETTING, JOBRUN_MAC_WORKSPACE_SETTING } from '@portal/contracts';
import { defineSetting, defineSettingGroup } from '../settings/registry.js';
import { clientList } from './authz.js';

defineSettingGroup('ci', 'CI', 43);

defineSetting({
  key: JOBRUN_MAC_WORKSPACE_SETTING,
  type: 'string',
  default: '',
  max: 130,
  scope: 'global',
  group: 'ci',
  order: 20,
  label: 'Mac runner',
  help: 'The workspace whose Docker runs job-run Jobs on the owner’s Mac, as target/name. Empty: no Mac; every Job runs in the cluster. The gate, image builds and Jobs with --big, --pool-env or --image always run in the cluster.',
});

defineSetting({
  key: JOBRUN_MAC_CLIENTS_SETTING,
  type: 'string',
  default: '',
  max: 1000,
  scope: 'global',
  group: 'ci',
  order: 30,
  label: 'Mac clients',
  help: 'The workspaces whose sessions may send Jobs to the Mac, as target/name, separated by commas or spaces. Empty: none. A session proves itself with its own portal token.',
});

type Reader = { get(key: string): unknown } | null | undefined;

/** The Mac workspace as the door reads it; '' when unset. */
export const macWorkspaceFrom = (settings: Reader) => (): string => {
  const v = settings?.get(JOBRUN_MAC_WORKSPACE_SETTING);
  return typeof v === 'string' ? v.trim() : '';
};

/** The client workspaces as the door reads them; [] when unset. */
export const macClientsFrom = (settings: Reader) => (): string[] => clientList(settings?.get(JOBRUN_MAC_CLIENTS_SETTING));
