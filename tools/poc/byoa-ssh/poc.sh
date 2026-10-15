#!/usr/bin/env bash
# Bring-your-own-agent over SSH, the local POC of docs/prd/workspace-ssh.md (T-370). Docker only, no real credential anywhere:
# tokens and stand-in API keys are made at run time, the model APIs are stand-ins inside the container.
#   tools/poc/byoa-ssh/poc.sh up     build the image, start the workspace, two people (alice, bob), the bridge (the portal's stand-in)
#   tools/poc/byoa-ssh/poc.sh down   stop the bridge and remove the workspace container
# Then: ssh -F $POC_STATE/desk/alice/ssh_config poc-ws        (first time interactive: the consent)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
export POC_STATE=${POC_STATE:-/tmp/cp-poc-byoa}; BASE=${BASE:-claudepilot-workspace:cc-2.1.296}; CTR=cp-poc-ws
case "${1:-}" in
up)
  mkdir -p "$POC_STATE/state"
  sed "s|^FROM .*|FROM $BASE|" "$HERE/Dockerfile" | docker build -q -t cp-poc-ssh:1 - >/dev/null
  docker rm -f $CTR >/dev/null 2>&1 || true
  docker run -d --name $CTR --hostname poc-ws cp-poc-ssh:1 >/dev/null
  docker cp "$HERE/setup.sh" $CTR:/tmp/setup.sh && docker exec -u root $CTR bash /tmp/setup.sh
  # the model stand-ins: Anthropic (the canary's, apps/server/src/claudeversion/standin.ts) and OpenAI/Gemini (fake-llm.cjs)
  python3 - "$ROOT/apps/server/src/claudeversion/standin.ts" > "$POC_STATE/state/standin.cjs" <<'PY'
import sys; s=open(sys.argv[1]).read(); k='export const CANARY_STANDIN = String.raw`'; i=s.index(k)+len(k); print(s[i:s.index('`;',i)])
PY
  docker cp "$POC_STATE/state/standin.cjs" $CTR:/opt/standin.cjs; docker cp "$HERE/fake-llm.cjs" $CTR:/opt/fake-llm.cjs
  docker exec -u root $CTR sh -c 'mkdir -p /opt/standin /opt/fakellm; echo "{\"messages\":{\"text\":\"Hello from the stand-in model, through the tunnel.\",\"always\":true}}" > /opt/standin/script.json'
  docker exec -d -u root $CTR node /opt/standin.cjs /opt/standin; docker exec -d -u root $CTR node /opt/fake-llm.cjs /opt/fakellm 18080
  HK=$(docker exec -u root $CTR cut -d' ' -f1,2 /home/node/.claudepilot/ssh/host_ed25519_key.pub)
  cd "$POC_STATE" && node - <<'JS'
const fs=require('fs'),crypto=require('crypto'),cp=require('child_process'); const t={};
for (const p of ['alice','bob']) {
  fs.mkdirSync(`desk/${p}`,{recursive:true});
  if(!fs.existsSync(`desk/${p}/id_ed25519`)) cp.execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-C',`${p}@desktop`,'-f',`desk/${p}/id_ed25519`]);
  const tok='poc'+crypto.randomBytes(18).toString('base64url'); fs.writeFileSync(`desk/${p}/token`,tok,{mode:0o600});
  t[crypto.createHash('sha256').update(tok).digest('hex')]={person:p,workspace:'poc-ws',revoked:false};
}
fs.writeFileSync('state/tokens.json',JSON.stringify(t));
JS
  for p in alice bob; do echo "poc-ws $HK" > "desk/$p/known_hosts"; cat > "desk/$p/ssh_config" <<C
Host poc-ws
  User p-$p
  ProxyCommand env PILOT_URL=ws://127.0.0.1:7788 PILOT_TOKEN_FILE=$POC_STATE/desk/$p/token node $HERE/pilot-ssh.mjs %h
  HostKeyAlias poc-ws
  UserKnownHostsFile $POC_STATE/desk/$p/known_hosts
  StrictHostKeyChecking yes
  IdentityFile $POC_STATE/desk/$p/id_ed25519
  IdentitiesOnly yes
C
  done
  [ -f state/bridge.pid ] && kill "$(cat state/bridge.pid)" 2>/dev/null || true
  # `ws` from this checkout, or from the main checkout when this is a fresh git worktree without node_modules
  REQ=$ROOT/package.json; [ -d "$ROOT/node_modules/ws" ] || REQ=$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")/package.json
  POC_REQUIRE_FROM=$REQ nohup node "$HERE/bridge.mjs" > state/bridge.out 2>&1 & echo $! > state/bridge.pid; sleep 1; cat state/bridge.out
  echo "up: ssh -F $POC_STATE/desk/alice/ssh_config poc-ws   | admin: curl 127.0.0.1:7789/live, /revoke?person=bob" ;;
down)
  [ -f "$POC_STATE/state/bridge.pid" ] && kill "$(cat "$POC_STATE/state/bridge.pid")" 2>/dev/null || true
  docker rm -f $CTR >/dev/null 2>&1 || true; echo down ;;
*) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
