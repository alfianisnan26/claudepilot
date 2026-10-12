#!/bin/sh
# shellcheck disable=SC2016 # the single-quoted scripts are expanded by the sh in the container they run in, on purpose
# ClaudePilot Connect installer (docs/prd/targets-connect.md section 13). The same bytes for everyone: what varies comes from the plan the
# portal answers for your token. Read it before you run it; the portal shows its sha256.
#
#   curl -fsSL <portal>/connect/install.sh | PILOT_URL=<portal> PILOT_TOKEN=<token> sh
#   curl -fsSL <portal>/connect/install.sh | PILOT_URL=<portal> sh -s -- upgrade|uninstall [--purge]|doctor|status
#
# Environment: PILOT_URL, PILOT_TOKEN (never printed, never an argument: sent as a header through `curl --config -` and handed to the
# agent on stdin), PILOT_DRY_RUN=1 (show the plan and the commands, change nothing), PILOT_YES=1 (no questions), PILOT_NO_WAIT=1,
# PILOT_DEBUG=1 (trace, without the token), PILOT_CA (a PEM file: private CA), PILOT_HEADERS (`Name: value` lines, never printed),
# PILOT_BUILD_IMAGE (1: build the workspace image from the portal's context; 0: never), PILOT_DATA_DIR, PILOT_SERVICE
# (systemd|launchd|nohup|none), PILOT_NODE_MIRROR, PILOT_KUBE_CONTEXT, PILOT_TARGET and PILOT_KIND (which install upgrade/uninstall act on),
# PILOT_ALLOW_HTTP=1 (a plain-http lab portal), HTTPS_PROXY/NO_PROXY.
# Exit codes: 0 ok, 10 preflight, 11 portal unreachable, 12 token rejected, 13 download or checksum, 14 install, 15 not connected in
# time, 20 declined. The last line is PILOT_RESULT=connected|installed|removed|ok|failed|dry-run.
# POSIX sh only (dash, bash --posix and macOS /bin/sh run it). Plan values are read through a fixed allowlist, never eval'ed.

# Tracing goes off before anything touches the token; PILOT_DEBUG=1 (or sh -x) turns it back on afterwards.
case $- in *x*) _trace=1; set +x ;; *) _trace=0 ;; esac
[ "${PILOT_DEBUG:-}" = 1 ] && _trace=1
# Secrets leave the environment at once, so no child (docker, kubectl, the agent) inherits them.
_tok=${PILOT_TOKEN:-}
_hdrs=${PILOT_HEADERS:-}
_has_tok=0
_has_hdrs=0
[ -n "$_tok" ] && _has_tok=1
[ -n "$_hdrs" ] && _has_hdrs=1
unset PILOT_TOKEN PILOT_HEADERS
[ "$_trace" = 1 ] && set -x

set -u
LC_ALL=C
export LC_ALL
umask 022

# The bootstrap fetcher (src/connect/install/fetcher.ts; a test keeps this line equal to it).
FETCHER='const [u,h,o]=process.argv.slice(1),fs=require("fs"),p=require("path"),c=require("crypto");const die=(m)=>{console.error("fetch: "+m);process.exit(13)};if(!/^[0-9a-f]{64}$|^sha512-[A-Za-z0-9+\/]{86}==$/.test(h||"")||!u||!o)die("usage: <url> <sha256|sha512-integrity> <out>");const sum=(b)=>h.startsWith("sha512-")?"sha512-"+c.createHash("sha512").update(b).digest("base64"):c.createHash("sha256").update(b).digest("hex");try{if(sum(fs.readFileSync(o))===h)process.exit(0)}catch{}const hd={},hf=process.env.PILOT_HEADERS_FILE;if(hf)for(const l of fs.readFileSync(hf,"utf8").split(/\r?\n/)){const i=l.indexOf(":");if(i>0)hd[l.slice(0,i).trim()]=l.slice(i+1).trim()}let n="";try{n=new URL(u).pathname}catch{die("not an address")}fetch(u,{headers:hd,redirect:"follow"}).then(async(r)=>{if(!r.ok)die("HTTP "+r.status+" for "+n);const b=Buffer.from(await r.arrayBuffer());if(sum(b)!==h)die("checksum mismatch for "+n);fs.mkdirSync(p.dirname(o),{recursive:true});fs.writeFileSync(o+".tmp",b,{mode:0o644});fs.renameSync(o+".tmp",o)},(e)=>die("download failed for "+n+" ("+String((e&&e.cause&&e.cause.code)||(e&&e.message)||e)+")"));'

CDATA=/var/lib/claudepilot-agent
CAGENT=/opt/claudepilot-agent
DRY=${PILOT_DRY_RUN:-0}
YES=${PILOT_YES:-0}
WAIT_S=${PILOT_WAIT_SECONDS:-120}
POLL_S=${PILOT_POLL_SECONDS:-2}
URL=${PILOT_URL:-}
URL=${URL%/}
CMD=install
PURGE=0

# ---------------------------------------------------------------------------------------------------------------------------------
# Output, exits, running commands

say() { printf '%s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

_tmp=
cleanup() { [ -n "$_tmp" ] && rm -rf "$_tmp"; _tmp=; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

finish() { # <exit code> <result> : the last line is always PILOT_RESULT=
  cleanup
  printf 'PILOT_RESULT=%s\n' "$2"
  exit "$1"
}
die() { # <exit code> <message...>
  _dc=$1
  shift
  printf 'error: %s\n' "$*" >&2
  if [ "$_dc" = 20 ]; then finish 20 failed; fi
  finish "$_dc" failed
}

# Quiet sections: tracing off while a secret is expanded, back on after.
_qx=0
quiet() { case $- in *x*) _qx=1; set +x ;; *) _qx=0 ;; esac; }
unquiet() { if [ "$_qx" = 1 ]; then set -x; fi; }

show() { # prints a command the way it would be typed (the fetcher's text is shortened), on fd 3: the script's stdout even where the command's own output is captured or dropped
  _line=
  for _a in "$@"; do
    case $_a in
      "$FETCHER") _a='<fetcher>' ;;
      '' | *[!A-Za-z0-9._:/@,+=%{}-]*) _a="'$_a'" ;;
    esac
    _line="$_line $_a"
  done
  printf '  $%s\n' "$_line" >&3
}
run() { # say before doing; in a dry run, only say
  show "$@"
  [ "$DRY" = 1 ] && return 0
  "$@"
}
run_in() { # <file> <command...>: the file on stdin
  _ri=$1
  shift
  if [ "$1" = vol_sh ]; then # vol_sh says (and in a dry run skips) the docker command itself
    printf '    (stdin of the next: %s)\n' "${_ri##*/}" >&3
    if [ "$DRY" = 1 ]; then "$@" </dev/null; else "$@" <"$_ri"; fi
    return
  fi
  show "$@"
  printf '    (stdin: %s)\n' "${_ri##*/}" >&3
  [ "$DRY" = 1 ] && return 0
  "$@" <"$_ri"
}
run_tok() { # <command...>: the token on stdin, never in an argument or the environment
  show "$@"
  printf '    (stdin: the token)\n' >&3
  [ "$DRY" = 1 ] && return 0
  quiet
  printf '%s\n' "$_tok" | "$@"
  _rt=$?
  unquiet
  return $_rt
}

ask() { # <question>: yes, or exit 20. PILOT_YES=1 answers yes. Read from the terminal, not from the pipe this script came through.
  if [ "$YES" = 1 ]; then return 0; fi
  if [ "$DRY" = 1 ]; then say "(would ask: $1)"; return 0; fi
  if ! (: </dev/tty) 2>/dev/null; then die 20 "No terminal to ask on: $1 Set PILOT_YES=1 to answer yes."; fi
  printf '%s [yes/no] ' "$1" >/dev/tty
  read -r _ans </dev/tty || _ans=
  case $_ans in yes | YES | Yes) return 0 ;; esac
  die 20 "Declined."
}

usage() {
  say 'ClaudePilot installer: install (default) | upgrade | uninstall [--purge] | doctor | status'
  say 'Copy the command from the portal (Targets > Add): it sets PILOT_URL and PILOT_TOKEN.'
}

# ---------------------------------------------------------------------------------------------------------------------------------
# HTTP to the portal (curl reads its options, the token header included, from stdin: nothing secret in its arguments)

hdr_config() { # PILOT_HEADERS as curl config lines
  [ "$_has_hdrs" = 1 ] || return 0
  printf '%s\n' "$_hdrs" | tr -d '\r' | while IFS= read -r _h; do
    case $_h in *:*) ;; *) continue ;; esac
    printf 'header = "%s"\n' "$(printf '%s' "$_h" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  done
}

http_get() { # <url> <out file> [auth] : prints the HTTP status; returns curl's exit code
  quiet
  {
    if [ "${3:-}" = auth ]; then printf 'header = "Authorization: Bearer %s"\n' "$_tok"; fi
    hdr_config
  } | curl -sS --connect-timeout 10 --max-time 300 ${PILOT_CA:+--cacert "$PILOT_CA"} --config - -o "$2" -w '%{http_code}' "$1" 2>"$_tmp/curl.err"
  _hg=$?
  unquiet
  return $_hg
}

reason_of() { sed -n 's/.*"reason":"\([a-z_]*\)".*/\1/p' "$1" | head -n 1; }
message_of() { sed -n 's/.*"message":"\([^"]*\)".*/\1/p' "$1" | head -n 1; }

unreachable() { # <curl exit code>
  _ce=$(tr -d '\r' <"$_tmp/curl.err" | head -n 1)
  case $1 in
    60 | 77 | 35 | 51 | 58) die 11 "Can't trust $URL's certificate ($_ce). For a private CA use the portal's Private CA command (PILOT_CA)." ;;
  esac
  die 11 "Can't reach $URL ($_ce)."
}

