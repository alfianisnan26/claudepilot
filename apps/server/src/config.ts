import { fileURLToPath } from 'node:url';

const env = (name: string) => process.env[name]?.trim() || undefined;

const root = fileURLToPath(new URL('../../../', import.meta.url));

export const config = {
  dev: process.env.NODE_ENV !== 'production',
  host: env('PORTAL_HOST') ?? '0.0.0.0',
  port: Number(env('PORTAL_PORT') ?? 3000),
  /** Fixed server code; when unset one is generated at startup. */
  serverCode: env('PORTAL_SERVER_CODE'),
  /** Repo root, web app source and its build output. */
  paths: {
    root,
    web: `${root}apps/web`,
    webDist: `${root}apps/web/dist`,
  },
  session: {
    cookie: 'portal_session',
    ttlMs: 12 * 60 * 60 * 1000,
  },
  /** Failed sign-ins allowed per client address in each window. */
  loginLimit: { attempts: 10, windowMs: 10 * 60 * 1000 },
};
