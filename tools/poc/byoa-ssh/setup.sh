#!/bin/bash
# PoC setup inside the workspace, as root. Mirrors docs/prd/workspace-ssh.md v0.2.
set -euo pipefail
groupadd -f -g 20000 pilot-people
mk() { # label uid
  local u="p-$1" h="/home/people/$1"
  id "$u" >/dev/null 2>&1 || useradd -u "$2" -g pilot-people -M -d "$h" -s /bin/bash "$u"
  usermod -p '*' "$u"                       # no password, but not locked ('!' makes sshd refuse pubkey)
  mkdir -p "$h"; chown "$u":pilot-people "$h"; chmod 700 "$h"
}
mkdir -p /home/people; chmod 755 /home/people
i=0; for p in ${PEOPLE:-alice bob}; do i=$((i+1)); mk "$p" $((20000+i)); done
# for people only: private files by default (5.12), and agent CLIs that sign in without opening a browser (an SSH session has none)
cat > /etc/profile.d/50-pilot-people.sh <<'C'
if id -nG 2>/dev/null | grep -qw pilot-people; then umask 077; export NO_BROWSER=true; fi
C
chmod 700 /home/node
# host key on node's volume, made once
install -d -o node -g node -m 700 /home/node/.claudepilot/ssh
[ -f /home/node/.claudepilot/ssh/host_ed25519_key ] || sudo -u node ssh-keygen -q -t ed25519 -N '' -f /home/node/.claudepilot/ssh/host_ed25519_key
install -d -m 755 /etc/claudepilot/ssh /etc/claudepilot/ssh/conn /etc/claudepilot/bin
cat > /etc/claudepilot/ssh/sshd_config <<'C'
HostKey /home/node/.claudepilot/ssh/host_ed25519_key
PidFile none
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
AllowGroups pilot-people
AllowTcpForwarding local
AllowAgentForwarding no
AllowStreamLocalForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
PermitUserEnvironment no
ClientAliveInterval 30
ForceCommand /etc/claudepilot/bin/ssh-enter
Subsystem sftp /usr/lib/openssh/sftp-server
LogLevel VERBOSE
C
cat > /etc/claudepilot/ssh/consent.txt <<'C'
pilot: before you use this workspace from your desktop
  - your sessions here are seen in pilot: who you are, what ran, the transcript
  - your home and your agent sign-in are yours only; the workspace's administrator (the portal) can reach every file
  - pilot work you claim is attributed to you
C
cat > /etc/claudepilot/bin/ssh-enter <<'C'
#!/bin/bash
# ForceCommand: consent once per person, the welcome screen, then the login shell or the requested command.
c="$HOME/.claudepilot/consent"; o="$HOME/.claudepilot/outbox"
mkdir -p "$o"
if [ ! -f "$c" ]; then
  if [ -n "${SSH_ORIGINAL_COMMAND:-}" ] || [ ! -t 0 ]; then echo "pilot: connect once from a terminal to accept" >&2; exit 1; fi
  cat /etc/claudepilot/ssh/consent.txt
  read -r -p "Type yes to accept: " a
  [ "$a" = yes ] || { echo "pilot: not accepted"; exit 1; }
  date -u +%FT%TZ > "$c"
  printf '{"ts":"%s","event":"consent","person":"%s","conn":"%s"}\n' "$(date -u +%FT%TZ)" "$PILOT_PERSON" "$PILOT_CONN_ID" >> "$o/desktop.jsonl"
fi
if [ -z "${SSH_ORIGINAL_COMMAND:-}" ]; then
  w="/etc/claudepilot/ssh/conn/$PILOT_CONN_ID/welcome"; [ -r "$w" ] && cat "$w"
  exec bash -l
fi
exec bash -lc "$SSH_ORIGINAL_COMMAND"
C
cat > /etc/claudepilot/bin/desktop-event <<'C'
#!/bin/bash
# Claude Code hook (managed): one outbox line per event of a desktop session; never the prompt text, never the network.
[ -n "${PILOT_CONN_ID:-}" ] || exit 0
in=$(cat); o="$HOME/.claudepilot/outbox"; mkdir -p "$o"
cwd=$(jq -r '.cwd // empty' <<<"$in"); br=$(git -C "${cwd:-.}" symbolic-ref --short -q HEAD 2>/dev/null || git -C "${cwd:-.}" rev-parse --short HEAD 2>/dev/null || true)
jq -c --arg p "$PILOT_PERSON" --arg c "$PILOT_CONN_ID" --arg b "$br" --arg t "$(date -u +%FT%TZ)" \
  '{ts:$t, event:.hook_event_name, session_id, transcript_path, cwd, person:$p, conn:$c, branch:$b}' <<<"$in" >> "$o/desktop.jsonl"
exit 0
C
cat > /etc/claudepilot/bin/kill-person <<'C'
#!/bin/sh
# Revocation: a person is a Unix user, so every process of theirs ends (also detached ones, like the VS Code server).
pkill -KILL -u "p-$1"; sleep 0.2; echo left $(pgrep -c -u "p-$1")
C
chmod 755 /etc/claudepilot/bin/*
# managed hooks for desktop sessions
cat > /etc/claude-code/managed-settings.d/50-claudepilot-desktop.json <<'C'
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"/etc/claudepilot/bin/desktop-event"}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"/etc/claudepilot/bin/desktop-event"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"/etc/claudepilot/bin/desktop-event"}]}],
 "SessionEnd":[{"hooks":[{"type":"command","command":"/etc/claudepilot/bin/desktop-event"}]}]}}
C
chmod 644 /etc/claude-code/managed-settings.d/50-claudepilot-desktop.json
if [ "${FAKE_POOL:-1}" = 1 ]; then
# a stand-in account pool and Secrets drop-in, shaped like the real ones (accounts/pools.ts:577-584, delivery/ownership.ts:132-134)
install -d -o root -g node -m 750 /etc/claudepilot/account
printf 'pool-key-%s\n' "$(head -c6 /dev/urandom | od -An -tx1 | tr -d ' \n')" > /etc/claudepilot/account/acct1.key
chown root:node /etc/claudepilot/account/acct1.key; chmod 440 /etc/claudepilot/account/acct1.key
printf '#!/bin/sh\ncat /etc/claudepilot/account/$1.key\n' > /etc/claudepilot/bin/account-key; chmod 755 /etc/claudepilot/bin/account-key
echo '{"env":{"POC_POOL_SECRET":"s3cr3t-from-pool"}}' > /etc/claude-code/managed-settings.d/20-claudepilot-env.json
chown root:node /etc/claude-code/managed-settings.d/20-claudepilot-env.json; chmod 440 /etc/claude-code/managed-settings.d/20-claudepilot-env.json
fi
echo "setup ok"
