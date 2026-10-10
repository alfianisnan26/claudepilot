FROM mcr.microsoft.com/devcontainers/javascript-node:22

ARG KUBECTL_VERSION=v1.35.5

# GitHub CLI apt repo
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list

RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux gh gnupg2 openssh-client \
    && rm -rf /var/lib/apt/lists/*

# The host ~/.gitconfig (copied in by VS Code) points the github.com credential
# helper at the Homebrew gh path, so make that path resolve here too.
RUN mkdir -p /opt/homebrew/bin && ln -s /usr/bin/gh /opt/homebrew/bin/gh

# kubectl, matched to the k3s server version
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
    && chmod +x /usr/local/bin/kubectl

# cloudflared, for `cloudflared access ssh` to the infra jump host
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb" \
    && dpkg -i /tmp/cloudflared.deb \
    && rm /tmp/cloudflared.deb

RUN npm install -g @anthropic-ai/claude-code

COPY bin/claude-as /usr/local/bin/claude-as
RUN chmod +x /usr/local/bin/claude-as

COPY --chown=node:node ssh/config /home/node/.ssh/config
RUN chmod 700 /home/node/.ssh && chmod 600 /home/node/.ssh/config

# Pre-create mount targets so named volumes inherit node ownership
RUN mkdir -p /home/node/.claude-profiles /home/node/.cloudflared /home/node/.portal-secrets \
    && chown node:node /home/node/.claude-profiles /home/node/.cloudflared /home/node/.portal-secrets \
    && chmod 700 /home/node/.portal-secrets