health() {
  step "Portal $URL"
  _code=$(http_get "$URL/connect/v1/health" "$_tmp/health") || unreachable $?
  if [ "$_code" != 200 ] || ! grep -q '"ok":true' "$_tmp/health"; then
    die 11 "$URL didn't answer like a ClaudePilot portal (HTTP $_code). Check PILOT_URL, and that /connect/ is reachable from here."
  fi
}

# ---------------------------------------------------------------------------------------------------------------------------------
# Checks on the input

check_url() {
  [ -n "$URL" ] || die 10 "Set PILOT_URL to the portal's address (copy the command from the portal)."
  if ! printf '%s\n' "$URL" | grep -Eq '^https?://[A-Za-z0-9.:-]+$|^https?://\[[0-9A-Fa-f:.]+\](:[0-9]+)?$'; then
    die 10 "PILOT_URL must be the portal's address alone, like https://pilot.example.com."
  fi
  case $URL in
    https://*) return 0 ;;
  esac
  _hp=${URL#http://}
  case $_hp in
    \[*) _h=${_hp%%]*}; _h=${_h#[} ;;
    *) _h=${_hp%%:*} ;;
  esac
  case $_h in
    localhost | 127.* | ::1) return 0 ;;
  esac
  [ "${PILOT_ALLOW_HTTP:-}" = 1 ] || die 10 "Use https: plain http would send the token in the clear. (A lab portal with PORTAL_CONNECT_ALLOW_HTTP: the portal's command sets PILOT_ALLOW_HTTP=1.)"
}

check_token() {
  quiet
  _ok=0
  if printf '%s' "$_tok" | grep -Eq '^cpen_[A-Za-z0-9_-]{43}$'; then _ok=1; fi
  unquiet
  [ "$_ok" = 1 ] || die 12 "PILOT_TOKEN is missing or isn't a ClaudePilot token. Copy the command again from the portal."
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1; else shasum -a 256 "$1" | cut -d ' ' -f 1; fi
}

check_ca() {
  if [ -n "${PILOT_CA:-}" ]; then
    [ -r "$PILOT_CA" ] || die 10 "PILOT_CA ($PILOT_CA) isn't a readable file."
  fi
}

# ---------------------------------------------------------------------------------------------------------------------------------
# The plan: KEY=value lines, a fixed allowlist, a strict value pattern; anything else refuses the whole plan.

P_KIND='' P_ROLE='' P_TARGET='' P_NAME='' P_PLATFORM='' P_PORTAL='' P_PROTOCOL='' P_AGENT_BUILD='' P_AGENT_URL='' P_AGENT_SHA256='' P_NODE_IMAGE=''
P_NODE_VERSION='' P_NODE_SHA256_LINUX_X64='' P_NODE_SHA256_LINUX_ARM64='' P_NODE_SHA256_DARWIN_X64='' P_NODE_SHA256_DARWIN_ARM64=''
P_WORKSPACE_IMAGE='' P_IMAGES='' P_PTY_PACKAGE='' P_PTY_INTEGRITY='' P_PTY_INTEGRITY_LINUX_X64='' P_PTY_INTEGRITY_LINUX_ARM64=''
P_PTY_INTEGRITY_DARWIN_X64='' P_PTY_INTEGRITY_DARWIN_ARM64='' P_NAMESPACE='' P_STORAGE_CLASS='' P_STORAGE='' P_MAX_USES='' P_EXPIRES=''
P_HOST_ACK='' P_CA_SHA256='' P_ALLOW_HTTP='' P_TUNNEL=''

read_plan() { # <file> : returns 1 when the text is not a plan
  _first=1
  _seen=
  while IFS= read -r _l || [ -n "$_l" ]; do
    _l=${_l%"$(printf '\r')"}
    [ -z "$_l" ] && continue
    if [ "$_first" = 1 ]; then
      [ "$_l" = PILOT_PLAN=1 ] || return 1
      _first=0
    fi
    case $_l in *=*) ;; *) return 1 ;; esac
    _k=${_l%%=*}
    _v=${_l#*=}
    case $_k in '' | [!A-Z]* | *[!A-Z0-9_]*) return 1 ;; esac
    case $_v in *[!A-Za-z0-9._:/@,+=-]*) return 1 ;; esac
    case " $_seen " in *" $_k "*) continue ;; esac
    _seen="$_seen $_k"
    # shellcheck disable=SC2034 # every allowlisted key is read; not every kind uses every one
    case $_k in
      PILOT_KIND) P_KIND=$_v ;;
      PILOT_ROLE) P_ROLE=$_v ;;
      PILOT_TARGET) P_TARGET=$_v ;;
      PILOT_NAME) P_NAME=$_v ;;
      PILOT_PLATFORM) P_PLATFORM=$_v ;;
      PILOT_PORTAL) P_PORTAL=$_v ;;
      PILOT_TUNNEL) P_TUNNEL=$_v ;;
      PILOT_PROTOCOL) P_PROTOCOL=$_v ;;
      PILOT_AGENT_BUILD) P_AGENT_BUILD=$_v ;;
      PILOT_AGENT_URL) P_AGENT_URL=$_v ;;
      PILOT_AGENT_SHA256) P_AGENT_SHA256=$_v ;;
      PILOT_NODE_IMAGE) P_NODE_IMAGE=$_v ;;
      PILOT_NODE_VERSION) P_NODE_VERSION=$_v ;;
      PILOT_NODE_SHA256_LINUX_X64) P_NODE_SHA256_LINUX_X64=$_v ;;
      PILOT_NODE_SHA256_LINUX_ARM64) P_NODE_SHA256_LINUX_ARM64=$_v ;;
      PILOT_NODE_SHA256_DARWIN_X64) P_NODE_SHA256_DARWIN_X64=$_v ;;
      PILOT_NODE_SHA256_DARWIN_ARM64) P_NODE_SHA256_DARWIN_ARM64=$_v ;;
      PILOT_WORKSPACE_IMAGE) P_WORKSPACE_IMAGE=$_v ;;
      PILOT_IMAGES) P_IMAGES=$_v ;;
      PILOT_PTY_PACKAGE) P_PTY_PACKAGE=$_v ;;
      PILOT_PTY_INTEGRITY) P_PTY_INTEGRITY=$_v ;;
      PILOT_PTY_INTEGRITY_LINUX_X64) P_PTY_INTEGRITY_LINUX_X64=$_v ;;
      PILOT_PTY_INTEGRITY_LINUX_ARM64) P_PTY_INTEGRITY_LINUX_ARM64=$_v ;;
      PILOT_PTY_INTEGRITY_DARWIN_X64) P_PTY_INTEGRITY_DARWIN_X64=$_v ;;
      PILOT_PTY_INTEGRITY_DARWIN_ARM64) P_PTY_INTEGRITY_DARWIN_ARM64=$_v ;;
      PILOT_NAMESPACE) P_NAMESPACE=$_v ;;
      PILOT_STORAGE_CLASS) P_STORAGE_CLASS=$_v ;;
      PILOT_STORAGE) P_STORAGE=$_v ;;
      PILOT_MAX_USES) P_MAX_USES=$_v ;;
      PILOT_EXPIRES) P_EXPIRES=$_v ;;
      PILOT_HOST_ACK) P_HOST_ACK=$_v ;;
      PILOT_CA_SHA256) P_CA_SHA256=$_v ;;
      PILOT_ALLOW_HTTP) P_ALLOW_HTTP=$_v ;;
    esac
  done <"$1"
  [ "$_first" = 0 ]
}

check_plan() { # what every kind needs, in the shape it must have
  case $P_KIND in docker | swarm | kubernetes | container | host) ;; *) die 11 "The portal's plan names no kind this installer knows ($P_KIND). Is the portal newer? Use its install.sh." ;; esac
  printf '%s\n' "$P_TARGET" | grep -Eq '^[a-z]([a-z0-9-]*[a-z0-9])?$' || die 11 "The plan's target id isn't valid."
  printf '%s\n' "$P_AGENT_SHA256" | grep -Eq '^[0-9a-f]{64}$' || die 11 "The plan has no agent checksum."
  printf '%s\n' "$P_AGENT_BUILD" | grep -Eq '^[A-Za-z0-9._-]+$' || die 11 "The plan has no agent build."
  case $P_AGENT_URL in https://* | http://*) ;; *) die 11 "The plan has no agent address." ;; esac
  case $P_AGENT_URL in http://*) [ "$P_ALLOW_HTTP" = 1 ] || die 11 "The plan's agent address is plain http." ;; esac
  case $P_KIND in docker | swarm | kubernetes | container) [ -n "$P_NODE_IMAGE" ] || die 11 "The plan names no base image." ;; esac
  case $P_KIND in docker | swarm | container) [ -n "$P_WORKSPACE_IMAGE" ] || die 11 "The plan names no workspace image." ;; esac
  if [ -n "$P_CA_SHA256" ]; then
    [ -n "${PILOT_CA:-}" ] || die 10 "This portal uses a private CA: set PILOT_CA to its certificate (the portal's Private CA command does)."
    [ "$(sha256_of "$PILOT_CA")" = "$P_CA_SHA256" ] || die 10 "PILOT_CA isn't the certificate this portal uses."
  fi
}

print_plan() {
  say "Target $P_TARGET ($P_KIND, $P_ROLE, $P_PLATFORM), agent build $P_AGENT_BUILD"
  [ -n "$P_EXPIRES" ] && say "Token valid until $P_EXPIRES (${P_MAX_USES:-1} use(s))"
  return 0
}

