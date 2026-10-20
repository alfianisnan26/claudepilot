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

/** The Chrome Web Store's update URL (every store extension carries it) and its pages: shut when the headers extension opens the default. */
export const WEB_STORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx';
export const WEB_STORE_HOSTS = ['chromewebstore.google.com', 'chrome.google.com/webstore'];
/**
 * Local files, blocked while the pool has headers: the extension's ruleset in `/dev/shm` holds the header values, and a path prefix can be
 * walked around (`file:///dev//shm/...`, `file:///proc/self/root/dev/shm/...`; T-1660 re-review), so every `file://` URL is blocked.
 */
export const EXT_FILES = 'file://*';

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
  // The headers extension (PRD §24) loads from the command line, and Chromium refuses any unpacked extension while the default is
  // blocked (`ExtensionInstallBlocklist: ["*"]`, whatever the allowlist says): a headed browser then holds a modal "Error Loading
  // Extension" dialog before CDP listens (T-1660). So with headers the default stays open and every other way in is shut: the Web
  // Store by its update URL, external and non-extension types, developer mode, the extensions page; `--disable-extensions-except`
  // keeps everything else off (and `--disable-extensions` when the init built none for a start), and no page may open the extension's
  // files, which hold the values: neither as `chrome-extension://` nor as `file:///dev/shm/cpb-ext/rules.json`.
  if ((content.headers ?? []).length > 0) {
    delete policy.ExtensionInstallBlocklist;
    policy.ExtensionSettings = { [`update_url:${WEB_STORE_UPDATE_URL}`]: { installation_mode: 'blocked' } };
    policy.ExtensionAllowedTypes = ['extension'];
    policy.BlockExternalExtensions = true;
    policy.ExtensionDeveloperModeSettings = 1;
    policy.URLBlocklist = [...(policy.URLBlocklist as string[]), 'chrome-extension://*', EXT_FILES, 'chrome://extensions', ...WEB_STORE_HOSTS];
  }
  if (content.allowlistMode) policy.URLAllowlist = ['about:blank', ...content.allowedSites];
  return policy;
}

/** `/etc/cpb/config.json`: read by the init and the supervisor, never by anything in the workspace. */
/**
 * `sandbox`: on or off as the target's probe found (Docker), or `auto` (Kubernetes): the container's init tries it before Chrome's first
 * start and runs without it only when the pool doesn't require it.
 */
export function containerConfig(content: BrowserPoolContent, opts: { sandbox: boolean | 'auto' }): Record<string, unknown> {
  const [width, height] = content.display.split('x').map(Number);
  return {
    tier: content.tier,
    display: { width, height },
    profile: content.profile,
    idleMinutes: content.idleMinutes,
    startWithWorkspace: content.start === 'with_workspace',
    sandbox: opts.sandbox,
    ...(opts.sandbox === 'auto' ? { requireSandbox: content.requireSandbox } : {}),
    liveView: content.tier !== 'headless' && content.liveView,
    takeOver: content.takeOver,
    private: content.privateTakeOvers,
  };
}
