# cp-next-core (`@portal/core-worker`)

The ClaudePilot core on Cloudflare Workers + Durable Objects (epic PILOT-1131). Phase 1: a skeleton, not deployed. The live portal
(`apps/server`) is unchanged and stays on k3s until cutover.

- `src/app.ts`: the Hono app. `GET /healthz` answers `{ ok, service, version, commit, connectProtocol }`; any other path is the
  portal's plain 404 body (`AppError('NOT_FOUND', 'Not found.')`).
- `src/do/`: the shards (D2), each a SQLite Durable Object with a `schema_version` table and a `ping()` RPC: `PlatformDO`, `OrgDO`,
  `WorkspaceDO`, `ChatSessionDO`, `BridgeDO`. Their migrations (`SchemaDO`) are append only; so are the `migrations` tags in
  `wrangler.jsonc`.
- `src/locate.ts`: the only place that calls `idFromName`; it places every object in `apac` (a test fails on any other caller).
- `wrangler.jsonc`: name `cp-next-core`, `nodejs_compat`, no account id and no route (they come from the environment at deploy),
  workers.dev and preview URLs off, an empty static-assets binding (`public/`, the SPA comes in phase 2).

Commands (in the cluster only, through `scripts/job-run.sh`; never in the pod):

```sh
npm run typecheck -w @portal/core-worker
npm test -w @portal/core-worker              # vitest inside workerd (@cloudflare/vitest-plugin)
npm run build:dry -w @portal/core-worker     # wrangler deploy --dry-run: the build check, needs no token
```
