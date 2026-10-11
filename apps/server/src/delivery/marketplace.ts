import { createHash } from 'node:crypto';
import { mayNamePlugin } from './ownership.js';
import { MARKETPLACE_DIR, MARKETPLACE_NAME, PLUGINS_DIR, ROOT, type BundlePlugin, type DeliveredDir, type DeliveredFile, type ManifestPlugin, type Owner, type PluginBundle } from './types.js';

/**
 * The portal's plugin marketplace (foundation F6, skillset A2 and §10.5, MCP set §10.4): one directory
 * marketplace at `/etc/claudepilot/marketplace`, registered by the foundation's base drop-in. Each plugin
 * lives in a version folder named by its tree hash, so a session that loaded an older folder keeps
 * reading the files it loaded while the catalog already points new sessions at the new one.
 */

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const isHex12 = (s: string) => /^[0-9a-f]{12}$/.test(s);

/** Files 0644, or 0755 when any execute bit is asked for; setuid, setgid and sticky never survive. */
export const normalizeMode = (mode: number | undefined) => ((mode ?? 0) & 0o111 ? 0o755 : 0o644);

/**
 * Skillset FR6's tree hash: SHA-256 over one `<mode> <path>\0<sha256>\n` line per file, with paths
 * NFC-normalized and sorted bytewise and modes written as `0644` or `0755`. The workspace computes the
 * same over a delivered folder (`TREE_HASH_JS`), so a changed, missing or extra file shows as drift.
 */
export function treeHash(files: { path: string; content: string; mode?: number; encoding?: 'base64' }[]): string {
  const lines = files
    .map((f) => ({
      path: Buffer.from(f.path.normalize('NFC')),
      mode: normalizeMode(f.mode) === 0o755 ? '0755' : '0644',
      hash: sha256(f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : f.content),
    }))
    .sort((a, b) => Buffer.compare(a.path, b.path));
  const h = createHash('sha256');
  for (const l of lines) h.update(Buffer.concat([Buffer.from(`${l.mode} `), l.path, Buffer.from(`\0${l.hash}\n`)]));
  return h.digest('hex');
}

/**
 * The same hash computed inside the workspace (Node is in every workspace image): a function of one
 * folder that returns its tree hash, with anything but plain files and folders (a symlink, a device)
 * making it unmatchable.
 */
export const TREE_HASH_JS = `(root)=>{const fs=require("fs"),c=require("crypto"),out=[];
const walk=(d,rel)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=d+"/"+e.name,r=rel?rel+"/"+e.name:e.name;
if(e.isDirectory())walk(p,r);else if(e.isFile())out.push([Buffer.from(r.normalize("NFC")),fs.statSync(p).mode&0o111?"0755":"0644",c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")]);
else out.push([Buffer.from(r),"link","-"])}};
walk(root,"");out.sort((a,b)=>Buffer.compare(a[0],b[0]));const h=c.createHash("sha256");
for(const [p,m,s] of out)h.update(Buffer.concat([Buffer.from(m+" "),p,Buffer.from("\\0"+s+"\\n")]));return h.digest("hex")}`;

/** The version folder of a plugin at a tree hash. */
export const pluginDir = (name: string, treeHashOrHash12: string) => `${PLUGINS_DIR}/${name}/${treeHashOrHash12.slice(0, 12)}`;

/** `<name>/<hash12>` → the folder path, if it names a version folder this owner may own. */
export function revokedDir(owner: Owner, ref: string): string | null {
  const [name = '', hash12 = '', ...rest] = ref.split('/');
  return rest.length === 0 && isHex12(hash12) && mayNamePlugin(owner, name) ? pluginDir(name, hash12) : null;
}

