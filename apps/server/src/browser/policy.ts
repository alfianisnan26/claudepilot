import type { BrowserPoolContent } from '@portal/contracts';
import { DOWNLOADS_DIR } from './spec.js';

/**
 * What a browser container is told at creation, as two root-owned files (browser & desktop PRD §13 Chrome
 * baseline): Chromium's managed policy and the supervisor's config. Policy is never passed as flags, and
 * nothing here hides automation (PRD §4): no user-agent, fingerprint or stealth settings.
 */

/** Hosts the browser never opens: cloud metadata, and the cluster's own names (PRD §13 Chrome baseline). */
export const METADATA_HOSTS = ['metadata.google.internal', '169.254.169.254', '169.254.170.2', 'fd00:ec2::254', 'cluster.local'];

/** A pattern the policy accepts: a host, `host:port`, a scheme, or a wildcard of those. No whitespace, no controls. */
export const SITE_PATTERN = /^[A-Za-z0-9*._~:/\-[\]]{1,200}$/;

export function chromePolicy(content: BrowserPoolContent, ctx: { portalHosts: string[] }): Record<string, unknown> {
  const blocked = [...METADATA_HOSTS, ...ctx.portalHosts, ...content.blockedSites];
  const policy: Record<string, unknown> = {
    BrowserSignin: 0,
    SyncDisabled: true,
    PasswordManagerEnabled: false,
    AutofillAddressEnabled: false,
    AutofillCreditCardEnabled: false,
    MetricsReportingEnabled: false,
    BackgroundModeEnabled: false,
    HighEfficiencyModeEnabled: true,
    DefaultBrowserSettingEnabled: false,
    TranslateEnabled: false,
    ExtensionInstallBlocklist: ['*'],
    DownloadDirectory: DOWNLOADS_DIR,
    PromptForDownloadLocation: false,
    // 3 blocks every download; 0 leaves them to Chrome's own judgement.
    DownloadRestrictions: content.downloads ? 0 : 3,
    // Not RestoreOnStartup (PRD §13 would keep session-only cookies across an idle stop): it reopens last time's tabs, and an
    // agent session that picks one of them drives a tab that isn't in front (PRD Q7 stays open).
    URLBlocklist: content.allowlistMode ? ['*', ...blocked] : blocked,
  };
  if (content.allowlistMode) policy.URLAllowlist = ['about:blank', ...content.allowedSites];
  return policy;
}

/** `/etc/cpb/config.json`: read by the init and the supervisor, never by anything in the workspace. */
export function containerConfig(content: BrowserPoolContent, opts: { sandbox: boolean }): Record<string, unknown> {
  const [width, height] = content.display.split('x').map(Number);
  return {
    tier: content.tier,
    display: { width, height },
    profile: content.profile,
    idleMinutes: content.idleMinutes,
    startWithWorkspace: content.start === 'with_workspace',
    sandbox: opts.sandbox,
    liveView: content.tier !== 'headless' && content.liveView,
    takeOver: content.takeOver,
    private: content.privateTakeOvers,
  };
}
