# The cp-bridge image (epic PILOT-1131, D4; T-3699): the Connect agent in kube mode, run by Node 22. The bundle is the one committed in
# apps/server/src/connect/agent.generated.ts (build.test.ts keeps it equal to a fresh build of apps/server/src/connect/agent/bin.ts, whose
# `run` is main.ts), taken out with its SHA-256 checked: no npm and no package token in this build. Built in the cluster by bridge-job.yaml.
FROM node:22-bookworm-slim AS extract
WORKDIR /src
COPY apps/server/src/connect/agent.generated.ts deploy/k3s-bridge/extract-agent.mjs ./
RUN node extract-agent.mjs agent.generated.ts agent.mjs

FROM node:22-bookworm-slim
COPY --from=extract --chmod=0444 /src/agent.mjs /agent/agent.mjs
# nobody: the Deployment also says so (runAsNonRoot, 65534) and mounts the root filesystem read-only.
USER 65534:65534
ENV NODE_ENV=production
ENTRYPOINT ["node", "/agent/agent.mjs"]
CMD ["run"]