/** Relative, inside the plugin root, no empty, `.` or `..` segments, no control characters or backslashes. */
function relativePathProblem(path: string): string | null {
  if (!path || path.startsWith('/')) return 'must be a relative path';
  if (path.length > 1024) return 'is too long';
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return 'has a control character or backslash';
  if (path.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'must stay inside the plugin folder';
  return null;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MANIFEST = '.claude-plugin/plugin.json';

/**
 * Compiles one plugin into its version folder: checks the name against the owner's rule and the files'
 * paths, generates `.claude-plugin/plugin.json` unless the owner wrote one (whose name and version must
 * then match), and names the folder by the tree hash of everything in it. Returns the problem as text
 * when the plugin can't be delivered.
 */
export function compilePlugin(owner: Owner, p: PluginBundle): BundlePlugin | string {
  if (!mayNamePlugin(owner, p.name)) return `may not ship a plugin named "${p.name}"`;
  if (typeof p.version !== 'string' || !SEMVER.test(p.version)) return `plugin ${p.name}: version must look like <revision>.0.0+<hash8>`;
  if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > 1000)) return `plugin ${p.name}: description must be text of at most 1000 characters`;
  if (!Array.isArray(p.files)) return `plugin ${p.name}: files must be a list`;

  const files = new Map<string, { path: string; content: string; mode: number; encoding?: 'base64' }>();
  for (const f of p.files) {
    const problem = relativePathProblem(typeof f?.path === 'string' ? f.path : '');
    if (problem) return `plugin ${p.name}: file ${JSON.stringify(f?.path)} ${problem}`;
    if (typeof f.content !== 'string') return `plugin ${p.name}: ${f.path} must have text content`;
    if (f.encoding !== undefined && (f.encoding !== 'base64' || f.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.content)))
      return `plugin ${p.name}: ${f.path} must be text, or bytes as base64`;
    const path = f.path.normalize('NFC');
    if (files.has(path)) return `plugin ${p.name}: ${path} is listed twice`;
    files.set(path, { path, content: f.content, mode: normalizeMode(f.mode), ...(f.encoding ? { encoding: f.encoding } : {}) });
  }
  // A path can't be both a file and a folder.
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join('/'))) return `plugin ${p.name}: ${parts.slice(0, i).join('/')} is both a file and a folder`;
  }

  const own = files.get(MANIFEST);
  if (own?.encoding) return `plugin ${p.name}: ${MANIFEST} must be text`;
  if (own) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(own.content);
    } catch {
      return `plugin ${p.name}: ${MANIFEST} is not valid JSON`;
    }
    const m = manifest as { name?: unknown; version?: unknown };
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || m.name !== p.name) return `plugin ${p.name}: ${MANIFEST} must name the plugin "${p.name}"`;
    if (m.version !== undefined && m.version !== p.version) return `plugin ${p.name}: ${MANIFEST} version must be ${p.version}`;
  } else {
    // `author` keeps `claude plugin validate --strict` quiet; the portal is who ships it.
    const generated = { name: p.name, version: p.version, ...(p.description ? { description: p.description } : {}), author: { name: MARKETPLACE_NAME } };
    files.set(MANIFEST, { path: MANIFEST, content: `${JSON.stringify(generated, null, 2)}\n`, mode: 0o644 });
  }

  const list = [...files.values()];
  const hash = treeHash(list);
  const dir = pluginDir(p.name, hash);
  const sub = new Set<string>();
  for (const f of list) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) sub.add(parts.slice(0, i).join('/'));
  }
  const folder = (path: string): DeliveredDir => ({ path, mode: 0o755, uid: ROOT, gid: ROOT });
  return {
    owner,
    name: p.name,
    version: p.version,
    ...(p.description ? { description: p.description } : {}),
    treeHash: hash,
    dir,
    dirs: [...sub].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).map((s) => folder(`${dir}/${s}`)),
    files: list
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f): DeliveredFile => ({ path: `${dir}/${f.path}`, content: f.content, mode: f.mode, uid: ROOT, gid: ROOT, ...(f.encoding ? { encoding: f.encoding } : {}) })),
  };
}

/** The foundation's catalog: one entry per plugin, pointing at its current version folder. */
export function catalog(plugins: BundlePlugin[]): string {
  return `${JSON.stringify(
    {
      name: MARKETPLACE_NAME,
      owner: { name: MARKETPLACE_NAME },
      metadata: { description: 'Plugins delivered by the claudepilot portal. Managed: local changes are overwritten.' },
      plugins: [...plugins]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({
          name: p.name,
          source: `./${p.dir.slice(MARKETPLACE_DIR.length + 1)}`,
          ...(p.description ? { description: p.description } : {}),
          version: p.version,
        })),
    },
    null,
    2,
  )}\n`;
}