fetch_plan() {
  step "Plan"
  _code=$(http_get "$URL/connect/v1/plan" "$_tmp/plan" auth) || unreachable $?
  case $_code in
    200) ;;
    401 | 403 | 409 | 422)
      _r=$(reason_of "$_tmp/plan")
      case $_r in
        token_used) repair_used_token ;;
        token_expired) die 12 "This command has expired. Make a new one in the portal." ;;
        token_revoked) die 12 "This command was revoked in the portal. Make a new one." ;;
        token_invalid) die 12 "The portal doesn't know this token. Copy the command again from the portal." ;;
        insecure_url) die 12 "The portal refuses this address: $(message_of "$_tmp/plan")" ;;
        *) die 12 "The portal refused the token (HTTP $_code${_r:+, $_r})." ;;
      esac
      ;;
    429) die 12 "Too many wrong tokens from this address. Wait ten minutes." ;;
    503) die 11 "The portal can't take enrollments right now (its store is locked). Try again once it is unlocked." ;;
    *) die 11 "The portal answered HTTP $_code for the plan." ;;
  esac
  read_plan "$_tmp/plan" || die 11 "$URL answered something that isn't a plan. Check PILOT_URL."
  check_plan
}

# A token that was used already (a re-run): the machine has the identity it made then, so continue with it and wait.
repair_used_token() {
  _code=$(http_get "$URL/connect/v1/enroll/status" "$_tmp/status" auth) || unreachable $?
  _t=$(sed -n 's/.*"target":"\([a-z0-9-]*\)".*/\1/p' "$_tmp/status" | head -n 1)
  if [ "$_code" = 200 ] && [ -n "$_t" ] && find_installs "$_t" && [ -n "$_found" ]; then
    say "This token was used already; $_t is installed here. Checking that it runs."
    P_TARGET=$_t
    # shellcheck disable=SC2086 # words of kind:name, split on purpose
    set -- $_found
    ensure_running "$1"
    wait_connected "$1"
  fi
  die 12 "This command was used already. Make a new one in the portal (Targets > the target > Command)."
}

# ---------------------------------------------------------------------------------------------------------------------------------
# Waiting for the portal to see the node

wait_for_connected() { # 0 connected, 1 not in time, 2 revoked
  step "Waiting for the portal to see it connected (up to ${WAIT_S}s)"
  _w=0
  while [ "$_w" -lt "$WAIT_S" ]; do
    if _code=$(http_get "$URL/connect/v1/enroll/status" "$_tmp/status" auth) && [ "$_code" = 200 ]; then
      _s=$(sed -n 's/.*"state":"\([a-z]*\)".*/\1/p' "$_tmp/status" | head -n 1)
      case $_s in
        connected) say "Connected."; return 0 ;;
        revoked) return 2 ;;
      esac
    fi
    sleep "$POLL_S"
    _w=$((_w + POLL_S))
  done
  return 1
}

wait_connected() { # [kind:name]
  if [ "$DRY" = 1 ]; then finish 0 dry-run; fi
  if [ "${PILOT_NO_WAIT:-}" = 1 ] || [ "$_has_tok" != 1 ]; then finish 0 installed; fi
  wait_for_connected
  not_connected $? "${1:-}"
}

not_connected() { # <wait result> [kind:name]
  case $1 in
    0) finish 0 connected ;;
    2) die 15 "The token was revoked while waiting." ;;
  esac
  say "Check it with: curl -fsSL $URL/connect/install.sh | PILOT_URL=$URL PILOT_TARGET=$P_TARGET sh -s -- doctor"
  case ${2:-} in docker:* | container:*) say "Its log: docker logs ${2#*:}" ;; esac
  die 15 "Installed, but the portal doesn't see it connected after ${WAIT_S}s."
}

# ---------------------------------------------------------------------------------------------------------------------------------
# Docker: shared by the docker, swarm and container kinds

SOCK=/var/run/docker.sock
DARCH=
need_docker() {
  command -v docker >/dev/null 2>&1 || die 10 "Docker isn't installed here (no docker command)."
  case ${DOCKER_HOST:-} in
    '') ;;
    unix://*) SOCK=${DOCKER_HOST#unix://} ;;
    *) die 10 "DOCKER_HOST points at $DOCKER_HOST: run this on the Docker host itself, with its local socket." ;;
  esac
  if ! _dv=$(docker version --format '{{.Server.Version}}' 2>"$_tmp/docker.err"); then
    if grep -qi 'permission denied' "$_tmp/docker.err"; then
      say "Docker refused this user (permission denied on its socket). Run the same command with sudo:"
      say "  curl -fsSL $URL/connect/install.sh | sudo env PILOT_URL=$URL PILOT_TOKEN=<the token> sh"
      die 10 "No access to the Docker socket."
    fi
    die 10 "Docker isn't running here (docker version failed: $(head -n 1 "$_tmp/docker.err"))."
  fi
  _info=$(docker info --format '{{.OSType}} {{.Architecture}} {{json .SecurityOptions}}' 2>/dev/null) || _info=
  case $_info in linux\ *) ;; *) die 10 "Docker runs Windows containers: switch Docker Desktop to Linux containers." ;; esac
  case $_info in *rootless*) die 10 "Rootless Docker isn't supported yet: use the system Docker daemon." ;; esac
  DARCH=$(docker version --format '{{.Server.Arch}}' 2>/dev/null)
  case $DARCH in amd64 | x86_64) DARCH=x64 ;; arm64 | aarch64) DARCH=arm64 ;; *) die 10 "Docker runs on $DARCH: only amd64 and arm64 are supported." ;; esac
  say "Docker $_dv ($DARCH)"
}

selinux_opt() {
  if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = Enforcing ]; then printf '%s' '--security-opt=label=disable'; fi
}

proxy_env() { # -e NAME for the proxy variables that are set (their values come from this environment, not the command line)
  for _p in HTTPS_PROXY https_proxy NO_PROXY no_proxy; do
    eval "_pv=\${$_p:-}"
    [ -n "$_pv" ] && printf ' -e %s' "$_p"
  done
  return 0
}

ensure_image() { # <ref>
  if docker image inspect "$1" >/dev/null 2>&1; then say "Image $1 is here."; return 0; fi
  run docker pull "$1"
}

ensure_workspace_image() {
  _img=$P_WORKSPACE_IMAGE
  if [ "${PILOT_BUILD_IMAGE:-}" != 1 ]; then
    if docker image inspect "$_img" >/dev/null 2>&1; then say "Image $_img is here."; return 0; fi
    if run docker pull "$_img"; then return 0; fi
    [ "${PILOT_BUILD_IMAGE:-}" = 0 ] && die 13 "Couldn't pull $_img."
    say "Couldn't pull $_img: building it from the portal's build context."
  fi
  step "Building $_img from $URL's build context"
  if [ "$DRY" != 1 ]; then
    _code=$(http_get "$URL/connect/v1/image/workspace/context.tgz" "$_tmp/context.tgz") || unreachable $?
    [ "$_code" = 200 ] || die 13 "The portal answered HTTP $_code for the image's build context."
  fi
  run_in "$_tmp/context.tgz" docker build -t "$_img" - || die 14 "Building $_img failed."
}

# Runs a small command in the node image with a volume mounted (writing files into the agent's volumes needs no host path).
vol_sh() { # <volume:path> <script> [args...] (stdin passed on)
  _vm=$1
  _vs=$2
  shift 2
  run docker run --rm -i -v "$_vm" --entrypoint sh "$P_NODE_IMAGE" -c "$_vs" sh "$@"
}

# The files the agent reads (no secret in agent.json; headers and the CA beside it).
agent_json() { # <mode> <data dir> <node name> [extra json]
  printf '{\n  "url": "%s",\n  "mode": "%s",\n  "nodeName": "%s",\n  "images": [%s]' "$P_PORTAL" "$1" "$3" "$(images_json)"
  [ -n "$P_NAMESPACE" ] && printf ',\n  "namespace": "%s"' "$P_NAMESPACE"
  case $P_PORTAL in http://*) printf ',\n  "allowHttp": true' ;; esac
  [ -n "${PILOT_CA:-}" ] && printf ',\n  "ca": "%s/ca.pem"' "$2"
  [ -n "${4:-}" ] && printf ',\n  %s' "$4"
  printf '\n}\n'
}
images_json() {
  [ -n "$P_IMAGES" ] || return 0
  printf '%s' "$P_IMAGES" | tr ',' '\n' | sed 's/.*/"&"/' | paste -s -d , -
}
json_esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

node_name() { # the plan's, else this machine's name, made safe
  if [ -n "$P_NAME" ]; then printf '%s' "$P_NAME"; return 0; fi
  uname -n 2>/dev/null | tr -c 'A-Za-z0-9.\n-' '-' | cut -c 1-60
}

put_secrets_in_volume() { # <volume> <dir in container>: the private CA and the extra headers, mode 0600 for the headers
  if [ -n "${PILOT_CA:-}" ]; then
    run_in "$PILOT_CA" vol_sh "$1:$2" 'mkdir -p "$1" && cat > "$1/ca.pem"' "$2" || die 14 "Couldn't write the CA into $1."
  fi
  if [ "$_has_hdrs" = 1 ]; then
    show docker run --rm -i -v "$1:$2" "$P_NODE_IMAGE" sh -c '<write headers, mode 0600>'
    if [ "$DRY" != 1 ]; then
      quiet
      printf '%s\n' "$_hdrs" | docker run --rm -i -v "$1:$2" --entrypoint sh "$P_NODE_IMAGE" -c 'umask 077 && mkdir -p "$1" && cat > "$1/headers"' sh "$2"
      _ph=$?
      unquiet
      [ "$_ph" = 0 ] || die 14 "Couldn't write the headers into $1."
    fi
  fi
}

