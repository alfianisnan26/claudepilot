/**
 * App ports (T-948, docs/prd/app-ports.md): a web app listening on loopback inside a workspace (`127.0.0.1:<port>`) opens in the browser
 * through the portal, as plain HTTP and WebSocket (not the remote browser's streamed screen).
 *
 * Subdomain mode: each workspace and port is its own host, `<port>[-<app>]-<workspace>.<suffix>` (one DNS label; owner, 2026-10-18), so the
 * app's scripts never run on the portal's origin and never see the portal's cookie (host-only). `<workspace>` is the workspace's label as a
 * slug (`isnan-pod`), `<app>` an optional name the person gives the port. The suffix is `PORT_PROXY_HOST_SUFFIX`; unset, the feature is off.
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

/**
 * A name as a host part (owner, 2026-10-18: "{port}-{name}-{workspace}.pilot.ai.isnan.me"): lowercase, every run of other characters one dash,
 * no dash at either end. Null when nothing is left. `isnan-pod` stays `isnan-pod`; `Trading Bot!` becomes `trading-bot`.
 */
export function appHostSlug(name: string | null | undefined): string | null {
  const s = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s && LABEL.test(s) ? s : null;
}

/**
 * The host label `<port>-<app>-<workspace>`, or `<port>-<workspace>` without an app name: one DNS label, so one wildcard certificate covers
 * every app host. `workspace` and `app` are slugs (`appHostSlug`). Null when the port is out of range or the label grows past 63 characters.
 */
export function appPortLabel(workspace: string, port: number, app?: string | null): string | null {
  if (!Number.isInteger(port) || port < APP_PORT_MIN || port > APP_PORT_MAX || !LABEL.test(workspace) || (app && !LABEL.test(app))) return null;
  const label = app ? `${port}-${app}-${workspace}` : `${port}-${workspace}`;
  return LABEL.test(label) ? label : null;
}

/** `<port>[-<app>]-<workspace>.<suffix>`; null when the label can't be one. */
export function appPortHost(workspace: string, port: number, suffix: string, app?: string | null): string | null {
  const label = appPortLabel(workspace, port, app);
  return label ? `${label}.${suffix.toLowerCase()}` : null;
}

/**
 * Reads a Host header (a port after `:` is ignored) as `{ rest, port }` when it is exactly `<port>-<rest>.<suffix>`: one label before the
 * suffix, a port of 4 or 5 digits without a leading zero, in range. `rest` is `<app>-<workspace>` or `<workspace>`; which workspace it names is
 * decided at open, where the grant is bound to this exact host, so reading it back needs only the port. Anything else is null.
 */
export function parseAppPortHost(
  host: string | undefined | null,
  suffix: string | undefined | null,
): { rest: string; port: number } | null {
  if (!host || !suffix) return null;
  const h = host.toLowerCase().replace(/:\d{1,5}$/, '');
  const tail = `.${suffix.toLowerCase()}`;
  if (!h.endsWith(tail)) return null;
  const label = h.slice(0, -tail.length);
  if (!LABEL.test(label)) return null;
  const m = /^([1-9]\d{3,4})-([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/.exec(label);
  if (!m) return null;
  const port = Number(m[1]);
  if (port < APP_PORT_MIN || port > APP_PORT_MAX) return null;
  return { rest: m[2]!, port };
}

/**
 * `next` on the auth route: a path on the app host, never a URL. It starts with one `/`, has no `//` or backslash anywhere, no scheme, no
 * control character, only printable ASCII (a non-ASCII character is sent percent-encoded: raw, it can't go in a Location header), and at
 * most 2,048 characters. Anything else is refused (400).
 */
export function isAppPortNext(next: string): boolean {
  return (
    next.length > 0 &&
    next.length <= 2048 &&
    next.startsWith('/') &&
    !next.includes('//') &&
    !next.includes('\\') &&
    !/[^ -~]/.test(next) &&
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
  /** An app name for the host (`8765-tradingbot-isnan-pod…`), made a slug by `appHostSlug`; absent or empty: `8765-isnan-pod…`. */
  name?: string;
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

/** One open app session (owner, 2026-10-18: "list of running browser proxy session"): a live app host cookie. */
export interface AppPortSession {
  /** Enough to revoke it, nothing to sign in with. */
  id: string;
  workspaceId: string;
  port: number;
  host: string;
  /** Who opened it: `account:<id>` or the server code (`ui`). */
  openedBy: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string;
}

export const APP_PORTS_API = {
  /** Full session only. GET: `AppPortSession[]`, every open app host. */
  sessions: '/api/admin/app-sessions',
  /** Full session only. DELETE: end one (the next request on that host is refused). */
  session: (id: string) => `/api/admin/app-sessions/${encodeURIComponent(id)}`,
  /** GET: the listening ports (`operate` on the workspace). */
  list: (id: string) => `/api/workspaces/${id}/ports`,
  /** POST `OpenAppPortRequest` → `OpenAppPortResult` (`operate`, audited `workspace.port.open`). 404 when the feature is off. */
  open: (id: string) => `/api/workspaces/${id}/ports/open`,
} as const;
