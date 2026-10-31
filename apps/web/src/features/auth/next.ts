// Where the login page sends a person after signing in when it is not the app (`/login?next=...`): only the UI reporter's connect popup
// (apps/server/src/reporter/routes.ts "Sign in first"), a same-origin path with its own query. Anything else (another path, another host,
// a protocol-relative or encoded trick) is null and the app's usual landing applies.

const CONNECT = /^\/reporter\/v1\/connect\?[A-Za-z0-9%=&._~-]{0,600}$/;

export function connectReturnPath(next: string | null | undefined): string | null {
  if (typeof next !== 'string' || !CONNECT.test(next)) return null;
  try {
    const u = new URL(next, 'https://portal.invalid');
    return u.origin === 'https://portal.invalid' && u.pathname === '/reporter/v1/connect' ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}
