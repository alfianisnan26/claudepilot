// Test helpers for Secrets & env: a fresh store with the pool service, the shared References and the
// secrets kind, plus an in-memory Docker workspace for the delivery engine. Not used by the portal itself.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FragmentProvider } from '../delivery/reconciler.js';
import { MANIFEST_PATH, type Manifest } from '../delivery/types.js';
import { References, type ReferenceSource } from '../pools/references.js';
import { PoolService } from '../pools/service.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { DeliveryAccess, Runtime, TarEntry } from '../workspaces/runtime.js';
import { SecretsKind } from './kind.js';

export const KEY = generateSecretKey();

/** A fresh portal database with the pool service and the secrets kind registered. */
export async function secretsHarness(opts: { key?: string | null } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-secrets-'));
  const key = opts.key === undefined ? KEY : opts.key;
  const store = await Store.open({ dataDir, secretKey: key ? parseSecretKey(key) : null });
  const providers: FragmentProvider[] = [];
  const service = new PoolService(store, { providers });
  const references = new References();
  const kind = new SecretsKind(store, service, references);
  service.register(kind);
  const requests: string[] = [];
  service.reconciler = { request: (id: string) => (requests.push(id), Promise.resolve()) };
  /** A pool type that references names, as MCP sets will. */
  const uses = new Map<string, { poolId: string; poolName: string; workspaces: string[] }[]>();
  const source: ReferenceSource = {
    type: 'mcpset',
    referencing: (name) => (uses.get(name) ?? []).map(({ poolId, poolName }) => ({ poolId, poolName })),
    namesUsedBy: (ws) => new Map([...uses].map(([n, list]) => [n, list.filter((p) => p.workspaces.includes(ws)).map(({ poolId, poolName }) => ({ poolId, poolName }))] as const).filter(([, l]) => l.length > 0)),
  };
  references.addSource(source);
  const done = () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { dataDir, store, service, kind, references, providers, requests, uses, done };
}

/**
 * A Docker workspace in memory, for the reconciler: the archive API's files and folders, and the shell
 * scripts the writer and the checks run, executed and logged. Every script and archive is kept, so tests
 * can see exactly what crossed into the workspace and how.
 */
export function memoryWorkspace() {
  const files = new Map<string, { content: string; mode: number; uid: number; gid: number }>();
  const dirs = new Set<string>();
  const scripts: { script: string; user: string; stdin?: string }[] = [];
  const puts: TarEntry[][] = [];
  const state = { running: true, ages: [] as number[], unreadable: new Set<string>(), portal: null as string | null };
  const unquote = (s: string) => s.replace(/'\\''/g, "'");

  const applied = () => {
    const raw = files.get(MANIFEST_PATH)?.content ?? '';
    let out = `${raw}<<<cp-hashes>>>\n`;
    if (raw) {
      const m = JSON.parse(raw) as Manifest;
      for (const p of Object.keys(m.files)) out += `${files.has(p) ? sha256(files.get(p)!.content) : '-'} ${p}\n`;
    }
    out += `<<<cp-claude>>>\n${state.ages.map((a) => `${a}\n`).join('')}`;
    return `${out}<<<cp-version>>>\n2.1.296 (Claude Code)\n`;
  };

  const exec = (script: string, stdin = ''): string => {
    if (script.includes('<<<cp-hashes>>>')) return applied();
    if (script.startsWith('while IFS= read -r f;')) return stdin.split('\n').filter((p) => p && (!files.has(p) || state.unreadable.has(p))).map((p) => `${p}\n`).join('');
    for (const line of script.split('\n')) {
      let m: RegExpExecArray | null;
      if (line === 'set -e') continue;
      if ((m = /^mv -f '([^']*)' '([^']*)'$/.exec(line))) {
        const [from, to] = [unquote(m[1]!), unquote(m[2]!)];
        if (!files.has(from)) throw new Error(`mv: ${from} missing`);
        files.set(to, files.get(from)!);
        files.delete(from);
      } else if ((m = /^rm -f '([^']*)'$/.exec(line))) files.delete(unquote(m[1]!));
      else if ((m = /^grep -qxF -- '((?:[^']|'\\'')*)' '([^']*)' 2>\/dev\/null \|\| printf '%s\\n' '((?:[^']|'\\'')*)' >> '([^']*)'$/.exec(line))) {
        const [text, path] = [unquote(m[1]!), unquote(m[2]!)];
        const current = files.get(path)?.content ?? '';
        if (!current.split('\n').includes(text)) files.set(path, { content: `${current}${text}\n`, mode: 0o644, uid: 0, gid: 0 });
      } else throw new Error(`unexpected command: ${line}`);
    }
    return '';
  };

  const access: DeliveryAccess = {
    state: async () => ({ exists: true, running: state.running, portal: state.portal }),
    run: async (_name, script, opts = {}) => {
      if (!state.running) throw new Error('not running');
      scripts.push({ script, user: opts.user ?? 'root', ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
      return { code: 0, stdout: exec(script, opts.stdin), stderr: '' };
    },
    put: async (_name, entries) => {
      puts.push(entries);
      for (const e of entries) {
        if (e.type === 'directory') dirs.add(e.path);
        else files.set(e.path, { content: e.content ?? '', mode: e.mode, uid: e.uid, gid: e.gid });
      }
    },
    read: async (_name, path) => files.get(path)?.content ?? null,
    watchStarts: () => () => {},
  };
  const runtime = { delivery: access, target: { id: 'docker', label: 'Docker', kind: 'docker', where: '' } } as unknown as Runtime;
  const manifest = () => JSON.parse(files.get(MANIFEST_PATH)?.content ?? 'null') as Manifest | null;
  return { files, dirs, scripts, puts, state, access, runtime, manifest };
}

import { createHash } from 'node:crypto';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
