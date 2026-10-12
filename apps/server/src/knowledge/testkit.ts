// Test helpers for knowledge (not used by the portal): a real store in a temp directory, a journal on it,
// and a way to open vaults the way the service does.

import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { Journal, parseActor, type Actor } from './journal.js';
import { knowledgeLimits, type KnowledgeLimits } from './limits.js';
import { Vault } from './vault.js';

export const UI: Actor = parseActor('ui');
export const AGENT: Actor = parseActor('portal-mcp:tok1');
export const SESSION: Actor = parseActor('session:s-1');

export interface Harness {
  dir: string;
  store: Store;
  journal: Journal;
  limits: KnowledgeLimits;
  /** Opens (and registers) a vault under this harness's data directory. */
  vault(id?: string, opts?: { readOnly?: boolean; root?: string }): Vault;
  clock: { now: Date };
  close(): void;
}

export async function harness(opts: { limits?: Partial<KnowledgeLimits> } = {}): Promise<Harness> {
  const dir = tempDirectory('kg-');
  const store = await Store.open({ dataDir: dir, secretKey: parseSecretKey(generateSecretKey()) });
  const limits = { ...knowledgeLimits({}), ...opts.limits };
  const clock = { now: new Date('2026-10-12T09:00:00.000Z') };
  const journal = new Journal(store, limits, () => clock.now);
  const vaults: Vault[] = [];
  let n = 0;
  return {
    dir,
    store,
    journal,
    limits,
    clock,
    vault(id = `v${String(++n).padStart(11, '0')}`, o = {}) {
      store.db!
        .prepare("INSERT OR IGNORE INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at) VALUES (?, ?, 'vault', ?, ?, ?, ?)")
        .run(id, `Vault ${id}`, id, o.readOnly ? 1 : 0, clock.now.toISOString(), clock.now.toISOString());
      const v = new Vault({ id, root: o.root ?? join(dir, 'knowledge', 'vaults', id), readOnly: !!o.readOnly, indexFile: join(dir, 'knowledge', 'index', `${id}.db`), journal, limits, now: () => clock.now });
      vaults.push(v);
      return v;
    },
    close() {
      for (const v of vaults) v.close();
      store.close();
    },
  };
}

/** Writes a file straight to a vault's folder, the way another tool (Obsidian, git) would. */
export function outside(vault: Vault, rel: string, content: string | Buffer, mtimeMs?: number): void {
  const file = join(vault.root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    utimesSync(file, t, t);
  }
}

export const readOutside = (vault: Vault, rel: string): string => readFileSync(join(vault.root, rel), 'utf8');
