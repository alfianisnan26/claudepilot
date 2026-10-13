# `scripts/`: the gate and the cluster Job runners

What a new project copies or generates here, what each script must take as parameters, and what it leaves out.
The CI ticket writes these scripts; nothing here is pasted from another project. Reference implementations exist in
the platform's own repository (its `scripts/` folder; the operating kit's README names them). Read them for the
patterns, then write the project's own: small, `set -eu`, `shellcheck`-clean, and tested against fakes where they
touch a cluster or a remote.

## Copy the pattern (every project)

| Script | What it does | What it takes as parameters |
| --- | --- | --- |
| `gate.sh` | **The full gate** on a CLEAN COPY of a commit (`git archive`, not the working tree): install, then each step (typecheck, build, tests) with its own log and one summary line per step (`<step> rc=<n> <seconds>s`). Tests run from `env -i` with a throwaway `HOME`: no credentials, kubeconfig or Claude profile reach a test. A test that runs past a timeout fails instead of hanging. Files with a failing test run once more, alone: a pass alone is written to the summary as **flaky**, with the test names, never as green. | The commit (default `HEAD`); the steps to run; the test files (default all); test concurrency; the per-test timeout; the logs folder. |
| `gate-verdict.sh` | **One verdict line** from a gate's logs: `GATE-VERDICT: green` or `GATE-VERDICT: red: <why>`, exit 0 or 1, plus `note:` lines for flaky files. One reader, used by the local gate, the gate Job and the pipeline alike. | The logs folder or a Job's log; the steps that were asked for. |
| `gate-quick.sh` | **The fast lane** before every integration push, in the current checkout (no clean copy, no install): the typecheck, then only the checks for what changed since a base. A map from changed paths to the tests that cover them; anything everything depends on (shared types, migrations, authorization, settings, the build files) runs everything. Documentation only: nothing to check. | The base (default `origin/<integration branch>`; in CI `$PILOT_BASE_SHA`); the path-to-tests map, which is the project's own. |
| `gate-job.sh` | **The full gate as a cluster Job** on a node without a workspace pod, from a PUSHED commit: a fresh clone in a memory-backed `/tmp`, CPU requested and capped, a deadline, removed after it ends, no service account token. Prints the summary and the verdict line, exits 0 or 1. A credential the install needs goes into a Secret on stdin (never an argument), owned by the Job, deleted on exit; the log is searched for it and masked. | The commit; the steps; the test files; the namespace; the image; the Job manifest template; the wait limit. |
| `gate-job-stop.sh` | **A narrow door**: stops gate Jobs and their Secrets, matched by an exact name pattern and a label, nothing else. Needed because the deny rules forbid broad `kubectl delete` and a cancelled pipeline kills `gate-job.sh` before its cleanup. | A commit prefix, or who started it (`--by pipeline`), or `--list`. |
| `job-run.sh` | **Any heavy command as a cluster Job**: tests, typechecks, builds, browsers, timing runs. The code is a pushed branch or commit; the log streams back; the exit code is the command's; small artifacts come back to a folder. Caps: at most N Jobs cluster-wide and M per chat; over a cap a Job waits suspended and says "queued behind K". The Job is labelled with the chat and the role, and stops when the script is interrupted or the chat ends. | The repository and ref (default the current folder's remote and `HEAD`, which must be pushed); the command; steps before it (install or none); artifacts and where they go; a timeout; the caps; the role label. |
| `dev-rig.sh` | **The one door for test namespaces**: `create`, `delete` and `list` a namespace named `dev-rig-<name>`, labelled as a rig. It refuses any other name, and deletes only a namespace that carries the rig label. | The action and the name; the name pattern and the label are fixed in the script. |

Until the cluster scripts exist, heavy work runs in the workspace one job at a time, and the full gate runs as
`gate.sh` in the workspace.

## The trailer hook (when it exists)

A `prepare-commit-msg` hook delivered by the platform will append the trailers (`Ticket`, `Pilot-Session`,
`Pilot-Agent` and more) to every commit. It does not exist yet. Until it does, every commit ends with the trailers
typed by hand (`docs/dev-sessions/README.md`, "Who integrates"). Once it exists, a sub-agent exports
`PILOT_AGENT=<label>` and the hook writes the rest.

## Leave out (specific to the platform's own repository)

- Image builds for a particular registry and builder (its in-cluster image builder script), and its cluster
  health script: write the project's own when it has images or a cluster to watch.
- The throwaway portal for UI checks, its browser harnesses and its path-to-area map for the quick gate: they test
  that product. The project writes its own harnesses (see `docs/design/README.md`).
- The workspace-resource script (replaced by the portal) and the external supervisor script (replaced by the
  portal's Keep going).
- Every hard-coded name: namespaces, registry, repository URLs, image names, Argo CD application names.
