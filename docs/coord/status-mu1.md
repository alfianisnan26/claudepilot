Spawn: MU1 identity core | fable | high | Tier S: accounts, passwords, sessions, setup token = security-critical, hard to verify | 2026-10-12T06:49Z
# MU1 status (identity core) - 2026-10-12
FOCUS NOW: building apps/server/src/identity/** (new files) + migrations 400-402; surgical lines later (app.ts, index.ts, config.ts, cli.ts, sockets.ts, shell.ts cookie(), platform/audit.ts AuditInput).
STANDING RULES: git read-only; env -i scratch portal 3282 (prefix mu1-); heavy jobs under flock heavy.lock nice -n 10; no secret in logs/audit/responses; uniform denials.
DECISIONS (so far):
- MO1 15 chars, MO2 masked+CLI (PORTAL_SETUP_TOKEN_LOG=full opt-in), MO3 admins only, MO11 u_owner, MO12 no idle timeout, MO13 PORTAL_ENV_STRICT documented: recommended defaults taken.
- PORTAL_IDENTITY=legacy|accounts read once in config.ts; legacy = nothing changes (identity routes answer 401 then 404; GET /api/session answers AuthStatus in both modes).
- Portal subclass (identity/portal.ts) overrides session(token) in accounts mode -> every socket module and requireSession keep working unchanged; chat Reauth subclass checks the password.
- Sockets: revocation = DB-authoritative session lookup + SocketGuard.sweep() on every emitAccessChange (no per-user map needed); SocketGuard and shell.ts cookie() accept __Host- name too.
- __Host- + Secure only when the request is HTTPS (trustProxy X-Forwarded-Proto or PORTAL_COOKIE_SECURE=true).
- User avatars: own table user_avatars (persona_avatars is pruned by personas); reuses normalizeAvatar.
- FR6 claiming workspaces needs MU2's workspace_owners: exposed as identity.afterSetup hook; request in outbox.
- Reassign (FR35) moves objects through an injectable hook (MU2's resolvers); default moves nothing and says so.
- Block list: shipped entries I can vouch for (not a downloaded 1,000); the 15-char minimum excludes almost all of any list anyway.
RESUME HERE: nothing written yet; next = migrations 400-402 in store/migrations.ts (append), then identity/passwords.ts + test.
