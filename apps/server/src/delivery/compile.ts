import { createHash } from 'node:crypto';
import { HOOKS } from './hooks.js';
import { catalog, compilePlugin, manifestPlugin, MARKETPLACE_SETTINGS, marketplaceDirs, revokedDir } from './marketplace.js';
import { dropInPath, isListKey, mayNamePlugin, mayUseEnv, mayWrite, OWNERSHIP } from './ownership.js';
import { tombstoneKey } from './tombstones.js';
import {
  MARKETPLACE_JSON,
  MARKETPLACE_NAME,
  ROOT,
  type Bundle,
  type BundlePlugin,
  type DeliveredDir,
  type DeliveredFile,
  type Fragment,
  type HookLine,
  type HookName,
  type Manifest,
  type Owner,
  type Tombstone,
} from './types.js';

export class CompileError extends Error {
  constructor(
    readonly owner: Owner,
    message: string,
  ) {
    super(`${owner}: ${message}`);
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

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

/** Leaves of a settings value as key paths, stopping at arrays and scalars. */
function* leaves(value: unknown, path: string[]): Generator<{ path: string[]; value: unknown }> {
  if (isObject(value)) for (const [k, v] of Object.entries(value)) yield* leaves(v, [...path, k]);
  else yield { path, value };
}

export interface CompileInput {
  portalId: string;
  generation: number;
  fragments: Fragment[];
  claudeVersion: string | null;
  now?: Date;
  /** What the workspace's manifest says was delivered last time: the `env` names under tombstone tracking. */
  previous?: { env?: Manifest['env'] };
  /** Tombstones still in force, already settled against the workspace's running `claude` processes. */
  tombstones?: Tombstone[];
  /** A stopped workspace gets no new tombstones: no session there can hold an old value. Default: running. */
  running?: boolean;
}

/**
 * Turns a workspace's fragments into one bundle (foundation PRD §6.1): ownership checked, features
 * the workspace's Claude Code lacks left out, drop-ins validated, no setting decided by alphabetical
 * accident, and files in write order (§6.4). Plugins become version folders, a catalog and the base
 * drop-in that registers the marketplace (F6); `env` names an owner stops delivering become tombstones
 * when it asked for them (secrets A6). A fragment that uses neither compiles exactly as it always has.
 */
export function compile(input: CompileInput): Bundle {
  const now = input.now ?? new Date();
  const skipped: Bundle['skipped'] = [];
  const dirs = new Map<string, DeliveredDir>();
  const files: DeliveredFile[] = [];
  const settingsOf: { owner: Owner; settings: Record<string, unknown> }[] = [];
  const leafOwner = new Map<string, Owner>();
  const envOwner = new Map<string, Owner>();
  const pools: Manifest['pools'] = [];
  const plugins: BundlePlugin[] = [];
  const pluginOwner = new Map<string, Owner>();
  const revoked = new Map<string, { owner: Owner; ref: string }>();
  const tracked: Partial<Record<Owner, Record<string, string>>> = {};
  const hooks = new Set<HookName>();
  const readable: string[] = [];

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
    for (const p of f.plugins ?? []) {
      const compiled = compilePlugin(f.owner, p);
      if (typeof compiled === 'string') throw new CompileError(f.owner, compiled);
      const other = pluginOwner.get(compiled.name);
      if (other) throw new CompileError(f.owner, `plugin ${compiled.name} is already delivered${other === f.owner ? '' : ` by ${other}`}`);
      pluginOwner.set(compiled.name, f.owner);
      plugins.push(compiled);
    }
    for (const ref of f.revokePluginFolders ?? []) {
      const dir = typeof ref === 'string' ? revokedDir(f.owner, ref) : null;
      if (!dir) throw new CompileError(f.owner, `may not revoke ${JSON.stringify(ref)}: name one of its own version folders as <name>/<hash12>`);
      revoked.set(`${dir}/`, { owner: f.owner, ref });
    }
    if (f.settings && Object.keys(f.settings).length > 0) {
      if (!dropInPath(f.owner)) throw new CompileError(f.owner, 'has no drop-in for settings');
      for (const [key, value] of Object.entries(f.settings)) {
        const declared = OWNERSHIP[f.owner];
        if (!declared.settings.includes(key)) throw new CompileError(f.owner, `may not set ${key}`);
        if (f.owner === 'foundation' && key === 'extraKnownMarketplaces') throw new CompileError(f.owner, 'extraKnownMarketplaces is compiled from plugins');
        const problem = declared.validate?.[key]?.(value, { owner: f.owner, dropIn: dropInPath(f.owner) });
        if (problem) throw new CompileError(f.owner, problem);
        if (key === 'env') {
          if (!isObject(value)) throw new CompileError(f.owner, 'env must be an object');
          for (const name of Object.keys(value)) {
            if (!mayUseEnv(f.owner, name)) throw new CompileError(f.owner, `may not set env ${name}`);
            const other = envOwner.get(name);
            if (other && other !== f.owner) throw new CompileError(f.owner, `env ${name} is already set by ${other}`);
            envOwner.set(name, f.owner);
            if (typeof value[name] !== 'string') throw new CompileError(f.owner, `env ${name} must be a string`);
          }
          if (f.envTombstones) {
            const except = new Set(f.envTombstones.except ?? []);
            const safe = f.envTombstones.safeValues ?? {};
            for (const name of Object.keys(value)) {
              if (except.has(name)) continue;
              const v = safe[name] ?? '';
              if (typeof v !== 'string') throw new CompileError(f.owner, `the safe value of env ${name} must be a string`);
              (tracked[f.owner] ??= {})[name] = v;
            }
          }
          continue;
        }
        // Nested blocks merge key by key across drop-ins, and list keys combine their lists, so ownership
        // is checked leaf by leaf: one owner per scalar (and per list outside list keys).
        for (const leaf of leaves(value, [key])) {
          if (Array.isArray(leaf.value) && isListKey(key)) continue;
          const id = JSON.stringify(leaf.path);
          const other = leafOwner.get(id);
          if (other && other !== f.owner) throw new CompileError(f.owner, `${leaf.path.join('.')} is already set by ${other}`);
          leafOwner.set(id, f.owner);
        }
      }
      settingsOf.push({ owner: f.owner, settings: f.settings });
    }
    if (f.pool) pools.push({ type: f.owner, id: f.pool.id, revision: f.pool.revision });
    for (const h of f.hooks ?? []) {
      if (!Object.hasOwn(HOOKS, h) || !OWNERSHIP[f.owner].hooks?.includes(h)) throw new CompileError(f.owner, `may not ask for the ${String(h)} hook`);
      hooks.add(h);
    }
    if (f.checkReadable) {
      readable.push(...(f.files ?? []).map((file) => file.path));
      if (f.settings && Object.keys(f.settings).length > 0) readable.push(dropInPath(f.owner)!);
    }
  }

  // The foundation's hook files (secrets A3), delivered like its other files while a fragment asks for them;
  // their lines go to the writer, which appends each one once.
  const lines: HookLine[] = [];
  for (const h of hooks) {
    for (const file of HOOKS[h].files) {
      if (!mayWrite('foundation', file.path)) throw new CompileError('foundation', `may not write ${file.path}`);
      files.push(file);
    }
    lines.push(...HOOKS[h].lines);
  }

  // Plugins: enabled only by the owner that ships them, and only once their folder is in this bundle.
  for (const { owner, settings } of settingsOf) {
    const enabled = settings.enabledPlugins;
    if (enabled === undefined) continue;
    if (!isObject(enabled)) throw new CompileError(owner, 'enabledPlugins must be an object');
    for (const [id, on] of Object.entries(enabled)) {
      const name = id.endsWith(`@${MARKETPLACE_NAME}`) ? id.slice(0, -MARKETPLACE_NAME.length - 1) : '';
      if (!name || !mayNamePlugin(owner, name)) throw new CompileError(owner, `may not switch ${id}: only its own <name>@${MARKETPLACE_NAME} plugins`);
      if (typeof on !== 'boolean') throw new CompileError(owner, `enabledPlugins ${id} must be true or false`);
      const shipper = pluginOwner.get(name);
      if (shipper && shipper !== owner) throw new CompileError(owner, `may not switch ${id}, which ${shipper} delivers`);
      if (on && !shipper) throw new CompileError(owner, `enables ${id} without delivering it`);
    }
  }
  const currentDirs = new Set(plugins.map((p) => `${p.dir}/`));
  for (const [dir, { owner, ref }] of revoked) if (currentDirs.has(dir)) throw new CompileError(owner, `revokes ${ref}, which it still delivers`);

  // Tombstones: names an owner delivered under tracking and no longer does stay with their safe value;
  // a name set again (by its owner, or now by another) or no longer allowed is dropped.
  const candidates: Tombstone[] = [...(input.tombstones ?? [])];
  const known = new Set(candidates.map(tombstoneKey));
  if (input.running !== false) {
    for (const [owner, names] of Object.entries(input.previous?.env ?? {}) as [Owner, Record<string, string> | undefined][]) {
      for (const [name, value] of Object.entries(names ?? {})) {
        if (envOwner.get(name) === owner || known.has(tombstoneKey({ owner, name }))) continue;
        candidates.push({ owner, name, value, since: now.getTime() });
        known.add(tombstoneKey({ owner, name }));
      }
    }
  }
  const tombstones: Tombstone[] = [];
  const tombstoned = new Set<string>();
  for (const t of candidates) {
    const ok =
      Object.hasOwn(OWNERSHIP, t.owner) &&
      !!dropInPath(t.owner) &&
      typeof t.name === 'string' &&
      ENV_NAME.test(t.name) &&
      typeof t.value === 'string' &&
      t.value.length <= 8192 &&
      !envOwner.has(t.name) &&
      !tombstoned.has(t.name) &&
      mayUseEnv(t.owner, t.name);
    if (!ok) continue;
    tombstoned.add(t.name);
    tombstones.push(t);
  }

  // Drop-ins: each owner's settings, plus its tombstones; the foundation's registers the marketplace.
  const withTombstones = (owner: Owner, settings: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    const mine = tombstones.filter((t) => t.owner === owner).sort((a, b) => a.name.localeCompare(b.name));
    if (mine.length === 0) return settings;
    const env = { ...((settings?.env as Record<string, string> | undefined) ?? {}), ...Object.fromEntries(mine.map((t) => [t.name, t.value])) };
    return { ...(settings ?? {}), env };
  };
  const drops: { owner: Owner; settings: Record<string, unknown> }[] = settingsOf.map((s) => ({ owner: s.owner, settings: withTombstones(s.owner, s.settings)! }));
  for (const owner of new Set(tombstones.map((t) => t.owner))) {
    if (!settingsOf.some((s) => s.owner === owner)) drops.push({ owner, settings: withTombstones(owner, undefined)! });
  }
  if (plugins.length) {
    const base = drops.find((d) => d.owner === 'foundation');
    if (base) base.settings = { ...base.settings, ...MARKETPLACE_SETTINGS };
    else drops.push({ owner: 'foundation', settings: { ...MARKETPLACE_SETTINGS } });
  }
  const dropIns: DeliveredFile[] = drops.map(({ owner, settings }) => {
    const content = `${JSON.stringify(settings, null, 2)}\n`;
    const parsed: unknown = JSON.parse(content);
    if (!isObject(parsed)) throw new CompileError(owner, 'settings must be an object');
    const file = OWNERSHIP[owner].dropInFile;
    return { path: dropInPath(owner)!, content, mode: file?.mode ?? 0o644, uid: ROOT, gid: file?.gid ?? ROOT };
  });

  // The catalog names each plugin's current version folder; it's written after the folders, before drop-ins.
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  const catalogFile: DeliveredFile[] = plugins.length ? [{ path: MARKETPLACE_JSON, content: catalog(plugins), mode: 0o644, uid: ROOT, gid: ROOT }] : [];
  if (plugins.length) for (const d of marketplaceDirs(plugins)) if (!dirs.has(d.path)) dirs.set(d.path, d);

  const seen = new Set<string>();
  for (const file of [...files, ...catalogFile, ...dropIns]) {
    if (seen.has(file.path)) throw new CompileError('foundation', `${file.path} is delivered twice`);
    seen.add(file.path);
  }

  // Referenced files first, then the catalog, then drop-ins (§6.4). Version folders go between the
  // referenced files and the catalog, and the manifest is written last, both by the writer.
  const ordered = [...files.sort((a, b) => a.path.localeCompare(b.path)), ...catalogFile, ...dropIns.sort((a, b) => a.path.localeCompare(b.path))];
  const sortedDirs = [...dirs.values()].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  const manifestFiles = Object.fromEntries(ordered.map((f) => [f.path, sha256(f.content)]));
  const hash = sha256(
    JSON.stringify({
      dirs: sortedDirs,
      files: ordered.map((f) => [f.path, f.mode, f.uid, f.gid, manifestFiles[f.path]]),
      ...(plugins.length ? { plugins: plugins.map((p) => [p.owner, p.name, p.treeHash]) } : {}),
    }),
  );
  const env = Object.fromEntries(Object.entries(tracked).filter(([, names]) => Object.keys(names ?? {}).length > 0));
  return {
    dirs: sortedDirs,
    files: ordered,
    plugins,
    tombstones,
    revoked: [...revoked.keys()],
    manifest: {
      portalId: input.portalId,
      generation: input.generation,
      compiledAt: now.toISOString(),
      pools,
      files: manifestFiles,
      ...(plugins.length ? { plugins: plugins.map(manifestPlugin) } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    },
    hash,
    skipped,
    ...(lines.length ? { lines } : {}),
    ...(readable.length ? { readable: [...new Set(readable)] } : {}),
  };
}
