import { APP_PORT_MAX, APP_PORT_MIN, isAppPortNext } from '@portal/contracts';

/** What the App address bar understands (T-948): a port on loopback inside the workspace, and a path on it. */
export interface AppTarget {
  port: number;
  /** Always starts with `/`; query and fragment kept. */
  path: string;
}

export type AppAddress = { ok: true; target: AppTarget } | { ok: false; reason: string };

const refuse = (reason: string): AppAddress => ({ ok: false, reason });

/**
 * Reads `localhost:<port>/<path>`, `127.0.0.1:<port>/<path>`, `http://` in front of either, or a bare port. Anything else is refused with a
 * short reason: another host, a scheme other than http (https, file, javascript, data), no port, a port outside the openable range, a path
 * the server would refuse (`//`, a backslash, a control character).
 */
export function parseAppAddress(input: string): AppAddress {
  let s = input.trim();
  if (!s) return refuse('Enter a port.');

  let rest: string;
  let port: number;
  if (/^\d+$/.test(s)) {
    port = Number(s);
    rest = '';
  } else {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
    if (scheme) {
      if (scheme[1]!.toLowerCase() !== 'http') return refuse('Only http.');
      s = s.slice(scheme[0].length);
    } else if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(s)) {
      // `javascript:…`, `file:…`, `data:…`: a scheme (a host then a port is `name:digits`).
      return refuse('Only http.');
    }
    const m = /^(localhost|127\.0\.0\.1)(?::(\d+))?([/?#].*)?$/i.exec(s);
    if (!m) return refuse('Only localhost.');
    if (!m[2]) return refuse('Add a port.');
    port = Number(m[2]);
    rest = m[3] ?? '';
  }

  if (!Number.isInteger(port) || port < APP_PORT_MIN || port > APP_PORT_MAX) return refuse(`Port ${APP_PORT_MIN} to ${APP_PORT_MAX}.`);
  const path = rest === '' ? '/' : rest.startsWith('/') ? rest : `/${rest}`;
  if (!isAppPortNext(path)) return refuse('That path isn’t allowed.');
  return { ok: true, target: { port, path } };
}

/** How a target is shown in the address bar. */
export const formatAppTarget = (t: AppTarget): string => `localhost:${t.port}${t.path === '/' ? '' : t.path}`;
