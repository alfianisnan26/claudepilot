# The image every workspace runs: a shell box with Claude Code, git and gh, as user `node`.
# Docker targets build it on first use (tag claudepilot-workspace:latest); Kubernetes pulls it
# from a registry (PORTAL_K8S_IMAGE).
FROM node:22-bookworm

# GitHub CLI apt repo
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       gh git openssh-client sudo tmux vim less procps jq ripgrep ca-certificates locales \
    && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# The workspace owner can install what they need.
RUN echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node && chmod 440 /etc/sudoers.d/node

# The chat session host, root-owned. Kubernetes workspaces get it only from here (on Docker the portal
# also writes it in). Its tools (jq, flock, setsid, coreutils, findutils, git) are all in this image.
# Generated from CP_SESSION in apps/server/src/chat/host.ts: npm run gen:workspace-host -w @portal/server
# (no COPY --chmod: the portal builds this with Docker's classic builder).
COPY cp-session /etc/claudepilot/bin/cp-session
RUN chmod 0755 /etc/claudepilot /etc/claudepilot/bin /etc/claudepilot/bin/cp-session

ENV LANG=en_US.UTF-8 TERM=xterm-256color
USER node
WORKDIR /home/node
RUN mkdir -p /home/node/work

# Idle until stopped; the trap makes SIGTERM (docker stop, pod deletion) exit at once.
CMD ["bash", "-c", "trap 'exit 0' TERM INT; sleep infinity & wait"]
