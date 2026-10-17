# Example: one project's lanes and deploy pipeline

The first program that used this kit. Paths and names are that project's; yours are in your project's docs (CLAUDE.md, the dev-session guide, `.pilot/`).

## Pipeline file shape

Pipelines live in the repository under `.pilot/*.yml`. Policy (protected branches, environment protection, who approves) lives in the portal, never in the file.

```yaml
name: Deploy
on:
  manual:
    inputs:
      images:  { type: string,  default: portal }
      gate:    { type: boolean, default: true }
      deploy:  { type: boolean, default: true }
      dry_run: { type: boolean, default: false }
timeout: 4h
concurrency:
  group: deploy-app
jobs:
  gate:
    timeout: 90m
    steps:
      - name: Release gate
        run: bash .pilot/scripts/gate.sh
  build:
    needs: [gate]
    steps:
      - name: Images in the cluster
        run: bash .pilot/scripts/build.sh
    artifacts: { paths: [.pilot/out/build.env] }
  release:
    needs: [build]
    if: inputs.deploy
    environment: production
    steps:
      - name: Tags to main
        run: bash .pilot/scripts/release.sh
    artifacts: { paths: [.pilot/out/release.env], when: always }
  verify:
    needs: [release]
    steps:
      - name: Argo CD, rollout, smoke, logs
        run: bash .pilot/scripts/verify.sh
  rollback:
    needs: [release, verify]
    if: failure()
    steps:
      - name: Previous tags to main
        run: bash .pilot/scripts/rollback.sh
```

Scripts get inputs and run facts as environment variables (`PILOT_INPUT_<NAME>`, `PILOT_SHA`, `PILOT_BRANCH`, `PILOT_RUN_ID`), never pasted into the command, so a branch name cannot inject shell. A job's secrets are listed by name (`secrets: [NAME]`) and read from the workspace's secret files for that job only.

## Triggering it from an agent

`ci_run_trigger` with repo `claudepilot`, pipeline `deploy`, ref `integration`, inputs `images` (`portal`, or `portal,workspace` when the workspace image changed), `gate`, `deploy`, `dry_run`. Before it: push `integration` to both remotes the pipeline reads (the git host the image build clones from, and the workspace's own CI remote the run checks out).

## Lessons that shaped the rules

- A release that pushed the deploy branch and the integration branch in one atomic push failed whenever someone pushed integration during the 20-minute approval wait. The release now pushes the deploy branch alone, then merges the release into the moved integration tip as a separate step; a conflict there only warns, because the deploy is done.
- One flaky test failed a whole 33-minute gate. The gate now reruns failing files alone and reports "flaky, passed on rerun" with the names, and a `flaky` ticket follows.
- The full gate in the shared workspace took 15 to 40 minutes and hung twice; as a cluster Job with `/tmp` in memory it takes minutes.
- Heavy commands of many agents queued on one lock in one pod while another node sat idle. `job-run` moved them out.

## Numbers there

- Job caps: 3 at once cluster-wide, 2 per chat. Artifacts back at most 4 MiB compressed. Job timeout up to 90 minutes.
- Gate Job: 1 CPU requested, 4 the limit, `/tmp` in memory, test concurrency 3, a 10-minute cap per test file.
