/**
 * App ports (T-948, docs/prd/app-ports.md): a web app listening on loopback inside a workspace (`127.0.0.1:<port>`) opens in the browser
 * through the portal, as plain HTTP and WebSocket (not the remote browser's streamed screen).
 *
 * Subdomain mode: each workspace and port is its own host, `app-<name>-<port>.<suffix>` (one DNS label), so the app's scripts never run on the
 * portal's origin and never see the portal's cookie. The suffix is the portal's `PORT_PROXY_HOST_SUFFIX`; unset, the feature is off.
 *
 * The flow: the portal page calls OPEN (owner session, `operate` on the workspace, audited `workspace.port.open`) and gets a URL on the app host
 * carrying a one-time code (30 s, single use). That host swaps the code for its own host-only cookie and redirects to `next`. The app host may be
 * framed by the portal only (CSP `frame-ancestors <portal origin>`), so the Browser page can show it in an iframe.
 */

/** The lowest and highest port that may be opened. The portal's own and agent ports are refused too (the server knows them). */
export const APP_PORT_MIN = 1024;
export const APP_PORT_MAX = 65535;

/** On the app host: swaps `?code=` for the host's cookie, then redirects to `?next=` (a path on that host; `/` when absent). */
export const APP_PORT_AUTH_PATH = '/__pilot/auth';

/** A DNS label: lowercase letters, digits and dashes, no dash at either end, at most 63 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The host label of a workspace name: the name lowercased. Null when it can't be one (a `.` or `_` in it, or the label grows past 63). */
export function appPortLabel(name: string, port: number): string | null {
  const label = `app-${name.toLowerCase()}-${port}`;
  return LABEL.test(label) && Number.isInteger(port) && port >= APP_PORT_MIN && port <= APP_PORT_MAX ? label : null;
}

/** `app-<name>-<port>.<suffix>`; null when the name can't be a host label or the port is out of range. */
export function appPortHost(name: string, port: number, suffix: string): string | null {
  const label = appPortLabel(name, port);
  return label ? `${label}.${suffix.toLowerCase()}` : null;
}

/**
 * Reads a Host header (a port after `:` is ignored) as `{ slug, port }` when it is exactly `app-<slug>-<port>.<suffix>`: one label before the
 * suffix, a port of 1 to 5 digits without a leading zero in range. Anything else is null. The slug is a lowercase workspace name; which
 * workspace it is (exactly one across all targets) is the server's to decide.
 */
export function parseAppPortHost(host: string | undefined | null, suffix: string | undefined | null): { slug: string; port: number } | null {
  if (!host || !suffix) return null;
  const h = host.toLowerCase().replace(/:\d{1,5}$/, '');
  const tail = `.${suffix.toLowerCase()}`;
  if (!h.endsWith(tail)) return null;
  const label = h.slice(0, -tail.length);
  if (!LABEL.test(label)) return null;
  const m = /^app-([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-([1-9]\d{0,4})$/.exec(label);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < APP_PORT_MIN || port > APP_PORT_MAX) return null;
  return { slug: m[1]!, port };
}

/**
 * `next` on the auth route: a path on the app host, never a URL. It starts with one `/`, has no `//` or backslash anywhere, no scheme, no
 * control character, and at most 2,048 characters. Anything else is refused (400).
 */
export function isAppPortNext(next: string): boolean {
  return (
    next.length > 0 &&
    next.length <= 2048 &&
    next.startsWith('/') &&
    !next.includes('//') &&
    !next.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(next) &&
    !/^\/[a-z][a-z0-9+.-]*:/i.test(next)
  );
}

/** One port listening inside a workspace (`ss -ltn`, loopback or any address). */
export interface AppPortItem {
  port: number;
  /** The process that listens, when the workspace says (`ss -p`); absent when unknown. */
  process?: string;
  /** Whether it may be opened: in range and not one of the portal's own or agent ports. */
  openable: boolean;
}

/** `GET …/ports`. `enabled: false` when the portal has no `PORT_PROXY_HOST_SUFFIX` (the feature is off): `ports` is then empty. */
export interface AppPortList {
  enabled: boolean;
  ports: AppPortItem[];
}

/** `POST …/ports/open`: the port, and the path to land on (a path, see `isAppPortNext`; `/` when absent). */
export interface OpenAppPortRequest {
  port: number;
  path?: string;
}

/**
 * The answer to OPEN. `url` is `https://<host>/__pilot/auth?code=<one-time>&next=<path>`: navigate to it (a new tab or the iframe) within 30
 * seconds, once. `host` is the app host, for showing and copying (`https://<host>/` works again later while its cookie lives).
 */
export interface OpenAppPortResult {
  url: string;
  host: string;
  /** When the one-time code in `url` stops working (ISO). */
  expiresAt: string;
}

export const APP_PORTS_API = {
  /** GET: the listening ports (`operate` on the workspace). */
  list: (id: string) => `/api/workspaces/${id}/ports`,
  /** POST `OpenAppPortRequest` → `OpenAppPortResult` (`operate`, audited `workspace.port.open`). 404 when the feature is off. */
  open: (id: string) => `/api/workspaces/${id}/ports/open`,
} as const;
