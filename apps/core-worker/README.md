# cp-next-core (`@portal/core-worker`)

The ClaudePilot core on Cloudflare Workers + Durable Objects (epic PILOT-1131). Phase 1: a skeleton, on staging behind Access (below). The live portal
(`apps/server`) is unchanged and stays on k3s until cutover.

- `src/app.ts`: the Hono app. `GET /healthz` answers `{ ok, service, version, commit, connectProtocol }`; any other path is the
  portal's plain 404 body (`AppError('NOT_FOUND', 'Not found.')`).
- `src/do/`: the shards (D2), each a SQLite Durable Object with a `schema_version` table and a `ping()` RPC: `PlatformDO`, `OrgDO`,
  `WorkspaceDO`, `ChatSessionDO`, `BridgeDO`. Their migrations (`SchemaDO`) are append only; so are the `migrations` tags in
  `wrangler.jsonc`.
- `src/locate.ts`: the only place that calls `idFromName`; it places every object in `apac` (a test fails on any other caller).
- `GET /bridge` (PILOT-1144, D3, D4): the in-cluster cp-bridge dials out here. `src/bridge/route.ts` checks before the upgrade:
  `Upgrade: websocket`, no `Origin`, subprotocol `pilot.tunnel.v1`, `X-Pilot-Cluster`, and `Authorization: Bearer` whose SHA-256
  matches the cluster in the `BRIDGE_CLUSTERS` secret (`{ "<cluster>": { node, publicKey, tokenSha256 } }`; absent, not JSON
  or malformed means every dial is refused; an entry whose key is not a valid Ed25519 key of large order is dropped:
  `connectPublicKeyProblem`, held equal to the portal's `publicKeyProblem`). Any failure is the plain 404. `src/do/bridge.ts` (`BridgeDO`, one per cluster) then runs the Connect handshake of
  `apps/server/src/connect/hub.ts` (challenge, auth, welcome or reject) with the WebCrypto Ed25519 check shared in
  `packages/contracts/src/connectSign.ts`, single-use nonces, the Hibernation API, an alarm that pings and ends silent links
  (`CONNECT_LIMITS`), and one live link per cluster: a new one replaces the old one (closed 4409, written to `bridge_audit`). The alarm prunes `bridge_audit` to 30 days and at most 10,000 rows (`BRIDGE_AUDIT_KEEP`).
  A live link runs a server `MuxSession` (PILOT-1170). The REST client (PILOT-1171) is by RPC: `kube` (one checked GET), `kubeList`,
  `kubeMetrics`, `kubeCreate`, `kubeScale`, `kubeDelete`; requests are built and answers read in `src/bridge/kubeApi.ts`, which refuses
  `..`, any `%` and a query string in a path before a stream opens. An exec is a WebSocket from `BridgeDO` (`bridgeExecRequest`,
  `src/bridge/kubeExec.ts`; Worker code only): v5 with a v4 fallback, resize on channel 4. `apps/server/src/connect/tunnel/bridgeWorker.test.ts` dials it with
  the real `dialTunnel` and the real `KubeProxy` (opt-in: `CLAUDEPILOT_WORKER_TESTS=1`), through `test/interop/entry.ts`.
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

## Staging deploy (PILOT-1145)

`scripts/deploy-stg.mjs` puts the Worker on `CP_NEXT_HOST` (`pilot-next.<zone>`) behind Cloudflare Access, Access first (D3): the Access
app `cp-next-access` (whole host, created with no policy, so nobody gets in), its one policy `cp-next-healthcheck` (the service token
`cp-next-healthcheck` only, no person yet), then `wrangler deploy`, then the Worker custom domain (which makes the host's DNS record;
nothing else in the zone is touched), then two checks: `/healthz` without credentials is the Access redirect or 403, with the service token
it is 200 and the deployed commit. It reads the four values from the `cp-next` pool by name and never prints them; an existing service
token is rotated for the check and its secret is not kept. `--plan` reads only and says what a run would do. Run it in the cluster:

```sh
scripts/job-run.sh --ref <pushed sha> --pool-env CP_NEXT_CF_API_TOKEN --pool-env CP_NEXT_CF_ACCOUNT_ID --pool-env CP_NEXT_ZONE \
  --pool-env CP_NEXT_HOST -- 'node apps/core-worker/scripts/deploy-stg.mjs --plan; exit $?'
```

Rollback: `npx wrangler rollback <previous version id>` in `apps/core-worker` (same environment); to take the host off, delete the
custom domain (`DELETE /accounts/<account>/workers/domains/<id>`). `/bridge` stays refused until `BRIDGE_CLUSTERS` is set.
