# The runner image of job-run.sh --backend cf (T-3542, CFR-1), sized for memor.id's CI: Node 22.23.3 (memor.id's .nvmrc; engines
# >=22.22.2, npm, package-lock.json), git, Playwright 1.63.0 Chromium with its system libraries (memor.id's @playwright/test), Caddy for
# the e2e dev stack (scripts e2e.sh puts Caddy in front of `npm run dev`), python3/make/g++ for native modules. Built in the cluster by
# scripts/image-build.sh (kaniko) and pushed to registry.cloudflare.com/<KohiLabs account>/cp-jobrun-runner:<tag>; see ../README.md.
FROM docker.io/library/node:22.23.3-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    npm_config_update_notifier=false \
    NODE_OPTIONS=--max-old-space-size=4608

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq python3 make g++ procps psmisc tini xz-utils libnss3-tools caddy \
 && rm -rf /var/lib/apt/lists/*

# Playwright's Chromium (and the headless shell) with their OS dependencies, baked in: the job's egress allow-list has no browser CDN.
RUN npx -y playwright@1.63.0 install --with-deps chromium \
 && rm -rf /root/.npm /var/lib/apt/lists/*

COPY agent.mjs fetch.sh run.sh /opt/jobrun/
RUN chmod 755 /opt/jobrun/*.sh && mkdir -p /work

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/jobrun/agent.mjs"]
