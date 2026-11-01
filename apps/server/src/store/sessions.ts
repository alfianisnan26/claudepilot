import type { Session, SessionStore } from '../portal.js';
import type { Store } from './store.js';

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Sign-ins kept in the portal database (by token hash), so restarts don't sign anyone out. Reads work
 * while the database is Locked; writes are skipped while it's read-only (Frozen), and sign-ins made
 * then last until the next restart.
 */
export function sessionStore(store: Store): SessionStore {
  const writable = () => (store.writable ? store.db : null);
  return {
    load(now) {
      const sessions = new Map<string, Session>();
      const db = store.db;
      if (!db) return sessions;
      writable()?.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(iso(now));
      const rows = db.prepare('SELECT token_hash, created_at, expires_at, user_id, device, method FROM web_sessions WHERE expires_at > ?').all(iso(now)) as {
        token_hash: string;
        created_at: string;
        expires_at: string;
        user_id: string | null;
        device: string | null;
        method: string | null;
      }[];
      for (const r of rows)
        sessions.set(r.token_hash, {
          createdAt: Date.parse(r.created_at),
          expiresAt: Date.parse(r.expires_at),
          ...(r.user_id ? { userId: r.user_id } : {}),
          ...(r.device ? { device: r.device } : {}),
          ...(r.method ? { method: r.method } : {}),
        });
      return sessions;
    },
    save(hash, s) {
      writable()
        ?.prepare(
          'INSERT INTO web_sessions (token_hash, created_at, expires_at, user_id, device, method) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (token_hash) DO UPDATE SET expires_at = excluded.expires_at',
        )
        .run(hash, iso(s.createdAt), iso(s.expiresAt), s.userId ?? null, s.device ?? null, s.method ?? null);
    },
    remove(hash) {
      writable()?.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(hash);
    },
    removeAllExcept(hash) {
      writable()?.prepare('DELETE FROM web_sessions WHERE token_hash IS NOT ?').run(hash);
    },
    // Owner request 2026-11-01: the server code's sign-in switch survives a restart (portal_meta, migration 1); no row: on.
    codeSignIn() {
      const r = store.db?.prepare("SELECT value FROM portal_meta WHERE key = 'server_code_signin'").get() as { value: string } | undefined;
      return r ? r.value !== 'off' : null;
    },
    setCodeSignIn(on) {
      writable()
        ?.prepare("INSERT INTO portal_meta (key, value) VALUES ('server_code_signin', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(on ? 'on' : 'off');
    },
  };
}
