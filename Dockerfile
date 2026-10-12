# Production image of the portal: web and server built once, no watcher, no Vite middleware.
# Build through deploy/compose.yaml, which passes NODE_AUTH_TOKEN (GitHub Packages, read:packages) as a
# build secret so it never lands in a layer.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=secret,id=node_auth_token,env=NODE_AUTH_TOKEN \
    --mount=type=cache,target=/root/.npm \
    npm ci
COPY . .
RUN npm run build \
    && npm prune --omit=dev \
    && mkdir -p apps/server/node_modules

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORTAL_HOST=0.0.0.0 \
    PORTAL_PORT=3000 \
    PORTAL_DATA_DIR=/data \
    PORTAL_SECRET_KEY_FILE=/secrets/portal_secret_key
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/contracts packages/contracts
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/node_modules apps/server/node_modules
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/package.json apps/web/
COPY --from=build /app/apps/web/dist apps/web/dist
# Docker targets build the workspace image from here the first time.
COPY --from=build /app/images/workspace images/workspace
RUN mkdir -p /data /secrets && chmod 700 /data /secrets
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/dist/index.js"]
