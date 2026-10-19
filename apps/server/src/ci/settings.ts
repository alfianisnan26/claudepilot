// CI's portal-wide settings (local-git-ci PRD FR8a, T-486 S2). `ci.upstreamHosts`: the only hosts an upstream may be on. Empty (the
// default): any host whose every address is public, as before. The SSRF guard (resolve, every address public, the pin) holds either way;
// the list only narrows it. Read at each use: a changed list applies to the next set and the next sync.

import { CI_UPSTREAM_HOSTS_SETTING } from '@portal/contracts';
import { defineSetting, defineSettingGroup } from '../settings/registry.js';
import { RUNNER_LOST_MIN } from './service.js';
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

/** T-1637: minutes a runner may not answer before the runs executing on it end failed as `runner_lost`. 0: never. Global, so admin only. */
export const CI_RUNNER_LOST_SETTING = 'ci.runnerLostMin';

defineSetting({
  key: CI_RUNNER_LOST_SETTING,
  type: 'number',
  default: RUNNER_LOST_MIN,
  min: 0,
  max: 1440,
  integer: true,
  scope: 'global',
  group: 'ci',
  order: 20,
  label: 'Runner lost',
  help: 'Minutes a runner may not answer before the runs on it end failed as runner_lost. A run whose runs-on has fallback: workspace runs again in the repository workspace. 0: never.',
});

/** The minutes as the CI service reads them, at each look; the default when the setting is unset or not a number. */
export function runnerLostMinFrom(settings: { get(key: string): unknown } | null | undefined): () => number {
  return () => {
    const v = settings?.get(CI_RUNNER_LOST_SETTING);
    return typeof v === 'number' ? v : RUNNER_LOST_MIN;
  };
}
