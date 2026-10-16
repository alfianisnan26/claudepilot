// CI's portal-wide settings (local-git-ci PRD FR8a, T-486 S2). `ci.upstreamHosts`: the only hosts an upstream may be on. Empty (the
// default): any host whose every address is public, as before. The SSRF guard (resolve, every address public, the pin) holds either way;
// the list only narrows it. Read at each use: a changed list applies to the next set and the next sync.

import { CI_UPSTREAM_HOSTS_SETTING } from '@portal/contracts';
import { defineSetting, defineSettingGroup } from '../settings/registry.js';
import { hostList } from './upstream.js';

defineSettingGroup('ci', 'CI', 43);

defineSetting({
  key: CI_UPSTREAM_HOSTS_SETTING,
  type: 'string',
  default: '',
  max: 1000,
  scope: 'global',
  group: 'ci',
  order: 10,
  label: 'Upstream hosts',
  help: 'The only hosts a remote may follow an upstream on, separated by commas or spaces, for example github.com, gitea.example.com. Empty: any public host. Private addresses are refused either way.',
});

/** The list as the CI service reads it; undefined when the setting is empty or unset. */
export function upstreamHostsFrom(settings: { get(key: string): unknown } | null | undefined): () => string[] | undefined {
  return () => hostList(settings?.get(CI_UPSTREAM_HOSTS_SETTING));
}
