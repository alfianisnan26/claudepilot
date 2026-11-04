# cp-next-core (`@portal/core-worker`)

The ClaudePilot core on Cloudflare Workers + Durable Objects (epic PILOT-1131). Phase 1: a skeleton, not deployed. The live portal
(`apps/server`) is unchanged and stays on k3s until cutover.

- `src/app.ts`: the Hono app. `GET /healthz` answers `{ ok, service, version, commit, connectProtocol }`; any other path is the
  portal's plain 404 body (`AppError('NOT_FOUND', 'Not found.')`).
- `src/do/`: the shards (D2), each a SQLite Durable Object with a `schema_version` table and a `ping()` RPC: `PlatformDO`, `OrgDO`,
  `WorkspaceDO`, `ChatSessionDO`, `BridgeDO`. Their migrations (`SchemaDO`) are append only; so are the `migrations` tags in
  `wrangler.jsonc`.
- `src/locate.ts`: the only place that calls `idFromName`; it places every object in `apac` (a test fails on any other caller).
- `GET /bridge` (PILOT-1144, D3, D4): the in-cluster cp-bridge dials out here. `src/bridge/route.ts` checks before the upgrade:
  `Upgrade: websocket`, no `Origin`, subprotocol `pilot.tunnel.v1`, `X-Pilot-Cluster`, and `Authorization: Bearer` whose SHA-256
  matches the cluster in the `BRIDGE_CLUSTERS` secret (`{ "<cluster>": { node, publicKey, tokenSha256 } }`; absent means every dial
  is refused). Any failure is the plain 404. `src/do/bridge.ts` (`BridgeDO`, one per cluster) then runs the Connect handshake of
  `apps/server/src/connect/hub.ts` (challenge, auth, welcome or reject) with the WebCrypto Ed25519 check shared in
  `packages/contracts/src/connectSign.ts`, single-use nonces, the Hibernation API, an alarm that pings and ends silent links
  (`CONNECT_LIMITS`), and one live link per cluster: a new one replaces the old one (closed 4409, written to `bridge_audit`).
  Mux frames pass untouched; phase 1 only answers pings. `apps/server/src/connect/tunnel/bridgeWorker.test.ts` dials it with the
  real `dialTunnel` (opt-in: `CLAUDEPILOT_WORKER_TESTS=1`).
- `test/spike/` (PILOT-1159, G6): the server's tunnel code (mux, streams, open) run unchanged inside `BridgeDO`, with HTTP/1.1 and an
  exec written straight onto a `kube` stream. Kept out of the typecheck (it imports `apps/server`); the finding is in
  `docs/prd/cf-bridge.md` ("G6 finding").
- `wrangler.jsonc`: name `cp-next-core`, `nodejs_compat`, no account id and no route (they come from the environment at deploy),
  workers.dev and preview URLs off, an empty static-assets binding (`public/`, the SPA comes in phase 2).

Commands (in the cluster only, through `scripts/job-run.sh`; never in the pod):

```sh
npm run typecheck -w @portal/core-worker
npm test -w @portal/core-worker              # vitest inside workerd (@cloudflare/vitest-plugin)
npm run build:dry -w @portal/core-worker     # wrangler deploy --dry-run: the build check, needs no token
(cd apps/server && CLAUDEPILOT_WORKER_TESTS=1 node --import tsx --test src/connect/tunnel/bridgeWorker.test.ts)  # real client vs workerd
```

At deploy, `BRIDGE_CLUSTERS` is set with `wrangler secret put` (never in `wrangler.jsonc` or the repository).