fetch_in_volume() { # <mounts...> -- <url> <checksum> <out>: the fetcher in the node image
  _fv=
  while [ "$1" != -- ]; do
    _fv="$_fv -v $1"
    shift
  done
  shift
  _fenv=" -e NODE_USE_ENV_PROXY=1$(proxy_env)"
  [ -n "${PILOT_CA:-}" ] && _fenv="$_fenv -e NODE_EXTRA_CA_CERTS=$CDATA/ca.pem"
  [ "$_has_hdrs" = 1 ] && _fenv="$_fenv -e PILOT_HEADERS_FILE=$CDATA/headers"
  # shellcheck disable=SC2086 # the mounts and -e flags are words built above, none of them with spaces
  run docker run --rm $_fv $_fenv "$P_NODE_IMAGE" node -e "$FETCHER" "$1" "$2" "$3"
  _fr=$?
  [ "$_fr" = 0 ] || die 13 "Downloading or checking ${3##*/} failed."
}

enroll_in_container() { # <mounts...> -- <bundle path>
  _ev=
  while [ "$1" != -- ]; do
    _ev="$_ev -v $1"
    shift
  done
  shift
  _eenv=" -e PILOT_DATA_DIR=$CDATA -e NODE_USE_ENV_PROXY=1$(proxy_env)"
  [ -n "${PILOT_CA:-}" ] && _eenv="$_eenv -e NODE_EXTRA_CA_CERTS=$CDATA/ca.pem"
  step "Enrolling"
  # shellcheck disable=SC2086
  run_tok docker run --rm -i $_ev $_eenv "$P_NODE_IMAGE" node "$1" enroll --token-stdin
  enroll_result $?
}

enroll_result() {
  case $1 in
    0) return 0 ;;
    11) die 11 "The agent couldn't reach the portal to enroll." ;;
    12) die 12 "The portal refused the enrollment (see the line above)." ;;
    *) die 14 "Enrolling failed (exit $1)." ;;
  esac
}

container_state() { docker container inspect -f '{{.State.Status}}' "$1" 2>/dev/null; }

# Starts or restarts an existing container: restarted when the bundle it runs changed, started when stopped.
ensure_running() { # <kind:name>
  _n=${1#*:}
  case $1 in
    host:*) host_service_start; return 0 ;;
    swarm:* | kubernetes:*) return 0 ;;
  esac
  case $(container_state "$_n") in
    running) [ "${_changed:-0}" = 1 ] && run docker restart "$_n" >/dev/null ;;
    '') return 1 ;;
    *) run docker start "$_n" >/dev/null ;;
  esac
  return 0
}

stage_link() { # <volume:dir> <dir> <old build out var unused>: point current.mjs at the new build; prints the previous build
  vol_sh "$1" 'old=$(readlink "$1/current.mjs" 2>/dev/null); ln -sfn "bundle/$2/agent.mjs" "$1/current.mjs" && printf "%s\n" "$old"' "$2" "$P_AGENT_BUILD"
}

# ---------------------------------------------------------------------------------------------------------------------------------
# Kind: docker (a cluster of one Docker host; more hosts are more nodes)

install_docker() {
  need_docker
  _name=claudepilot-agent-$P_TARGET
  _vol=$_name
  step "Images"
  ensure_image "$P_NODE_IMAGE" || die 13 "Couldn't pull $P_NODE_IMAGE."
  ensure_workspace_image
  step "Agent bundle $P_AGENT_BUILD (sha256 checked before it runs)"
  put_secrets_in_volume "$_vol" "$CDATA"
  fetch_in_volume "$_vol:$CDATA" -- "$P_AGENT_URL" "$P_AGENT_SHA256" "$CDATA/bundle/$P_AGENT_BUILD/agent.mjs"
  agent_json docker "$CDATA" "$(node_name)" "\"dockerSocket\": \"/var/run/docker.sock\"" >"$_tmp/agent.json"
  run_in "$_tmp/agent.json" vol_sh "$_vol:$CDATA" 'cat > "$1/agent.json"' "$CDATA" || die 14 "Couldn't write agent.json."
  _old=$(stage_link "$_vol:$CDATA" "$CDATA")
  _changed=0
  [ "$_old" != "bundle/$P_AGENT_BUILD/agent.mjs" ] && _changed=1
  enroll_in_container "$_vol:$CDATA" -- "$CDATA/current.mjs"
  step "Agent container $_name"
  if [ -n "$(container_state "$_name")" ]; then
    ensure_running "docker:$_name"
  else
    _env=" -e PILOT_DATA_DIR=$CDATA -e NODE_USE_ENV_PROXY=1$(proxy_env)"
    [ -n "${PILOT_CA:-}" ] && _env="$_env -e NODE_EXTRA_CA_CERTS=$CDATA/ca.pem"
    # shellcheck disable=SC2086,SC2046
    run docker run -d --name "$_name" --restart unless-stopped --read-only --tmpfs /tmp --cap-drop ALL \
      --security-opt no-new-privileges $(selinux_opt) --memory 256m --pids-limit 256 \
      -v "$SOCK:/var/run/docker.sock" -v "$_vol:$CDATA" \
      --label claudepilot.connect=agent --label "claudepilot.connect.target=$P_TARGET" --label claudepilot.connect.kind=docker \
      $_env "$P_NODE_IMAGE" node "$CDATA/current.mjs" run >/dev/null || die 14 "Starting $_name failed."
  fi
  wait_connected "docker:$_name"
}

# ---------------------------------------------------------------------------------------------------------------------------------
# Kind: container (a single: the container is the workspace, the agent inside it, no Docker socket)