/** What the base drop-in adds: the marketplace, as a local directory Claude Code never updates by itself. */
export const MARKETPLACE_SETTINGS = {
  extraKnownMarketplaces: { [MARKETPLACE_NAME]: { source: { source: 'directory', path: MARKETPLACE_DIR }, autoUpdate: false } },
};

/** The marketplace's shared folders, created only when some plugin is delivered. */
export function marketplaceDirs(plugins: BundlePlugin[]): DeliveredDir[] {
  const folder = (path: string): DeliveredDir => ({ path, mode: 0o755, uid: ROOT, gid: ROOT });
  return [MARKETPLACE_DIR, `${MARKETPLACE_DIR}/.claude-plugin`, PLUGINS_DIR, ...new Set(plugins.map((p) => `${PLUGINS_DIR}/${p.name}`))].map(folder);
}

export const manifestPlugin = (p: BundlePlugin): ManifestPlugin => ({ owner: p.owner, name: p.name, version: p.version, treeHash: p.treeHash });

/** The version folders a manifest says are current, keeping only well-formed entries (a manifest is workspace-writable). */
export function manifestPlugins(m: { plugins?: unknown } | null | undefined): ManifestPlugin[] {
  if (!m || !Array.isArray(m.plugins)) return [];
  return (m.plugins as Partial<ManifestPlugin>[]).filter(
    (p): p is ManifestPlugin => !!p && typeof p.name === 'string' && /^[a-z0-9-]{1,64}$/.test(p.name) && typeof p.treeHash === 'string' && /^[0-9a-f]{64}$/.test(p.treeHash),
  );
}

/**
 * Old version folders kept for sessions that loaded them (skillset §10.5): the previous two of each
 * plugin and any superseded less than 14 days ago, at most 10 folders per plugin counting the current
 * one. Claude Code keeps its own old plugin versions for 14 days too.
 */
export const RETENTION = { previous: 2, maxAgeMs: 14 * 24 * 60 * 60_000, maxFolders: 10 };

/** A version folder that is no longer current, as `pending_deletes` records it. */
export interface RetiredFolder {
  /** Absolute folder path ending in `/`. */
  path: string;
  /** When it stopped being current (epoch ms). */
  since: number;
}

/** `/etc/claudepilot/marketplace/plugins/<name>/<hash12>/` → `<name>`, or null for anything else. */
export function folderPlugin(path: string): string | null {
  const m = /^\/etc\/claudepilot\/marketplace\/plugins\/([a-z0-9-]+)\/([0-9a-f]{12})\/$/.exec(path);
  return m ? m[1]! : null;
}

/**
 * Which retired version folders to delete now. Nothing while stopped (no exec; the next start does it).
 * At a start everything retired goes, since no session survives a restart. Otherwise revoked folders go
 * at once, folders of plugins no longer delivered at all after `graceMs` (MCP set §10.4: "the folders at
 * the next" reconcile), and superseded versions of delivered plugins per `RETENTION`.
 */
export function dueFolders(
  retired: RetiredFolder[],
  ctx: { running: boolean; started: boolean; now: number; current: Set<string>; revoked: Set<string>; graceMs: number },
): string[] {
  if (!ctx.running) return [];
  const valid = retired.filter((r) => folderPlugin(r.path));
  if (ctx.started) return valid.map((r) => r.path);
  const due = new Set<string>();
  const byPlugin = new Map<string, RetiredFolder[]>();
  for (const r of valid) {
    const name = folderPlugin(r.path)!;
    if (ctx.revoked.has(r.path)) due.add(r.path);
    else if (!ctx.current.has(name)) {
      if (ctx.now - r.since >= ctx.graceMs) due.add(r.path);
    } else byPlugin.set(name, [...(byPlugin.get(name) ?? []), r]);
  }
  for (const list of byPlugin.values()) {
    let kept = 0;
    for (const [i, r] of [...list].sort((a, b) => b.since - a.since).entries()) {
      const wanted = i < RETENTION.previous || ctx.now - r.since < RETENTION.maxAgeMs;
      if (wanted && kept < RETENTION.maxFolders - 1) kept++;
      else due.add(r.path);
    }
  }
  return [...due];
}
