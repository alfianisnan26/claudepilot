FROM claudepilot-workspace:cc-2.1.296
USER root
# sshd for `sshd -i` per connection (no daemon), and the agent CLIs installed ONCE for everyone, pinned (S0 finding 5.9: 1.2 GB per person
# otherwise). Claude Code is already in the base image. Codex needs bubblewrap for its sandbox (5.8).
ARG GEMINI_CLI=0.64.0
ARG CODEX_CLI=0.162.1
ARG CURSOR_CLI=2026.10.14-941492e
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server bubblewrap >/dev/null \
 && rm -f /etc/ssh/ssh_host_* && mkdir -p /run/sshd && rm -rf /var/lib/apt/lists/* \
 && npm i -g --no-fund --no-audit --loglevel=error @google/gemini-cli@${GEMINI_CLI} @openai/codex@${CODEX_CLI} \
 && a=$(uname -m); case "$a" in x86_64) a=x64;; aarch64) a=arm64;; esac \
 && mkdir -p /opt/cursor-agent && curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_CLI}/linux/${a}/agent-cli-package.tar.gz" \
    | tar --strip-components=1 -xzf - -C /opt/cursor-agent \
 && chmod -R a+rX /opt/cursor-agent && ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent \
 && /usr/sbin/sshd -V 2>&1 | head -1; gemini --version; codex --version; cursor-agent --version
USER node
