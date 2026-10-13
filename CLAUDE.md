# ClaudePilot

A web portal for running and steering Claude Code sessions in workspaces (Docker, Kubernetes, remote hosts). Node 22, Hono and
`node:sqlite` on the server (`apps/server`), React, Vite and Tailwind on the web (`apps/web`), shared types in `packages/contracts`.

- **Developing here:** read `docs/dev-session.md` first (what is connected: GitHub, GitLab, the k3s cluster; how to test and release).
- **Product documents:** `docs/prd/` (one PRD per area; `README.md` is the index). Open work and decisions: `docs/open-items.md`.
- **Deploy files:** `deploy/k3s/` (Argo CD follows `main`), `deploy/k3s-build/` (images are built in the cluster), `deploy/compose.yaml` (the Docker deployment).

## Conventions

- Test with `npm run typecheck`, `npm run build -w @portal/web` and `cd apps/server && npm test`; run the heavy ones one at a time.
- Migrations are append only (`apps/server/src/store/migrations.ts`); never edit a released one.
- No secret or token-shaped literal in the repository, tests and docs included: build fixtures at runtime.
- UI text is short: titles of one or two words, explanations in an InfoTip, phone width (390 px) first, light and dark.
- Pushing `main` deploys to the cluster: do it only when the owner says so. Work on `integration`.
- Talk to the owner in short, plain language, in the language they write (casual Indonesian or English).