install_container() {
  need_docker
  _name=claudepilot-$P_TARGET
  _home=$_name-home
  _av=$_name-agent
  _sv=$_name-state
  case $DARCH in x64) _pi=$P_PTY_INTEGRITY_LINUX_X64 ;; *) _pi=$P_PTY_INTEGRITY_LINUX_ARM64 ;; esac
  [ -n "$P_PTY_PACKAGE" ] && [ -n "$P_PTY_INTEGRITY" ] && [ -n "$_pi" ] || die 11 "The plan has no pty package for linux-$DARCH."
  _pver=${P_PTY_PACKAGE##*@}
  _reg=${npm_config_registry:-https://registry.npmjs.org}
  _reg=${_reg%/}
  step "Images"
  ensure_image "$P_NODE_IMAGE" || die 13 "Couldn't pull $P_NODE_IMAGE."
  ensure_workspace_image
  step "Agent bundle $P_AGENT_BUILD and the pty package (checked before use)"
  put_secrets_in_volume "$_sv" "$CDATA"
  fetch_in_volume "$_av:$CAGENT" "$_sv:$CDATA" -- "$P_AGENT_URL" "$P_AGENT_SHA256" "$CAGENT/bundle/$P_AGENT_BUILD/agent.mjs"
  fetch_in_volume "$_av:$CAGENT" "$_sv:$CDATA" -- "$_reg/@lydell/node-pty/-/node-pty-$_pver.tgz" "$P_PTY_INTEGRITY" "$CAGENT/cache/node-pty-$_pver.tgz"
  fetch_in_volume "$_av:$CAGENT" "$_sv:$CDATA" -- "$_reg/@lydell/node-pty-linux-$DARCH/-/node-pty-linux-$DARCH-$_pver.tgz" "$_pi" "$CAGENT/cache/node-pty-linux-$DARCH-$_pver.tgz"
  vol_sh "$_av:$CAGENT" 'set -e; m="$1/node_modules/@lydell"; rm -rf "$m/node-pty" "$m/node-pty-linux-$3"; mkdir -p "$m/node-pty" "$m/node-pty-linux-$3"
tar -xzf "$1/cache/node-pty-$2.tgz" -C "$m/node-pty" --strip-components=1 --no-same-owner
tar -xzf "$1/cache/node-pty-linux-$3-$2.tgz" -C "$m/node-pty-linux-$3" --strip-components=1 --no-same-owner' "$CAGENT" "$_pver" "$DARCH" ||
    die 14 "Unpacking the pty package failed."
  agent_json container "$CDATA" "$(node_name)" >"$_tmp/agent.json"
  run_in "$_tmp/agent.json" vol_sh "$_sv:$CDATA" 'cat > "$1/agent.json"' "$CDATA" || die 14 "Couldn't write agent.json."
  _old=$(stage_link "$_av:$CAGENT" "$CAGENT")
  _changed=0
  [ "$_old" != "bundle/$P_AGENT_BUILD/agent.mjs" ] && _changed=1
  enroll_in_container "$_sv:$CDATA" "$_av:$CAGENT:ro" -- "$CAGENT/current.mjs"
  step "Workspace container $_name"
  if [ -n "$(container_state "$_name")" ]; then
    ensure_running "container:$_name"
  else
    _env=" -e PILOT_DATA_DIR=$CDATA -e NODE_USE_ENV_PROXY=1$(proxy_env)"
    [ -n "${PILOT_CA:-}" ] && _env="$_env -e NODE_EXTRA_CA_CERTS=$CDATA/ca.pem"
    # shellcheck disable=SC2086,SC2046
    run docker run -d --name "$_name" --hostname "$P_TARGET" --init --user 0:0 --restart unless-stopped $(selinux_opt) \
      -v "$_home:/home/node" -v "$_av:$CAGENT:ro" -v "$_sv:$CDATA" \
      --label claudepilot.connect=single --label "claudepilot.connect.target=$P_TARGET" --label claudepilot.connect.kind=container \
      $_env "$P_WORKSPACE_IMAGE" node "$CAGENT/current.mjs" run >/dev/null || die 14 "Starting $_name failed."
  fi
  wait_connected "container:$_name"
}

# ---------------------------------------------------------------------------------------------------------------------------------
# Kind: swarm (one global service on a manager; every node pulls the node image, checks the bundle and enrolls itself)

install_swarm() {
  need_docker
  _sw=$(docker info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}' 2>/dev/null)
  [ "$_sw" = 'active true' ] || die 10 "This isn't a swarm manager (docker info says: $_sw). Run it on a manager."
  _name=claudepilot-agent-$P_TARGET
  if docker service inspect "$_name" >/dev/null 2>&1; then
    say "Service $_name exists already."
    wait_connected "swarm:$_name"
  fi
  # The one exception to "the token never sits in an environment" (PRD section 10.1): the service's environment, for as long as the
  # nodes enroll; removed afterwards. Through a file, never an argument.
  umask 077
  quiet
  {
    printf 'PILOT_ENROLL_TOKEN=%s\n' "$_tok"
    printf 'PILOT_FETCHER=%s\n' "$FETCHER"
  } >"$_tmp/service.env"
  unquiet
  umask 022
  set -- --env "PILOT_URL=$P_PORTAL" --env PILOT_MODE=swarm --env "PILOT_DATA_DIR=$CDATA" --env "PILOT_IMAGES=$P_IMAGES" \
    --env "PILOT_BUNDLE_URL=$P_AGENT_URL" --env "PILOT_BUNDLE_SHA256=$P_AGENT_SHA256" --env NODE_USE_ENV_PROXY=1 \
    --env 'PILOT_NODE_NAME={{.Node.Hostname}}'
  case $P_PORTAL in http://*) set -- "$@" --env PILOT_ALLOW_HTTP=1 ;; esac
  step "Service $_name"
  run docker service create --detach --mode global --name "$_name" --env-file "$_tmp/service.env" "$@" \
    --mount "type=bind,src=$SOCK,dst=/var/run/docker.sock" --mount "type=volume,src=$_name,dst=$CDATA" \
    --mount type=tmpfs,dst=/tmp --read-only --cap-drop ALL --limit-memory 256M --restart-condition any \
    --label claudepilot.connect=agent --label "claudepilot.connect.target=$P_TARGET" --label claudepilot.connect.kind=swarm \
    --container-label claudepilot.connect=agent \
    "$P_NODE_IMAGE" sh -c 'node -e "$PILOT_FETCHER" "$PILOT_BUNDLE_URL" "$PILOT_BUNDLE_SHA256" "$PILOT_DATA_DIR/agent.mjs" && exec node "$PILOT_DATA_DIR/agent.mjs" run' >/dev/null ||
    die 14 "Creating the service failed."
  rm -f "$_tmp/service.env"
  [ "$DRY" = 1 ] && finish 0 dry-run
  # Wait for the first node, give the others a moment, then take the token out of the service (whatever happened).
  wait_for_connected
  _wr=$?
  [ "$_wr" = 0 ] && sleep "${PILOT_SWARM_SETTLE_SECONDS:-15}"
  run docker service update --detach --env-rm PILOT_ENROLL_TOKEN "$_name" >/dev/null || warn "Couldn't remove the token from the service: docker service update --env-rm PILOT_ENROLL_TOKEN $_name"
  not_connected "$_wr" "swarm:$_name"
}

# ---------------------------------------------------------------------------------------------------------------------------------
# Kind: kubernetes (one manifest; the cluster is shown and confirmed first)

KCTX=
kc() { kubectl --context "$KCTX" "$@"; }

kube_context() {
  command -v kubectl >/dev/null 2>&1 || die 10 "kubectl isn't installed here."
  KCTX=${PILOT_KUBE_CONTEXT:-$(kubectl config current-context 2>/dev/null)}
  [ -n "$KCTX" ] || die 10 "kubectl has no current context. Set PILOT_KUBE_CONTEXT."
  _server=$(kubectl config view --minify --context "$KCTX" -o 'jsonpath={.clusters[0].cluster.server}' 2>/dev/null)
  say "kubectl context: $KCTX"
  say "API server:      ${_server:-?}"
}

install_kubernetes() {
  kube_context
  _ns=${P_NAMESPACE:-claudepilot-workspaces}
  say "Namespace:       $_ns"
  ask "Apply the ClaudePilot agent to this cluster?"
  _nsx=0
  kc get namespace "$_ns" >/dev/null 2>&1 && _nsx=1
  step "Checking your rights (kubectl auth can-i)"
  _miss=
  set -- 'create serviceaccounts' 'create roles.rbac.authorization.k8s.io' 'create rolebindings.rbac.authorization.k8s.io' \
    'create secrets' 'create deployments.apps' 'create configmaps'
  for _c in "$@"; do
    # shellcheck disable=SC2086 # verb and resource are two words
    _a=$(kc auth can-i $_c -n "$_ns" 2>/dev/null)
    say "  $_c: ${_a:-no}"
    [ "$_a" = yes ] || _miss="$_miss, $_c"
  done
  if [ "$_nsx" = 0 ]; then
    _a=$(kc auth can-i create namespaces 2>/dev/null)
    say "  create namespaces: ${_a:-no}"
    [ "$_a" = yes ] || _miss="$_miss, create namespaces"
  fi
  [ -z "$_miss" ] || die 10 "Your kubectl user can't${_miss#,} in $_ns."
  step "Manifest"
  _code=$(http_get "$URL/connect/v1/manifest" "$_tmp/manifest.yaml" auth) || unreachable $?
  [ "$_code" = 200 ] || die 11 "The portal answered HTTP $_code for the manifest."
  if [ "$_nsx" = 1 ]; then
    # The Namespace is the first document: an existing namespace is left as it is.
    sed '1,/^---$/d' "$_tmp/manifest.yaml" >"$_tmp/apply.yaml"
  else
    cp "$_tmp/manifest.yaml" "$_tmp/apply.yaml"
  fi
  say "  $(grep -c '^kind:' "$_tmp/apply.yaml") objects: $(sed -n 's/^kind: //p' "$_tmp/apply.yaml" | paste -s -d ' ' -)"
  if [ "$_has_hdrs" = 1 ]; then
    quiet
    printf '%s\n' "$_hdrs" >"$_tmp/headers"
    unquiet
    run kc -n "$_ns" create secret generic claudepilot-agent-headers --from-file="headers=$_tmp/headers" --dry-run=client -o yaml >"$_tmp/headers.yaml"
    run_in "$_tmp/headers.yaml" kc apply -f - || die 14 "kubectl apply of the headers Secret failed."
  fi
  run_in "$_tmp/apply.yaml" kc apply -f - || die 14 "kubectl apply failed."
  run kc -n "$_ns" label secret claudepilot-agent-enroll claudepilot.connect/token=used --overwrite >/dev/null 2>&1 || :
  run kc -n "$_ns" rollout status deployment/claudepilot-agent --timeout=120s || die 14 "The agent's Deployment didn't roll out (kubectl -n $_ns describe deployment claudepilot-agent)."
  wait_connected "kubernetes:$_ns"
}

# ---------------------------------------------------------------------------------------------------------------------------------
# Kind: host (a single: this machine, as this user, no isolation). Linux; macOS is a preview.

HOS='' HARCH='' NODE='' HDIR=''
host_paths() {
  HDIR=${PILOT_DATA_DIR:-$HOME/.claudepilot/agent}
  case $(uname -s) in Linux) HOS=linux ;; Darwin) HOS=darwin ;; *) die 10 "The host kind runs on Linux and macOS (Windows: inside WSL2)." ;; esac
  case $(uname -m) in x86_64 | amd64) HARCH=x64 ;; aarch64 | arm64) HARCH=arm64 ;; *) die 10 "Unsupported CPU $(uname -m)." ;; esac
}

node_ok() { # <node binary>: Node 22.13 or newer
  _nv=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  _maj=${_nv%%.*}
  _rest=${_nv#*.}
  _min=${_rest%%.*}
  [ "$_maj" -gt 22 ] 2>/dev/null && return 0
  [ "$_maj" = 22 ] && [ "$_min" -ge 13 ] 2>/dev/null
}

host_node() {
  if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
    NODE=$(command -v node)
    say "Node $("$NODE" -p 'process.versions.node') at $NODE"
    return 0
  fi
  NODE=$HDIR/node/bin/node
  if [ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node' 2>/dev/null)" = "$P_NODE_VERSION" ]; then
    say "Node $P_NODE_VERSION at $NODE"
    return 0
  fi
  case $HOS-$HARCH in
    linux-x64) _ns=$P_NODE_SHA256_LINUX_X64 ;;
    linux-arm64) _ns=$P_NODE_SHA256_LINUX_ARM64 ;;
    darwin-x64) _ns=$P_NODE_SHA256_DARWIN_X64 ;;
    *) _ns=$P_NODE_SHA256_DARWIN_ARM64 ;;
  esac
  [ -n "$P_NODE_VERSION" ] && [ -n "$_ns" ] || die 11 "The plan pins no Node.js for $HOS-$HARCH."
  _f=node-v$P_NODE_VERSION-$HOS-$HARCH.tar.gz
  _m=${PILOT_NODE_MIRROR:-https://nodejs.org/dist}
  step "Node.js $P_NODE_VERSION (sha256 pinned by the portal)"
  show curl -fsSL "${_m%/}/v$P_NODE_VERSION/$_f" -o "$_tmp/$_f"
  if [ "$DRY" != 1 ]; then
    curl -fsSL --connect-timeout 10 ${PILOT_CA:+--cacert "$PILOT_CA"} "${_m%/}/v$P_NODE_VERSION/$_f" -o "$_tmp/$_f" || die 13 "Downloading $_f failed."
    [ "$(sha256_of "$_tmp/$_f")" = "$_ns" ] || die 13 "$_f doesn't have the sha256 the portal pins."
  fi
  run rm -rf "$HDIR/node.new"
  run mkdir -p "$HDIR/node.new"
  run tar -xzf "$_tmp/$_f" -C "$HDIR/node.new" --strip-components=1 || die 14 "Unpacking Node.js failed."
  run rm -rf "$HDIR/node"
  run mv "$HDIR/node.new" "$HDIR/node"
}

