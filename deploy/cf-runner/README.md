# cp-jobrun: job-run on Cloudflare Containers (T-3542, epic PILOT-1127)

`scripts/job-run.sh --backend cf` runs a job in a Cloudflare Container instead of a k3s Job. This first slice serves one consumer, memor.id
(GitLab group `memorid`), on the KohiLabs account (owner decision D1). Konfersi and every other workspace stay on k8s: with no
`--backend` and no `JOB_RUN_BACKEND`, job-run.sh does exactly what it did before.

## Pieces

| Piece | Where | What |
|---|---|---|
| CLI | `scripts/job-run.sh` (`--backend`, `--sub`), `scripts/job-run-cf.sh`, `scripts/job-run-cf-client.mjs` | same CLI, log lines, masking and exit codes as k8s; signed HTTPS to the dispatcher |
| Dispatcher | `src/index.ts` (Worker `cp-jobrun-dispatcher`) | `POST /jobs`, `GET /jobs/:id`, `GET /jobs/:id/log?offset=`, `POST /jobs/:id/heartbeat`, `DELETE /jobs/:id`, `GET /jobs/:id/artifacts`, `GET /jobs?chat=`, `GET /budget` |
| Scheduler DO | `src/index.ts`, rules in `src/policy.ts` | caps (6 at once, 4 per chat, 6 per program), queue order, ledger; **$5/day**, 60 min per job |
| JobRun DOs | `JobRunStd` (standard-3: 2 vCPU, 8 GiB, 16 GB), `JobRunBig` (`--big`, standard-4: 4 vCPU, 12 GiB, 20 GB) | one per job: container, log in SQLite (64 MiB cap), alarms for deadline and heartbeat (120 s) |
| Egress | `Egress` WorkerEntrypoint | `enableInternet: false`; allow-list (`DEFAULT_ALLOW` or `ALLOW_HOSTS`); the GitLab token is added only to `git-upload-pack` reads of `gitlab.com/memorid/*`, only in the fetch phase; artifacts to R2 |
| Runner image | `container/` (Dockerfile, `agent.mjs`, `fetch.sh`, `run.sh`) | Node 22.23.3, git, Playwright 1.63.0 Chromium, Caddy |
| Metrics | `scripts/job-run-metrics.mjs` | one row per backend from `~/.cache/claudepilot-job-run/metrics.jsonl` |

The container never holds a credential. The clone's token travels in the job's POST body over TLS, stays in the JobRun object's memory
and in the Egress props for the fetch phase. After `npm ci --ignore-scripts` the agent calls `http://control.jobrun/phase/run`, the
object registers the egress again without it, and only then do the install scripts and the command run. The token delivered to the
kohilabs pool (`GITLAB_TOKEN`) has `api` and `write_repository` scopes, which is why the handler adds it to upload-pack requests only.

## Use (kohilabs workspace)

```sh
export JOB_RUN_CF_URL=https://cp-jobrun-dispatcher.kohilabs.workers.dev JOB_RUN_CF_WORKSPACE=kohilabs
# the key comes from CF_RUNNER_API_TOKEN (Secrets pool), or set JOB_RUN_CF_KEY
scripts/job-run.sh --backend cf --repo memorid --ref stg -- 'npm run build -w @memor/sdk && npm run typecheck'
scripts/job-run.sh --backend cf --big --repo memorid --ref stg --sub apps/api@wave/x -- 'npx vitest run --project api --shard=1/4'
JOB_RUN_BACKEND=auto JOB_RUN_CF_PROGRAMS=memorid scripts/job-run.sh --repo memorid --ref stg -- 'npm run lint'
```

## Build and deploy

1. Image (kaniko in the cluster, from a workspace with kubectl): get a push credential for `registry.cloudflare.com` from the API with
   `CF_RUNNER_API_TOKEN` and pipe it on stdin:
   `scripts/image-build.sh --repo claudepilot --ref <full commit> --dockerfile deploy/cf-runner/container/Dockerfile --context deploy/cf-runner/container --destination registry.cloudflare.com/fccdbeb05cb96c17557497b18fe357b7/cp-jobrun-runner:<tag> --credential-stdin`
2. Dispatcher, in the kohilabs workspace: `cd deploy/cf-runner && npm ci && ./deploy.sh <tag> kohilabs`.
3. Smoke: `scripts/job-run.sh --backend cf --repo memorid --ref stg --steps none -- 'echo hi; node -v'`.

## Tests

`cd deploy/cf-runner && npm test` (vitest, workers pool: signing, admission, budget, egress rules, routes);
`apps/server/src/ci/jobRunCf.test.ts` (job-run.sh against a fake dispatcher) and the T-3542 case in `jobRun.test.ts` (k8s unchanged).
