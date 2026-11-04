#!/usr/bin/env bash
# Deploys cp-jobrun-dispatcher to the KohiLabs Cloudflare account (T-3542). Run in a workspace whose Secrets pool delivers
# CF_RUNNER_API_TOKEN (the kohilabs workspace), from this folder, after `npm ci`:
#   deploy/cf-runner/deploy.sh <image tag> <workspace id> [--dry-run]
# 1. the R2 bucket cp-jobrun-artifacts (7-day lifecycle) when it is missing;
# 2. wrangler deploy with the image registry.cloudflare.com/<account>/cp-jobrun-runner:<tag> (built by scripts/image-build.sh, see README);
# 3. the Worker secret JOBRUN_KEYS = {"<workspace id>": HMAC-SHA256(CF_RUNNER_API_TOKEN, "cp-jobrun-key-v1\n<workspace id>")}, the same
#    key scripts/job-run-cf-client.mjs derives; the token itself never goes to the Worker. Values never on a command line or the terminal.
# Only names starting with cp-jobrun- are created. Refuses any other account.
set -euo pipefail
case $- in *x*) echo "deploy.sh: refuses to run under xtrace" >&2; exit 2 ;; esac
cd "$(dirname "$0")"
ACCOUNT=fccdbeb05cb96c17557497b18fe357b7 # KohiLabs (owner decision D1 for this slice)
tag=${1:?usage: deploy.sh <image tag> <workspace id> [--dry-run]}; ws=${2:?usage: deploy.sh <image tag> <workspace id> [--dry-run]}; dry=${3:-}
# A tag, or (pinned) sha256:<digest> as image-build.sh printed it: the image is then referenced by digest.
[[ ( $tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ && $tag != latest ) || $tag =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "deploy.sh: an image tag (not latest) or sha256:<digest>" >&2; exit 2; }
[[ $ws =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "deploy.sh: a workspace id" >&2; exit 2; }
[ -n "${CF_RUNNER_API_TOKEN:-}" ] || { echo "deploy.sh: CF_RUNNER_API_TOKEN is not set (the kohilabs Secrets pool delivers it)" >&2; exit 2; }
grep -q "\"account_id\": \"$ACCOUNT\"" wrangler.jsonc || { echo "deploy.sh: wrangler.jsonc is not on the KohiLabs account" >&2; exit 2; }
export CLOUDFLARE_API_TOKEN=$CF_RUNNER_API_TOKEN CLOUDFLARE_ACCOUNT_ID=$ACCOUNT WRANGLER_SEND_METRICS=false
W=(node node_modules/wrangler/bin/wrangler.js)
cfg=$(mktemp -d); trap 'rm -rf "$cfg"' EXIT
if [[ $tag == sha256:* ]]; then sed "s/:__IMAGE_TAG__/@$tag/g" wrangler.jsonc > "$cfg/wrangler.jsonc"; else sed "s/__IMAGE_TAG__/$tag/g" wrangler.jsonc > "$cfg/wrangler.jsonc"; fi
cp -R src "$cfg/src"; ln -s "$PWD/node_modules" "$cfg/node_modules"
if ! "${W[@]}" r2 bucket info cp-jobrun-artifacts >/dev/null 2>&1; then
  [ "$dry" = --dry-run ] && echo "would create R2 bucket cp-jobrun-artifacts" || "${W[@]}" r2 bucket create cp-jobrun-artifacts
fi
if [ "$dry" = --dry-run ]; then (cd "$cfg" && "${W[@]}" deploy --dry-run --outdir "$cfg/out"); exit 0; fi
"${W[@]}" r2 bucket lifecycle add cp-jobrun-artifacts cp-jobrun-7d --expire-days 7 --force >/dev/null 2>&1 || echo "deploy.sh: note: the 7-day lifecycle rule was not set (it may exist already)" >&2
# DEPLOY_VARS (optional): extra --var NAME:VALUE pairs for this deploy only (a temporary budget for a test), e.g. "BUDGET_USD_DAY:0.01".
vars=(); for v in ${DEPLOY_VARS:-}; do [[ $v =~ ^[A-Z_]+:[0-9.]+$ ]] || { echo "deploy.sh: DEPLOY_VARS: NAME:number pairs" >&2; exit 2; }; vars+=(--var "$v"); done
(cd "$cfg" && "${W[@]}" deploy ${vars[@]+"${vars[@]}"})
# The key, from the token, into the secret on stdin (wrangler reads a JSON object of secrets from a file).
node -e '
  const c = require("node:crypto"), fs = require("node:fs");
  const k = c.createHmac("sha256", process.env.CF_RUNNER_API_TOKEN).update("cp-jobrun-key-v1\n" + process.argv[1]).digest("hex");
  fs.writeFileSync(process.argv[2], JSON.stringify({ JOBRUN_KEYS: JSON.stringify({ [process.argv[1]]: k }) }), { mode: 0o600 });
' "$ws" "$cfg/secrets.json"
(cd "$cfg" && "${W[@]}" secret bulk "$cfg/secrets.json" >/dev/null) && echo "deploy.sh: JOBRUN_KEYS set for workspace $ws"
rm -f "$cfg/secrets.json"
