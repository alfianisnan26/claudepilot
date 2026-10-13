// Workspace git (docs/prd/workspace-git.md): index.ts builds one service, starts it, registers its Portal MCP tools and hands its routes
// to app.ts. The session host's commands it relies on live in chat/host.ts (`repo-find`, `repo-state`, `repo-sync`).

import { config } from '../config.js';
import type { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import { workspacesHost } from './host.js';
import { normalizeRoot, ReposService, type SessionSource } from './service.js';

export { createReposRoutes, createWorkspaceReposRoutes } from './routes.js';
export { registerRepoTools } from './portalTools.js';
export { ReposService } from './service.js';

export interface ReposModuleDeps {
  store: Store;
  workspaces: Pick<Workspaces, 'list' | 'exec' | 'runtimeFor'>;
  /** Makes sure a workspace has the current session host (chat/install.ts). */
  installHost: (workspaceId: string) => Promise<void>;
  sessions: SessionSource;
  /** Text from a workspace, secret values and credential shapes taken out (the chat controller's `scrub`). */
  scrub: (workspaceId: string, text: string) => string;
  /** Tells open pages (the `repos` live topic). */
  notify: () => void;
}

const clamp = (n: number, lo: number, hi: number, fallback: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback);

export function createRepos(deps: ReposModuleDeps): ReposService {
  const roots = config.repos.roots.map(normalizeRoot).filter((r): r is string => !!r);
  return new ReposService({
    store: deps.store,
    host: workspacesHost(deps.workspaces, deps.installHost),
    workspaces: async () => (await deps.workspaces.list()).map((w) => ({ id: w.id, name: w.name, running: w.status === 'running', supported: ((r) => r?.target.kind !== 'kubernetes' || !!r.delivery)(deps.workspaces.runtimeFor(w.target)) })),
    sessions: deps.sessions,
    scrub: deps.scrub,
    notify: deps.notify,
    config: {
      auto: config.repos.auto,
      intervalS: clamp(config.repos.intervalS, 30, 86_400, 300),
      roots: roots.length ? roots : ['~'],
      depth: clamp(config.repos.depth, 1, 12, 6),
      maxRepos: clamp(config.repos.maxRepos, 10, 2000, 300),
    },
    log: (m) => console.log(m),
  });
}
