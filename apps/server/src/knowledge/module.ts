// Knowledge: how the portal builds the service (index.ts) and where its files live (Knowledge PRD §10.3).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/store.js';
import { KnowledgeService, parseRoots } from './service.js';

export interface KnowledgeConfig {
  /** `PORTAL_DATA_DIR`: vaults live in `<dataDir>/knowledge`, daily vault zips in `<dataDir>/backups`. */
  dataDir: string;
  /** The repository root, whose `docs/` is offered as a read-only source in development. */
  repoRoot: string;
  dev: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export function createKnowledge(store: Store, cfg: KnowledgeConfig): KnowledgeService {
  const env = cfg.env ?? process.env;
  const roots = parseRoots(env.PORTAL_KNOWLEDGE_ROOTS);
  // The repository's own docs are a ready-made small knowledge base (the PRDs link to each other).
  if (cfg.dev && !roots.docs && existsSync(join(cfg.repoRoot, 'docs'))) roots.docs = { path: join(cfg.repoRoot, 'docs'), writable: false };
  return new KnowledgeService(store, { dir: join(cfg.dataDir, 'knowledge'), backupsDir: join(cfg.dataDir, 'backups'), roots, log: cfg.log });
}

export { KnowledgeService } from './service.js';
export { createKnowledgeRoutes } from './routes.js';