host_fetch() { # <url> <checksum> <out>
  _henv="NODE_USE_ENV_PROXY=1"
  [ -n "${PILOT_CA:-}" ] && _henv="$_henv NODE_EXTRA_CA_CERTS=$HDIR/ca.pem"
  [ "$_has_hdrs" = 1 ] && _henv="$_henv PILOT_HEADERS_FILE=$HDIR/headers"
  # shellcheck disable=SC2086
  run env $_henv "$NODE" -e "$FETCHER" "$1" "$2" "$3" || die 13 "Downloading or checking ${3##*/} failed."
}

host_tools() {
  _missing=
  _tools='tmux git bash'
  [ "$HOS" = darwin ] && _tools="$_tools jq flock setsid"
  for _t in $_tools; do command -v "$_t" >/dev/null 2>&1 || _missing="$_missing $_t"; done
  if [ -n "$_missing" ]; then
    [ "$HOS" = darwin ] && say "Homebrew: brew install tmux jq util-linux"
    die 10 "Missing on this machine:$_missing. Install them, then run the command again."
  fi
}

host_consent() {
  [ "$P_HOST_ACK" = 1 ] || die 10 "This target wasn't made with host access confirmed in the portal."
  say ""
  say "This gives the portal at $P_PORTAL a shell as $(id -un) on this machine, and read and write access to $(id -un)'s files."
  say "There is no isolation."
  if [ "$YES" = 1 ]; then say "(PILOT_YES=1: accepted)"; return 0; fi
  if [ "$DRY" = 1 ]; then say "(would ask: type yes to continue)"; return 0; fi
  if ! (: </dev/tty) 2>/dev/null; then die 20 "No terminal to ask on. Run it in a terminal, or set PILOT_YES=1 deliberately."; fi
  printf 'Type yes to continue: ' >/dev/tty
  read -r _ans </dev/tty || _ans=
  [ "$_ans" = yes ] || die 20 "Declined."
}

install_host() {
  host_paths
  if [ "$(id -u)" = 0 ] && [ "${PILOT_ALLOW_ROOT:-}" != 1 ]; then die 10 "Run this as the user whose shell the portal should get, not root."; fi
  host_tools
  host_consent
  run mkdir -p "$HDIR/logs" "$HDIR/versions"
  [ "$DRY" = 1 ] || chmod 700 "$HDIR"
  if [ -n "${PILOT_CA:-}" ]; then run cp "$PILOT_CA" "$HDIR/ca.pem"; fi
  if [ "$_has_hdrs" = 1 ]; then
    show "<write $HDIR/headers, mode 0600>"
    if [ "$DRY" != 1 ]; then
      quiet
      (umask 077 && printf '%s\n' "$_hdrs" >"$HDIR/headers")
      unquiet
    fi
  fi
  host_node
  step "Agent bundle $P_AGENT_BUILD and the pty package (checked before use)"
  host_fetch "$P_AGENT_URL" "$P_AGENT_SHA256" "$HDIR/versions/$P_AGENT_BUILD/agent.mjs"
  case $HOS-$HARCH in
    linux-x64) _pi=$P_PTY_INTEGRITY_LINUX_X64 ;;
    linux-arm64) _pi=$P_PTY_INTEGRITY_LINUX_ARM64 ;;
    darwin-x64) _pi=$P_PTY_INTEGRITY_DARWIN_X64 ;;
    *) _pi=$P_PTY_INTEGRITY_DARWIN_ARM64 ;;
  esac
  [ -n "$P_PTY_PACKAGE" ] && [ -n "$P_PTY_INTEGRITY" ] && [ -n "$_pi" ] || die 11 "The plan has no pty package for $HOS-$HARCH."
  _pver=${P_PTY_PACKAGE##*@}
  _reg=${npm_config_registry:-https://registry.npmjs.org}
  _reg=${_reg%/}
  _m=$HDIR/node_modules/@lydell
  if grep -q "\"version\": \"$_pver\"" "$_m/node-pty/package.json" 2>/dev/null && [ -d "$_m/node-pty-$HOS-$HARCH" ]; then
    say "pty package $_pver is here."
  else
    host_fetch "$_reg/@lydell/node-pty/-/node-pty-$_pver.tgz" "$P_PTY_INTEGRITY" "$HDIR/cache/node-pty-$_pver.tgz"
    host_fetch "$_reg/@lydell/node-pty-$HOS-$HARCH/-/node-pty-$HOS-$HARCH-$_pver.tgz" "$_pi" "$HDIR/cache/node-pty-$HOS-$HARCH-$_pver.tgz"
    run rm -rf "$_m/node-pty" "$_m/node-pty-$HOS-$HARCH"
    run mkdir -p "$_m/node-pty" "$_m/node-pty-$HOS-$HARCH"
    run tar -xzf "$HDIR/cache/node-pty-$_pver.tgz" -C "$_m/node-pty" --strip-components=1 || die 14 "Unpacking the pty package failed."
    run tar -xzf "$HDIR/cache/node-pty-$HOS-$HARCH-$_pver.tgz" -C "$_m/node-pty-$HOS-$HARCH" --strip-components=1 || die 14 "Unpacking the pty package failed."
  fi
  agent_json host "$HDIR" "$(node_name)" "\"home\": \"$(json_esc "$HOME")\"" >"$_tmp/agent.json"
  run cp "$_tmp/agent.json" "$HDIR/agent.json"
  _old=$(readlink "$HDIR/current" 2>/dev/null || :)
  _changed=0
  [ "$_old" != "versions/$P_AGENT_BUILD" ] && _changed=1
  run ln -sfn "versions/$P_AGENT_BUILD" "$HDIR/current"
  step "Enrolling"
  _hev="PILOT_DATA_DIR=$HDIR NODE_USE_ENV_PROXY=1"
  [ -n "${PILOT_CA:-}" ] && _hev="$_hev NODE_EXTRA_CA_CERTS=$HDIR/ca.pem"
  # shellcheck disable=SC2086
  run_tok env $_hev "$NODE" "$HDIR/current/agent.mjs" enroll --token-stdin
  enroll_result $?
  host_service_install
  wait_connected "host:$HDIR"
}

host_service_kind() {
  if [ -n "${PILOT_SERVICE:-}" ]; then printf '%s' "$PILOT_SERVICE"; return 0; fi
  if [ "$HOS" = darwin ]; then printf launchd; return 0; fi
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then printf systemd; return 0; fi
  printf nohup
}

UNIT=claudepilot-agent.service
PLIST_ID=com.claudepilot.agent
host_service_install() {
  _svc=$(host_service_kind)
  _env="PILOT_DATA_DIR=$HDIR"
  step "Keeping it running ($_svc)"
  case $_svc in
    systemd)
      _ud=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
      {
        printf '[Unit]\nDescription=ClaudePilot agent (%s)\nAfter=network-online.target\nWants=network-online.target\n\n' "$P_TARGET"
        printf '[Service]\nExecStart=%s %s/current/agent.mjs run\nEnvironment=PILOT_DATA_DIR=%s\nEnvironment=NODE_USE_ENV_PROXY=1\n' "$NODE" "$HDIR" "$HDIR"
        [ -n "${PILOT_CA:-}" ] && printf 'Environment=NODE_EXTRA_CA_CERTS=%s/ca.pem\n' "$HDIR"
        for _p in HTTPS_PROXY NO_PROXY; do
          eval "_pv=\${$_p:-}"
          [ -n "$_pv" ] && printf 'Environment=%s=%s\n' "$_p" "$_pv"
        done
        printf 'Restart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n'
      } >"$_tmp/unit"
      run mkdir -p "$_ud"
      run cp "$_tmp/unit" "$_ud/$UNIT"
      run systemctl --user daemon-reload
      run systemctl --user enable --now "$UNIT" || die 14 "systemctl --user enable --now $UNIT failed."
      [ "$_changed" = 1 ] && run systemctl --user restart "$UNIT"
      if [ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null)" != yes ]; then
        run loginctl enable-linger "$(id -un)" 2>/dev/null || say "To keep it running after you log out: sudo loginctl enable-linger $(id -un)"
      fi
      ;;
    launchd)
      _pl=$HOME/Library/LaunchAgents/$PLIST_ID.plist
      {
        printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        printf '<plist version="1.0"><dict>\n<key>Label</key><string>%s</string>\n' "$PLIST_ID"
        printf '<key>ProgramArguments</key><array><string>%s</string><string>%s/current/agent.mjs</string><string>run</string></array>\n' "$NODE" "$HDIR"
        printf '<key>EnvironmentVariables</key><dict><key>PILOT_DATA_DIR</key><string>%s</string><key>NODE_USE_ENV_PROXY</key><string>1</string></dict>\n' "$HDIR"
        printf '<key>KeepAlive</key><true/>\n<key>RunAtLoad</key><true/>\n'
        printf '<key>StandardOutPath</key><string>%s/logs/launchd.out</string>\n<key>StandardErrorPath</key><string>%s/logs/launchd.out</string>\n</dict></plist>\n' "$HDIR" "$HDIR"
      } >"$_tmp/plist"
      run mkdir -p "$HOME/Library/LaunchAgents"
      run cp "$_tmp/plist" "$_pl"
      run launchctl bootout "gui/$(id -u)/$PLIST_ID" 2>/dev/null || :
      run launchctl bootstrap "gui/$(id -u)" "$_pl" || die 14 "launchctl bootstrap failed."
      ;;
    nohup)
      {
        printf '#!/bin/sh\n# Starts the ClaudePilot agent in the background (written by install.sh). Run it again after a reboot.\n'
        printf 'export PILOT_DATA_DIR=%s NODE_USE_ENV_PROXY=1\n' "'$HDIR'"
        [ -n "${PILOT_CA:-}" ] && printf 'export NODE_EXTRA_CA_CERTS=%s\n' "'$HDIR/ca.pem'"
        printf 'if [ -f "$PILOT_DATA_DIR/agent.pid" ] && kill -0 "$(cat "$PILOT_DATA_DIR/agent.pid")" 2>/dev/null; then exit 0; fi\n'
        printf 'nohup %s "$PILOT_DATA_DIR/current/agent.mjs" run >>"$PILOT_DATA_DIR/logs/agent.out" 2>&1 </dev/null &\n' "'$NODE'"
        printf 'echo $! >"$PILOT_DATA_DIR/agent.pid"\n'
      } >"$_tmp/start.sh"
      run cp "$_tmp/start.sh" "$HDIR/start.sh"
      run chmod 755 "$HDIR/start.sh"
      [ "$_changed" = 1 ] && host_stop_nohup
      run "$HDIR/start.sh"
      say "After a reboot, start it again with: $HDIR/start.sh"
      ;;
    none)
      say "Start it yourself with:"
      say "  PILOT_DATA_DIR=$HDIR $NODE $HDIR/current/agent.mjs run"
      [ "$DRY" = 1 ] && finish 0 dry-run
      finish 0 installed
      ;;
    *) die 10 "PILOT_SERVICE must be systemd, launchd, nohup or none." ;;
  esac
}

