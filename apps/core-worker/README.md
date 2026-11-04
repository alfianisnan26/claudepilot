# cp-next-core (`@portal/core-worker`)

The ClaudePilot core on Cloudflare Workers + Durable Objects (epic PILOT-1131). Phase 1: a skeleton, on staging behind Access (below). The live portal
(`apps/server`) is unchanged and stays on k3s until cutover.

- `src/app.ts`: the Hono app. `GET /healthz` answers `{ ok, service, version, commit, connectProtocol }`; any other path that reaches
  the Worker is the portal's plain 404 body (`AppError('NOT_FOUND', 'Not found.')`); the rest is the SPA (below).
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
  Mux frames pass untouched; phase 1 only answers pings. `apps/server/src/connect/tunnel/bridgeWorker.test.ts` dials it with the
  real `dialTunnel` (opt-in: `CLAUDEPILOT_WORKER_TESTS=1`).
- `test/spike/` (PILOT-1159, G6): the server's tunnel code (mux, streams, open) run unchanged inside `BridgeDO`, with HTTP/1.1 and an
  exec written straight onto a `kube` stream. Kept out of the typecheck (it imports `apps/server`); the finding is in
  `docs/prd/cf-bridge.md` ("G6 finding").
- `wrangler.jsonc`: name `cp-next-core`, `nodejs_compat`, no account id and no route (they come from the environment at deploy),
  workers.dev and preview URLs off, and the SPA as static assets (below).

## The SPA (PILOT-1148)

`npm run build` (here) builds `apps/web` and `scripts/webAssets.mjs` copies `apps/web/dist` into `public/` (git keeps only
`.assetsignore`), fails over the Workers asset limits (20,000 files, 25 MiB each) and prints the file count and bytes. The asset
router (`not_found_handling: single-page-application`) serves every path that is not in `run_worker_first`: a file, or `index.html`
for a client-side route (`/`, `/admin/...`), navigation or not. `run_worker_first` sends `/api/*`, `/mcp`, `/mcp/*`, `/bridge`,
`/connect/*`, `/healthz` and `/assets/*` to the Worker; an unknown Worker path is the plain 404 body.

- Headers, the same as the portal's (`apps/server/src/app.ts`): the asset router's responses get `public/_headers`, written by
  `webAssets.mjs` from hono `secureHeaders` with the portal's options (no HSTS) and its CSP (`apps/server/src/csp.ts`: the inline
  theme script by hash), plus `Cache-Control: no-cache` (the shell, `sw.js` and the manifest are re-checked, so an update reaches
  installed copies). The Worker's own responses get the same secure headers without the CSP (none of them is a document); `/api/*`
  is `no-store`.
- `/assets/*` (hashed): through the Worker, `public, max-age=31536000, immutable` and `Cross-Origin-Resource-Policy: cross-origin`
  on a file that exists; a missing one is `404 Not found`, `no-store`, never the shell (the portal's rule for a tab left open across
  a deploy).
- The PWA: `sw.js` and `manifest.webmanifest` are at the root with scope `/`, and the web app uses only relative paths and
  `location.host`, so they work on the new host as they are.
- `test/assets.test.ts` checks all of this in workerd against a small build made by `vitest.config.ts`, whose expected headers come
  from the portal's own code; vitest's `SELF` goes past the asset router, so the router's own answers are fetched there through the
  `ASSETS` binding, and `test-node/router.test.mjs` (`npm run test:router`, wrangler dev) checks which path goes where. Not yet routed to the Worker (they have no handler there yet): `/hooks/*`, `/admin-api/*`,
  `/reporter/v1/*`; each is added to `run_worker_first` with its route.

Commands (in the cluster only, through `scripts/job-run.sh`; never in the pod):

```sh
npm run typecheck -w @portal/core-worker
npm test -w @portal/core-worker              # vitest inside workerd (@cloudflare/vitest-plugin)
npm run test:router -w @portal/core-worker   # the asset router in front of the Worker (wrangler dev, node:test)
npm run build -w @portal/core-worker         # the SPA into public/ (apps/web build + _headers)
npm run build:dry -w @portal/core-worker     # wrangler deploy --dry-run: the build check, needs no token
(cd apps/server && CLAUDEPILOT_WORKER_TESTS=1 node --import tsx --test src/connect/tunnel/bridgeWorker.test.ts)  # real client vs workerd
```

At deploy, `BRIDGE_CLUSTERS` is set with `wrangler secret put` (never in `wrangler.jsonc` or the repository).

## Staging deploy (PILOT-1145)

`scripts/deploy-stg.mjs` puts the Worker on `CP_NEXT_HOST` (`pilot-next.<zone>`) behind Cloudflare Access, Access first (D3): the Access
app `cp-next-access` (whole host, created with no policy, so nobody gets in), its one policy `cp-next-healthcheck` (the service token
`cp-next-healthcheck` only, no person yet), then `wrangler deploy`, then the Worker custom domain (which makes the host's DNS record;
nothing else in the zone is touched), then two checks: `/healthz` without credentials is the Access redirect or 403, with the service token
it is 200 and the deployed commit. It reads the four values from the `cp-next` pool by name and never prints them.

It is safe to run again (PILOT-1180):

- It takes only `--plan`, `--rotate` and `--keep-unknown-policies`: any other argument (a typo such as `--plna`) stops it before any call.
- Before anything is written it pins the account: `GET /accounts/<id>` must answer with that id, its whole name must be KohiLabs (any
  case, `Kohi Labs` allowed, nothing more), and the zone must belong to it. Otherwise it stops.
- A policy on `cp-next-access` that the script did not make stops the run (the app is deny-first, so an unknown allow rule is unsafe).
  `--keep-unknown-policies` goes on and leaves such policies as they are.
- A plain re-run keeps the existing service token: its secret is unknown to the run, so the token check is SKIPPED and the run exits 3
  (deployed, Access check passed). `--rotate` rotates the token (the old secret stops working) and the run does both checks. The new
  secret is used for the check only and is not kept.
- `--plan` reads only and says what a run would do; the guards stop a plan the same way.
- Exit codes: 0 both checks passed; 1 a guard stopped it or a check failed; 3 deployed, the token check skipped.
- Its test (mocked fetch, no network; part of `npm test`): `npm run test:scripts -w @portal/core-worker`.

Run it in the cluster:

```sh
scripts/job-run.sh --ref <pushed sha> --pool-env CP_NEXT_CF_API_TOKEN --pool-env CP_NEXT_CF_ACCOUNT_ID --pool-env CP_NEXT_ZONE \
  --pool-env CP_NEXT_HOST -- 'node apps/core-worker/scripts/deploy-stg.mjs --plan; exit $?'
```

Rollback: `npx wrangler rollback <previous version id>` in `apps/core-worker` (same environment); to take the host off, delete the
custom domain (`DELETE /accounts/<account>/workers/domains/<id>`). `/bridge` stays refused until `BRIDGE_CLUSTERS` is set.
