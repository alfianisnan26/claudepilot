// Shared by the browser container's init, supervisor and tools. Dependency-free Node (browser & desktop PRD
// §10.1, §13): the config is root-owned, so nothing that can reach a renderer can change how Chrome starts.
import { readFileSync } from 'node:fs';

export const log = (...args) => console.log(new Date().toISOString().slice(11, 23), ...args);

/** Fixed users (PRD §13 Users): Chrome is `node`, everything else is `cpb`. */
export const UID_CHROME = 1000;
export const UID_CPB = 1001;

export const SUPERVISOR_PORT = 9220;
export const CDP_PORT = 9222;
/** The supervisor's API contract with the gate: bumped when `/status` or `/wake` change shape. */
export const PROTOCOL = 1;

const TIERS = ['headless', 'browser', 'desktop'];
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
const text = (v, d) => (typeof v === 'string' && v ? v : d);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x && x.length < 200).slice(0, 200) : []);

/** The container's config (`/etc/cpb/config.json`, written by the portal), with every value checked and defaulted. */
export function loadConfig(path = process.env.CPB_CONFIG || '/etc/cpb/config.json') {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    log('config unreadable, using defaults:', e.message);
  }
  if (!raw || typeof raw !== 'object') raw = {};
  const tier = TIERS.includes(raw.tier) ? raw.tier : 'browser';
  return {
    tier,
    display: { width: clamp(raw.display?.width, 640, 3840, 1280), height: clamp(raw.display?.height, 480, 2160, 800) },
    profile: raw.profile === 'fresh' ? 'fresh' : 'persistent',
    profileDir: text(raw.profileDir, '/data/profile'),
    downloadsDir: text(raw.downloadsDir, '/home/node/Downloads'),
    idleMinutes: clamp(raw.idleMinutes, 0, 24 * 60, 30),
    startWithWorkspace: raw.startWithWorkspace === true,
    sandbox: raw.sandbox !== false,
    // `auto` (Kubernetes, PRD §13 Chrome sandbox): the init tries Chromium's sandbox once before the first start and falls back to
    // running without it, unless the pool requires it.
    sandboxAuto: raw.sandbox === 'auto',
    requireSandbox: raw.requireSandbox === true,
    liveView: raw.liveView !== false,
    takeOver: raw.takeOver !== false,
    private: raw.private === true,
    chromeFlags: list(raw.chromeFlags),
    memoryGuard: raw.memoryGuard !== false,
  };
}

/**
 * Chromium's command line (PRD §13 Chrome baseline): isnan's flags, plus what a person-visible browser needs.
 * Policy (sign-in off, no sync, no extensions) lives in the managed policy file, never in flags. Nothing here
 * hides automation: no stealth, user-agent or fingerprint flags (PRD §4).
 */
export function chromeArgs(cfg, { headless, profileDir, cdpPort = CDP_PORT, extensionDir = null }) {
  const { width, height } = cfg.display;
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-breakpad',
    '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--enable-unsafe-swiftshader',
    // Playwright's own defaults for a browser it drives (chromiumSwitches): a tab that isn't in front, or a window
    // the virtual display never "exposes", must keep rendering, or clicks wait forever for a frame. And without
    // the back/forward cache, `goForward` waits for a load event a restored page never fires.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
    '--disable-back-forward-cache',
    '--force-device-scale-factor=1',
    '--lang=en-US',
    `--window-size=${width},${height}`,
    '--window-position=0,0',
  ];
  if (headless) args.push('--headless=new');
  else args.push('--start-maximized');
  if (!cfg.sandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');
  // The headers extension (PRD §24), built by the init for this start; nothing else may load.
  // Newer Chrome builds ignore --load-extension unless this feature is switched off; a second --disable-features would replace the first.
  if (extensionDir) {
    const i = args.findIndex((a) => a.startsWith('--disable-features='));
    args[i] = `${args[i]},DisableLoadExtensionCommandLineSwitch`;
    args.push(`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`);
  } else {
    // No extension built for this start (no headers, or the file not delivered yet, unreadable or empty): with headers the policy no
    // longer blocks extensions by default, so the command line does, and one planted in the persistent profile can't load (T-1660).
    args.push('--disable-extensions');
  }
  // A pool's own flags never touch the debugging port, the profile, the sandbox or which extensions load.
  const ownFlag = /remote-debugging|remote-allow-origins|user-data-dir|no-sandbox|disable-web-security|load-extension|load-component-extension|disable-extensions|extensions-on-chrome-urls|DisableLoadExtensionCommandLineSwitch|^--disable-features=/i;
  args.push(...cfg.chromeFlags.filter((f) => /^--[a-z0-9-]+(=[^\s]*)?$/i.test(f) && !ownFlag.test(f)));
  // Last, so nothing above can turn it into a different first page.
  args.push('about:blank');
  return args;
}

/** A line-limited relay for a child's output: the first `burst` lines each minute, then a count. */
export function limitedRelay(prefix, burst = 200) {
  let windowStart = Date.now();
  let seen = 0;
  let dropped = 0;
  return (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      if (Date.now() - windowStart > 60_000) {
        if (dropped) log(`${prefix} … ${dropped} more lines`);
        windowStart = Date.now();
        seen = 0;
        dropped = 0;
      }
      if (++seen <= burst) log(`${prefix} ${line.slice(0, 400)}`);
      else dropped++;
    }
  };
}
