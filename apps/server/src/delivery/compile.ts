import { createHash } from 'node:crypto';
import { dropInPath, isListKey, mayUseEnv, mayWrite, OWNERSHIP } from './ownership.js';
import { ROOT, type Bundle, type DeliveredDir, type DeliveredFile, type Fragment, type Manifest, type Owner } from './types.js';

export class CompileError extends Error {
  constructor(
    readonly owner: Owner,
    message: string,
  ) {
    super(`${owner}: ${message}`);
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** `2.1.296 (Claude Code)` → [2, 1, 296]. */
export function parseVersion(v: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(have: string, need: string): boolean {
  const a = parseVersion(have);
  const b = parseVersion(need);
  if (!a || !b) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

/**
 * Turns a workspace's fragments into one bundle (foundation PRD §6.1): ownership checked, features
 * the workspace's Claude Code lacks left out, drop-ins validated, no setting decided by alphabetical
 * accident, and files in write order (§6.4).
 */
export function compile(input: { portalId: string; generation: number; fragments: Fragment[]; claudeVersion: string | null; now?: Date }): Bundle {
  const skipped: Bundle['skipped'] = [];
  const dirs = new Map<string, DeliveredDir>();
  const files: DeliveredFile[] = [];
  const dropIns: DeliveredFile[] = [];
  const scalarOwner = new Map<string, Owner>();
  const envOwner = new Map<string, Owner>();
  const pools: Manifest['pools'] = [];

  for (const f of input.fragments) {
    if (f.minClaudeVersion && input.claudeVersion && !versionAtLeast(input.claudeVersion, f.minClaudeVersion)) {
      skipped.push({ owner: f.owner, reason: `Needs Claude Code ${f.minClaudeVersion} or newer (workspace has ${input.claudeVersion}).` });
      continue;
    }
    for (const d of f.dirs ?? []) {
      if (f.owner !== 'foundation' && !mayWrite(f.owner, `${d.path}/`)) throw new CompileError(f.owner, `may not create ${d.path}`);
      dirs.set(d.path, d);
    }
    for (const file of f.files ?? []) {
      if (!mayWrite(f.owner, file.path)) throw new CompileError(f.owner, `may not write ${file.path}`);
      if (file.path === dropInPath(f.owner)) throw new CompileError(f.owner, 'its drop-in is written from `settings`');
      files.push(file);
    }
    if (f.settings && Object.keys(f.settings).length > 0) {
      const path = dropInPath(f.owner);
      if (!path) throw new CompileError(f.owner, 'has no drop-in for settings');
      for (const [key, value] of Object.entries(f.settings)) {
        if (!OWNERSHIP[f.owner].settings.includes(key)) throw new CompileError(f.owner, `may not set ${key}`);
        if (key === 'env') {
          for (const name of Object.keys(value as Record<string, unknown>)) {
            if (!mayUseEnv(f.owner, name)) throw new CompileError(f.owner, `may not set env ${name}`);
            const other = envOwner.get(name);
            if (other && other !== f.owner) throw new CompileError(f.owner, `env ${name} is already set by ${other}`);
            envOwner.set(name, f.owner);
            if (typeof (value as Record<string, unknown>)[name] !== 'string') throw new CompileError(f.owner, `env ${name} must be a string`);
          }
        } else if (!isListKey(key)) {
          const other = scalarOwner.get(key);
          if (other && other !== f.owner) throw new CompileError(f.owner, `${key} is already set by ${other}`);
          scalarOwner.set(key, f.owner);
        }
      }
      const content = `${JSON.stringify(f.settings, null, 2)}\n`;
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CompileError(f.owner, 'settings must be an object');
      dropIns.push({ path, content, mode: 0o644, uid: ROOT, gid: ROOT });
    }
    if (f.pool) pools.push({ type: f.owner, id: f.pool.id, revision: f.pool.revision });
  }

  const seen = new Set<string>();
  for (const file of [...files, ...dropIns]) {
    if (seen.has(file.path)) throw new CompileError('foundation', `${file.path} is delivered twice`);
    seen.add(file.path);
  }

  // Referenced files first, then drop-ins (§6.4). The manifest is written last by the writer.
  const ordered = [...files.sort((a, b) => a.path.localeCompare(b.path)), ...dropIns.sort((a, b) => a.path.localeCompare(b.path))];
  const sortedDirs = [...dirs.values()].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  const manifestFiles = Object.fromEntries(ordered.map((f) => [f.path, sha256(f.content)]));
  const hash = sha256(
    JSON.stringify({
      dirs: sortedDirs,
      files: ordered.map((f) => [f.path, f.mode, f.uid, f.gid, manifestFiles[f.path]]),
    }),
  );
  return {
    dirs: sortedDirs,
    files: ordered,
    manifest: {
      portalId: input.portalId,
      generation: input.generation,
      compiledAt: (input.now ?? new Date()).toISOString(),
      pools,
      files: manifestFiles,
    },
    hash,
    skipped,
  };
}
