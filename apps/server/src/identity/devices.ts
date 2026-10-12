// A sign-in's device label from its User-Agent (identity PRD FR30): `Chrome on Linux`, text the person recognises, from a small table and no
// library. The User-Agent is untrusted text: only the table's words ever reach the label.

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\bBrave\b/, 'Brave'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bCriOS\//, 'Chrome'],
  [/\bChrome\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
  [/\bcurl\//, 'curl'],
  [/\bwget\b/i, 'wget'],
  [/\bnode\b|\bundici\b/i, 'Node'],
  [/\bPython|python-requests|aiohttp/i, 'Python'],
  [/\bPostman/i, 'Postman'],
  [/\bVSCode|\bvscode\b/i, 'VS Code'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b|\biPod\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
];

/** `Chrome on Linux`, `Safari on iPhone`, `curl`, or `Unknown device`. At most 40 characters, never text from the header itself. */
export function deviceLabel(userAgent: string | undefined | null): string {
  const ua = (userAgent ?? '').slice(0, 512);
  if (!ua.trim()) return 'Unknown device';
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  // An iPad asks for the desktop site as "Macintosh" with touch; Safari on iOS is recognised by the system when Chrome et al. are absent.
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? (system ? `Browser on ${system}` : 'Unknown device');
}
