// A request that takes longer than SLOW_REQUEST_MS logs one line: method, the path with its ids masked, the query's names (never values),
// the status and the time. 2026-11-02: one browser's polling saturated the portal for minutes and nothing said which request it was.
import type { MiddlewareHandler } from 'hono';

export const SLOW_REQUEST_MS = 1000;

/** `/api/chat/sessions/<uuid>/events` -> `/api/chat/sessions/:id/events`: uuids, prefixed ids (`u_…`, `org_…`), long hex and numbers masked. */
export function maskPath(path: string): string {
  return path
    .split('/')
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
      /^[a-z]{1,8}_[A-Za-z0-9_-]{6,}$/.test(seg) ||
      /^[0-9a-f]{12,}$/i.test(seg) ||
      /^\d+$/.test(seg) ||
      /^[A-Z]+-\d+$/.test(seg)
        ? ':id'
        : seg.length > 40
          ? ':long'
          : seg,
    )
    .join('/');
}

/** `[slow] 2312 ms GET /api/chat/sessions/:id/events?before&limit 200`. */
export function slowLine(ms: number, method: string, url: string, status: number): string {
  const u = new URL(url, 'http://x');
  const keys = [...new Set([...u.searchParams.keys()])].filter((k) => /^[A-Za-z0-9_.-]{1,32}$/.test(k)).sort();
  return `[slow] ${Math.round(ms)} ms ${method} ${maskPath(u.pathname)}${keys.length ? `?${keys.join('&')}` : ''} ${status}`;
}

export function slowRequests(log: (line: string) => void = (l) => console.log(l), limitMs = SLOW_REQUEST_MS): MiddlewareHandler {
  return async (c, next) => {
    const t0 = performance.now();
    try {
      await next();
    } finally {
      const ms = performance.now() - t0;
      if (ms > limitMs) log(slowLine(ms, c.req.method, c.req.url, c.res?.status ?? 0));
    }
  };
}
