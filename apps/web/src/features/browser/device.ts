/**
 * This browser's identity for the live view (browser PRD §12.3): control is held by a device, not a socket, so
 * switching apps for a password or a code keeps it. A random id in this device's own storage, and a name for people.
 */
const KEY = 'pilot.browser.device';

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The device's id; kept in storage when storage works (private mode: one per page load). */
export function deviceId(): string {
  try {
    const have = localStorage.getItem(KEY);
    if (have && /^[A-Za-z0-9_-]{8,64}$/.test(have)) return have;
    const id = newId();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return (window as { __cpbDevice?: string }).__cpbDevice ?? ((window as { __cpbDevice?: string }).__cpbDevice = newId());
  }
}

/** "iPhone", "Chrome on Mac": what the other devices call this one. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'a device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) || /CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return ['iPhone', 'iPad', 'Android'].includes(os) || !browser ? os : `${browser} on ${os}`;
}