host_stop_nohup() {
  if [ -f "$HDIR/agent.pid" ]; then
    _pid=$(cat "$HDIR/agent.pid" 2>/dev/null)
    [ -n "$_pid" ] && run kill "$_pid" 2>/dev/null
    run rm -f "$HDIR/agent.pid"
  fi
  return 0
}

host_service_start() { # (re)start whatever keeps the host agent running
  if [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT" ]; then
    run systemctl --user restart "$UNIT"
  elif [ -f "$HOME/Library/LaunchAgents/$PLIST_ID.plist" ]; then
    run launchctl kickstart -k "gui/$(id -u)/$PLIST_ID"
  elif [ -x "$HDIR/start.sh" ]; then
    [ "${_changed:-0}" = 1 ] && host_stop_nohup
    run "$HDIR/start.sh"
  fi
  return 0
}

host_service_remove() {
  _uf=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT
  if [ -f "$_uf" ]; then
    run systemctl --user disable --now "$UNIT" 2>/dev/null
    run rm -f "$_uf"
    run systemctl --user daemon-reload 2>/dev/null
  fi
  _pl=$HOME/Library/LaunchAgents/$PLIST_ID.plist
  if [ -f "$_pl" ]; then
    run launchctl bootout "gui/$(id -u)/$PLIST_ID" 2>/dev/null
    run rm -f "$_pl"
  fi
  host_stop_nohup
}

# ---------------------------------------------------------------------------------------------------------------------------------
# What is installed here (for upgrade, uninstall, doctor, status and a re-run with a used token): "kind:name" words in $_found.

_found=
find_installs() { # [target]: fills $_found; Kubernetes only when PILOT_KIND=kubernetes (it means a cluster context)
  _ft=${1:-${PILOT_TARGET:-}}
  _fk=${PILOT_KIND:-}
  _found=
  if [ -z "$_fk" ] || [ "$_fk" = host ]; then
    _hd=${PILOT_DATA_DIR:-$HOME/.claudepilot/agent}
    if [ -f "$_hd/agent.json" ] && { [ -z "$_ft" ] || grep -q "\"target\": *\"$_ft\"" "$_hd/identity.json" 2>/dev/null || [ "$_fk" = host ]; }; then
      _found="$_found host:$_hd"
    fi
  fi
  if command -v docker >/dev/null 2>&1 && docker version >/dev/null 2>&1; then
    _lf="label=claudepilot.connect.target${_ft:+=$_ft}"
    if [ -z "$_fk" ] || [ "$_fk" = docker ] || [ "$_fk" = container ]; then
      for _c in $(docker ps -a --filter "$_lf" --format '{{.Label "claudepilot.connect.kind"}}:{{.Names}}' 2>/dev/null); do
        case $_c in docker:* | container:*) [ -z "$_fk" ] || [ "${_c%%:*}" = "$_fk" ] && _found="$_found $_c" ;; esac
      done
    fi
    if [ -z "$_fk" ] || [ "$_fk" = swarm ]; then
      for _c in $(docker service ls --filter "$_lf" --format '{{.Name}}' 2>/dev/null); do _found="$_found swarm:$_c"; done
    fi
  fi
  if [ "$_fk" = kubernetes ]; then
    kube_context
    for _c in $(kc get deployments -A -l "app.kubernetes.io/part-of=claudepilot-connect${_ft:+,claudepilot.connect/target=$_ft}" -o 'jsonpath={range .items[*]}{.metadata.namespace}{"\n"}{end}' 2>/dev/null); do
      _found="$_found kubernetes:$_c"
    done
  fi
  _found=${_found# }
  return 0
}

one_install() { # exactly one, or say which ones and stop
  find_installs
  [ -n "$_found" ] || die 10 "Nothing of ClaudePilot's is installed here${PILOT_TARGET:+ for $PILOT_TARGET}${PILOT_KIND:+ ($PILOT_KIND)}."
  # shellcheck disable=SC2086 # words of kind:name, split on purpose
  set -- $_found
  if [ $# -gt 1 ]; then
    say "Installed here: $_found"
    die 10 "More than one install: set PILOT_TARGET (and PILOT_KIND) to pick one."
  fi
  _one=$1
}

target_of() { # <kind:name>: the target id
  case $1 in
    docker:*) printf '%s' "${1#docker:claudepilot-agent-}" ;;
    container:*) printf '%s' "${1#container:claudepilot-}" ;;
    swarm:*) printf '%s' "${1#swarm:claudepilot-agent-}" ;;
    *) printf '%s' "${PILOT_TARGET:-}" ;;
  esac
}

volume_of() { # <kind:name>: the volume (and mount point) holding the bundle and agent.json
  case $1 in
    docker:*) printf '%s' "${1#docker:}:$CDATA" ;;
    container:*) printf '%s' "${1#container:}-state:$CDATA" ;;
  esac
}

portal_of() { # <kind:name>: PILOT_URL, else what agent.json says
  if [ -n "$URL" ]; then printf '%s' "$URL"; return 0; fi
  case $1 in
    host:*) sed -n 's/.*"url": *"\([^"]*\)".*/\1/p' "${1#host:}/agent.json" | head -n 1 ;;
    docker:* | container:*)
      _img=$(docker container inspect -f '{{.Config.Image}}' "${1#*:}" 2>/dev/null)
      [ "${1%%:*}" = container ] && _img=${PILOT_NODE_IMAGE:-node:22-bookworm-slim}
      docker run --rm -v "$(volume_of "$1")" --entrypoint sh "$_img" -c 'sed -n "s/.*\"url\": *\"\([^\"]*\)\".*/\1/p" "$1/agent.json"' sh "$CDATA" 2>/dev/null | head -n 1
      ;;
    swarm:*) docker service inspect -f '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' "${1#swarm:}" 2>/dev/null | sed -n 's/^PILOT_URL=//p' | head -n 1 ;;
    kubernetes:*) kc -n "${1#kubernetes:}" get deployment claudepilot-agent -o 'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="PILOT_URL")].value}' 2>/dev/null ;;
  esac
}

# ---------------------------------------------------------------------------------------------------------------------------------
# upgrade: the bundle the portal serves now (latest.json), checked, then a restart. The previous build stays on disk. No token.

