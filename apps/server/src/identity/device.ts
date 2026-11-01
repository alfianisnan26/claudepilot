// The device a web sign-in came from, for the person's Profile ("Safari on iPhone"). Only this short label is kept (web_sessions.device,
// migration 407), never the raw User-Agent header: it is enough to recognise a browser and says nothing more about it.

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bCriOS\/|\bChrome\/|\bChromium\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bMacintosh\b|\bMac OS X\b/, 'Mac'],
  [/\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b/, 'Linux'],
];

/** "Safari on iPhone", "Chrome on Mac", "Firefox", "iPhone", or null for nothing recognisable (curl, a script, no header). */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  const ua = (userAgent ?? '').slice(0, 512);
  if (!ua) return null;
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null;
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system;
}