cmd_upgrade() {
  one_install
  P_TARGET=$(target_of "$_one")
  URL=$(portal_of "$_one")
  URL=${URL%/}
  [ -n "$URL" ] || die 10 "Set PILOT_URL: the portal's address isn't recorded for $_one."
  check_url
  check_ca
  health
  _code=$(http_get "$URL/connect/v1/agent/latest.json" "$_tmp/latest.json") || unreachable $?
  [ "$_code" = 200 ] || die 11 "The portal answered HTTP $_code for latest.json."
  P_AGENT_BUILD=$(sed -n 's/.*"build":"\([A-Za-z0-9._-]*\)".*/\1/p' "$_tmp/latest.json")
  P_AGENT_SHA256=$(sed -n 's/.*"sha256":"\([0-9a-f]\{64\}\)".*/\1/p' "$_tmp/latest.json")
  _path=$(sed -n 's/.*"url":"\([A-Za-z0-9._:\/@-]*\)".*/\1/p' "$_tmp/latest.json")
  [ -n "$P_AGENT_BUILD" ] && [ -n "$P_AGENT_SHA256" ] && [ -n "$_path" ] || die 11 "latest.json isn't what this installer expects."
  case $_path in http://* | https://*) P_AGENT_URL=$_path ;; *) P_AGENT_URL=$URL$_path ;; esac
  case $P_AGENT_URL in http://*) P_ALLOW_HTTP=1 ;; esac
  step "Upgrading $_one to build $P_AGENT_BUILD"
  _changed=1
  case $_one in
    docker:* | container:*)
      need_docker
      _n=${_one#*:}
      P_NODE_IMAGE=${PILOT_NODE_IMAGE:-$(docker container inspect -f '{{.Config.Image}}' "$_n")}
      [ "${_one%%:*}" = container ] && P_NODE_IMAGE=${PILOT_NODE_IMAGE:-node:22-bookworm-slim}
      if [ "${_one%%:*}" = docker ]; then
        fetch_in_volume "$_n:$CDATA" -- "$P_AGENT_URL" "$P_AGENT_SHA256" "$CDATA/bundle/$P_AGENT_BUILD/agent.mjs"
        _old=$(stage_link "$_n:$CDATA" "$CDATA")
      else
        fetch_in_volume "$_n-agent:$CAGENT" "$_n-state:$CDATA" -- "$P_AGENT_URL" "$P_AGENT_SHA256" "$CAGENT/bundle/$P_AGENT_BUILD/agent.mjs"
        _old=$(stage_link "$_n-agent:$CAGENT" "$CAGENT")
      fi
      [ "$_old" = "bundle/$P_AGENT_BUILD/agent.mjs" ] && _changed=0
      if [ "$_changed" = 1 ]; then run docker restart "$_n" >/dev/null || die 14 "docker restart $_n failed."; else say "Already at $P_AGENT_BUILD."; fi
      ;;
    swarm:*)
      need_docker
      run docker service update --detach --env-add "PILOT_BUNDLE_URL=$P_AGENT_URL" --env-add "PILOT_BUNDLE_SHA256=$P_AGENT_SHA256" --force "${_one#swarm:}" >/dev/null ||
        die 14 "docker service update failed."
      ;;
    kubernetes:*)
      _ns=${_one#kubernetes:}
      ask "Upgrade the agent in $_ns on context $KCTX?"
      run kc -n "$_ns" set env deployment/claudepilot-agent -c fetch "PILOT_BUNDLE_URL=$P_AGENT_URL" "PILOT_BUNDLE_SHA256=$P_AGENT_SHA256" >/dev/null || die 14 "kubectl set env failed."
      run kc -n "$_ns" set env deployment/claudepilot-agent -c agent "PILOT_BUNDLE_URL=$P_AGENT_URL" "PILOT_BUNDLE_SHA256=$P_AGENT_SHA256" >/dev/null || die 14 "kubectl set env failed."
      run kc -n "$_ns" rollout status deployment/claudepilot-agent --timeout=120s || die 14 "The rollout didn't finish."
      ;;
    host:*)
      HDIR=${_one#host:}
      host_paths
      HDIR=${_one#host:}
      NODE=$(sed -n 's/^ExecStart=\([^ ]*\) .*/\1/p' "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT" 2>/dev/null)
      [ -x "$NODE" ] || NODE=$HDIR/node/bin/node
      [ -x "$NODE" ] || NODE=$(command -v node)
      [ -n "${PILOT_CA:-}" ] && [ ! -f "$HDIR/ca.pem" ] && run cp "$PILOT_CA" "$HDIR/ca.pem"
      [ -f "$HDIR/headers" ] && _has_hdrs=1
      host_fetch "$P_AGENT_URL" "$P_AGENT_SHA256" "$HDIR/versions/$P_AGENT_BUILD/agent.mjs"
      [ "$(readlink "$HDIR/current" 2>/dev/null)" = "versions/$P_AGENT_BUILD" ] && _changed=0
      run ln -sfn "versions/$P_AGENT_BUILD" "$HDIR/current"
      if [ -n "${PILOT_URL:-}" ]; then
        run "$NODE" -e 'const f=process.argv[1],fs=require("fs"),j=JSON.parse(fs.readFileSync(f,"utf8"));j.url=process.argv[2];fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$HDIR/agent.json" "$URL"
        _changed=1
      fi
      if [ "$_changed" = 1 ]; then host_service_start; else say "Already at $P_AGENT_BUILD."; fi
      ;;
  esac
  [ "$DRY" = 1 ] && finish 0 dry-run
  finish 0 installed
}

# ---------------------------------------------------------------------------------------------------------------------------------
# uninstall: shows what goes, asks, removes it. Workspaces, their volumes and user data stay unless --purge.

cmd_uninstall() {
  one_install
  P_TARGET=$(target_of "$_one")
  step "Uninstall $_one"
  case $_one in
    docker:*)
      _n=${_one#docker:}
      say "Removes: container $_n$([ "$PURGE" = 1 ] && printf ' and volume %s' "$_n"). Workspaces stay."
      ask "Remove it?"
      run docker rm -f "$_n" >/dev/null || die 14 "docker rm $_n failed."
      [ "$PURGE" = 1 ] && { run docker volume rm "$_n" >/dev/null || warn "Volume $_n is still there."; }
      ;;
    container:*)
      _n=${_one#container:}
      if [ "$PURGE" = 1 ]; then
        say "Removes: container $_n and volumes $_n-home (the workspace's home: its files are LOST), $_n-agent, $_n-state."
      else
        say "Removes: container $_n. Volumes $_n-home, $_n-agent and $_n-state stay (--purge removes them)."
      fi
      ask "Remove it?"
      run docker rm -f "$_n" >/dev/null || die 14 "docker rm $_n failed."
      if [ "$PURGE" = 1 ]; then
        for _v in "$_n-home" "$_n-agent" "$_n-state"; do run docker volume rm "$_v" >/dev/null || warn "Volume $_v is still there."; done
      fi
      ;;
    swarm:*)
      _n=${_one#swarm:}
      say "Removes: service $_n$([ "$PURGE" = 1 ] && printf ' and volume %s on this node (other nodes keep theirs)' "$_n"). Workspaces stay."
      ask "Remove it?"
      run docker service rm "$_n" >/dev/null || die 14 "docker service rm $_n failed."
      [ "$PURGE" = 1 ] && { sleep 5; run docker volume rm "$_n" >/dev/null || warn "Volume $_n is still there (its task may still be stopping)."; }
      ;;
    kubernetes:*)
      _ns=${_one#kubernetes:}
      say "Removes from $_ns on context $KCTX: the agent's Deployment, ServiceAccount, Role, RoleBinding, Secrets and ConfigMap. The namespace and workspaces stay."
      ask "Remove it?"
      run kc -n "$_ns" delete deployment,serviceaccount,role,rolebinding,secret,configmap \
        -l "app.kubernetes.io/part-of=claudepilot-connect${P_TARGET:+,claudepilot.connect/target=$P_TARGET}" --ignore-not-found || die 14 "kubectl delete failed."
      run kc -n "$_ns" delete secret claudepilot-agent-identity --ignore-not-found || :
      ;;
    host:*)
      HDIR=${_one#host:}
      say "Removes: the agent's service and $HDIR. Your files, ~/.claudepilot/host and the workspace's Claudes stay."
      ask "Remove it?"
      host_service_remove
      run rm -rf "$HDIR" || die 14 "Couldn't remove $HDIR."
      ;;
  esac
  say "Remove the target in the portal too (Targets > ${P_TARGET:-the target} > Remove)."
  [ "$DRY" = 1 ] && finish 0 dry-run
  finish 0 removed
}

# ---------------------------------------------------------------------------------------------------------------------------------
# status and doctor: what is here, and the agent's own checks (pilot-agent doctor)

cmd_status() {
  find_installs
  [ -n "$_found" ] || { say "Nothing of ClaudePilot's is installed here."; finish 0 ok; }
  for _i in $_found; do
    case $_i in
      docker:* | container:*) say "$_i: $(container_state "${_i#*:}")" ;;
      swarm:*) say "$_i: $(docker service ls --filter "name=${_i#swarm:}" --format '{{.Replicas}}' 2>/dev/null) tasks" ;;
      kubernetes:*) say "$_i: $(kc -n "${_i#kubernetes:}" get deployment claudepilot-agent -o 'jsonpath={.status.readyReplicas}/{.spec.replicas}' 2>/dev/null) ready" ;;
      host:*) say "$_i: build $(readlink "${_i#host:}/current" 2>/dev/null | sed 's|versions/||')" ;;
    esac
  done
  finish 0 ok
}

cmd_doctor() {
  find_installs
  _rc=0
  if [ -n "$URL" ]; then check_url; check_ca; health; say "Portal answers."; fi
  [ -n "$_found" ] || { say "Nothing of ClaudePilot's is installed here."; finish 0 ok; }
  for _i in $_found; do
    step "$_i"
    case $_i in
      docker:*) docker exec "${_i#*:}" node "$CDATA/current.mjs" doctor || _rc=1 ;;
      container:*) docker exec "${_i#*:}" node "$CAGENT/current.mjs" doctor || _rc=1 ;;
      host:*)
        _hd=${_i#host:}
        _nb=$(sed -n 's/^ExecStart=\([^ ]*\) .*/\1/p' "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT" 2>/dev/null)
        [ -x "$_nb" ] || _nb=$_hd/node/bin/node
        [ -x "$_nb" ] || _nb=node
        PILOT_DATA_DIR=$_hd "$_nb" "$_hd/current/agent.mjs" doctor || _rc=1
        ;;
      swarm:*) docker service ps "${_i#swarm:}" --no-trunc --format '{{.Node}} {{.CurrentState}} {{.Error}}' || _rc=1 ;;
      kubernetes:*) kc -n "${_i#kubernetes:}" exec deployment/claudepilot-agent -c agent -- node /agent/agent.mjs doctor || _rc=1 ;;
    esac
  done
  [ "$_rc" = 0 ] && finish 0 ok
  finish 14 failed
}

# ---------------------------------------------------------------------------------------------------------------------------------

main() {
  exec 3>&1
  for _arg in "$@"; do
    case $_arg in
      install | upgrade | uninstall | doctor | status) CMD=$_arg ;;
      --purge) PURGE=1 ;;
      --yes | -y) YES=1 ;;
      --dry-run) DRY=1 ;;
      -h | --help) usage; exit 0 ;;
      *) usage; die 10 "Unknown argument: $_arg" ;;
    esac
  done
  _tmp=$(mktemp -d 2>/dev/null || mktemp -d -t pilot) || die 10 "Can't make a temporary folder."
  chmod 700 "$_tmp"
  command -v curl >/dev/null 2>&1 || die 10 "curl isn't installed here."
  [ "$DRY" = 1 ] && say "Dry run: nothing will be changed."
  case $CMD in
    upgrade) cmd_upgrade ;;
    uninstall) cmd_uninstall ;;
    status) cmd_status ;;
    doctor) cmd_doctor ;;
  esac
  check_url
  check_token
  check_ca
  health
  fetch_plan
  print_plan
  case $P_KIND in
    docker) install_docker ;;
    container) install_container ;;
    swarm) install_swarm ;;
    kubernetes) install_kubernetes ;;
    host) install_host ;;
  esac
  die 14 "Nothing was done."
}

main "$@"
