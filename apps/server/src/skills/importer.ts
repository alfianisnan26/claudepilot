// Upload import (Skillset FR1, FR5, FR6): finds skills in an upload, checks and scans each one, and
// stores new skill versions with their files in the blob store. Nothing in the upload is ever executed
// or written to disk as a tree; skill files only ever exist as content-addressed blobs.
//
// What counts as a skill, up to four folders deep (FR1): a folder with a SKILL.md; the skills and command
// files of a plugin (`.claude-plugin/plugin.json`); the plugins a marketplace (`.claude-plugin/
// marketplace.json`) lists with relative sources; and loose `commands/` folders. Command files become
// skills named after their path. Every other plugin part is listed as not imported (§4).

import { createHash } from 'node:crypto';
import { SKILL_UPLOAD_LIMITS, type SkillImportItem, type SkillImportResult, type SkillReviewState } from '@portal/contracts';
import type { ArchiveEntry } from './archive.js';
import { FrontmatterError, parseSkillMd, text } from './frontmatter.js';
import { scanSkill, type ScanResult } from './scan.js';

/** A skill found in an upload, before it is checked. */
export interface FoundSkill {
  /** Folder in the upload ('' for the upload's root), or the command file's path. */
  pathInSource: string;
  /** The folder's own name, which the skill's name should match; null for a converted command. */
  folder: string | null;
  /** Files relative to the skill folder (SKILL.md at the top). */
  files: { path: string; mode: number; data: Buffer }[];
  /** For a converted command: the command it was and the skill name it becomes. */
  command: { from: string; name: string } | null;
  /** Why it can't be imported, found while gathering it (symlinks, special files). */
  problems: string[];
}

/** A checked skill, ready to store. */
export interface CheckedSkill {
  found: FoundSkill;
  name: string;
  frontmatter: Record<string, unknown>;
  scan: ScanResult;
  treeHash: string;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const basename = (p: string) => p.split('/').pop() ?? p;
const depth = (dir: string) => (dir ? dir.split('/').length : 0);
const join = (a: string, b: string) => (a ? (b ? `${a}/${b}` : a) : b);
const under = (path: string, dir: string) => !dir || path === dir || path.startsWith(`${dir}/`);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Skillset FR6: SHA-256 over one `<mode> <path>\0<sha256>\n` line per file, paths NFC-normalized and
 * sorted bytewise, modes written as `0644` or `0755`. The same definition as the delivery engine's
 * `treeHash`, over bytes rather than text.
 */
export function skillTreeHash(files: { path: string; mode: number; data: Buffer }[]): string {
  const lines = files
    .map((f) => ({ path: Buffer.from(f.path.normalize('NFC')), mode: f.mode & 0o111 ? '0755' : '0644', hash: sha256(f.data) }))
    .sort((a, b) => Buffer.compare(a.path, b.path));
  const h = createHash('sha256');
  for (const l of lines) h.update(Buffer.concat([Buffer.from(`${l.mode} `), l.path, Buffer.from(`\0${l.hash}\n`)]));
  return h.digest('hex');
}

/** Normalizes `rel` against `base` inside the upload; null when it leaves the upload. */
function resolveIn(base: string, rel: string): string | null {
  if (rel.startsWith('/')) return null;
  const out = base ? base.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

/** Paths a manifest field names (a string or a list of strings), relative to `root`. */
function manifestPaths(root: string, v: unknown): string[] {
  const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return list.map((p) => resolveIn(root, p)).filter((p): p is string => p !== null);
}

/** What a plugin carries besides skills and commands, and why a skillset leaves it out (§4). */
const NOT_IMPORTED: [RegExp, string][] = [
  [/^agents$/, 'Subagents belong in a Persona.'],
  [/^output-styles$/, 'Output styles belong in a Persona.'],
  [/^hooks$|^hooks\.json$/, 'Hooks aren’t delivered: they run unprompted.'],
  [/^\.mcp\.json$/, 'MCP servers belong in an MCP set.'],
  [/^\.lsp\.json$/, 'LSP servers aren’t delivered: they run unprompted.'],
  [/^monitors$/, 'Monitors aren’t delivered: they run unprompted.'],
  [/^bin$/, 'Commands on the PATH aren’t delivered.'],
  [/^workflows$/, 'Workflows aren’t delivered.'],
  [/^settings\.json$/, 'Plugin settings aren’t delivered.'],
  [/^CLAUDE\.md$/, 'A CLAUDE.md belongs in a Persona.'],
];

/**
 * Finds the skills in an upload (FR1). `rootName` names a skill whose SKILL.md sits at the upload's root
 * (a zip of one skill's contents): the upload's file name without `.zip`.
 */
export function findSkills(entries: ArchiveEntry[], rootName: string | null): { skills: FoundSkill[]; notImported: SkillImportResult['notImported']; refused: SkillImportResult['refused'] } {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const dirs = new Set<string>(['']);
  for (const e of entries) for (let d = dirname(e.path); d; d = dirname(d)) dirs.add(d);
  const notImported: SkillImportResult['notImported'] = [];
  const refused: SkillImportResult['refused'] = [];
  const skills: FoundSkill[] = [];
  const claimed = new Set<string>(); // skill folders and command files already taken
  const pluginRoots: string[] = [];

  const skillFolders = [...dirs].filter((d) => byPath.has(join(d, 'SKILL.md')));
  /** A skill folder's files, without nested skill folders, with inward symlinks copied. */
  const gather = (dir: string, command: FoundSkill['command'], pathInSource: string): FoundSkill => {
    const problems: string[] = [];
    const nested = skillFolders.filter((d) => d !== dir && under(d, dir));
    const files: FoundSkill['files'] = [];
    for (const e of entries) {
      if (!under(e.path, dir) || e.path === dir || nested.some((n) => under(e.path, n))) continue;
      const rel = dir ? e.path.slice(dir.length + 1) : e.path;
      if (e.type === 'special') {
        problems.push(`${rel} is a device or other special file.`);
        continue;
      }
      if (e.type === 'file') {
        files.push({ path: rel, mode: e.mode, data: e.data });
        continue;
      }
      // Inward symlinks become copies of the file they point to; anything else refuses the skill (FR5).
      let link = e;
      let target: string | null = null;
      for (let hops = 0; hops < 8 && link.type === 'symlink'; hops++) {
        target = resolveIn(dirname(link.path), link.data.toString('utf8'));
        const next = target === null ? undefined : byPath.get(target);
        if (target === null || !under(target, dir) || target === dir) {
          target = null;
          break;
        }
        if (!next) break;
        link = next;
      }
      if (target === null) problems.push(`${rel} is a symlink that points outside the skill folder.`);
      else if (link.type !== 'file') problems.push(`${rel} is a symlink to a folder, a missing file or a loop.`);
      else files.push({ path: rel, mode: link.mode, data: link.data });
    }
    return { pathInSource, folder: dir ? basename(dir) : rootName, files, command, problems };
  };
  const addSkillFolder = (dir: string) => {
    if (claimed.has(dir)) return;
    claimed.add(dir);
    skills.push(gather(dir, null, dir || '.'));
  };
  /** One command file as a converted skill; `rel` is its path under the commands folder, without `.md`. */
  const addCommand = (e: ArchiveEntry, rel: string, plugin: string | null) => {
    if (claimed.has(e.path)) return;
    claimed.add(e.path);
    const segments = rel.split('/');
    const found: FoundSkill = {
      pathInSource: e.path,
      folder: null,
      files: [],
      command: { from: plugin ? `/${plugin}:${segments.join(':')}` : `/${segments.join(':')}`, name: segments.join('-') },
      problems: [],
    };
    if (e.type === 'file') found.files.push({ path: 'SKILL.md', mode: 0o644, data: e.data });
    else found.problems.push(`${e.path} is a symlink or special file; command files must be plain files.`);
    skills.push(found);
  };
  /** Command files under `dir` (recursively), as converted skills. `plugin` names their old namespace. */
  const addCommands = (dir: string, plugin: string | null) => {
    for (const e of entries) if (under(e.path, dir) && e.path !== dir && e.path.endsWith('.md')) addCommand(e, e.path.slice(dir ? dir.length + 1 : 0, -3), plugin);
  };
  /** One plugin: its skills and commands, and what else it carries (not imported). */
  const addPlugin = (root: string, name: string, manifest: Record<string, unknown>) => {
    if (pluginRoots.includes(root)) return;
    pluginRoots.push(root);
    const skillDirs = [join(root, 'skills'), ...manifestPaths(root, manifest.skills)];
    for (const sd of new Set(skillDirs)) {
      if (byPath.has(join(sd, 'SKILL.md'))) addSkillFolder(sd);
      for (const d of skillFolders) if (dirname(d) === sd) addSkillFolder(d);
    }
    const commandPaths = [join(root, 'commands'), ...manifestPaths(root, manifest.commands)];
    for (const cp of new Set(commandPaths)) {
      const e = byPath.get(cp);
      if (e && cp.endsWith('.md')) addCommand(e, basename(cp).slice(0, -3), name);
      else addCommands(cp, name);
    }
    const top = new Set<string>();
    for (const e of entries) if (under(e.path, root) && e.path !== root) top.add((root ? e.path.slice(root.length + 1) : e.path).split('/')[0]!);
    for (const t of top) {
      const why = NOT_IMPORTED.find(([re]) => re.test(t))?.[1];
      if (why) notImported.push({ path: join(root, t), reason: why });
    }
    for (const [key, why] of [
      ['hooks', 'Hooks aren’t delivered: they run unprompted.'],
      ['mcpServers', 'MCP servers belong in an MCP set.'],
      ['agents', 'Subagents belong in a Persona.'],
      ['outputStyles', 'Output styles belong in a Persona.'],
      ['lspServers', 'LSP servers aren’t delivered: they run unprompted.'],
    ] as const)
      if (manifest[key] !== undefined && !notImported.some((n) => n.path === join(root, key))) notImported.push({ path: `${join(root, '.claude-plugin/plugin.json')} (${key})`, reason: why });
  };
  const readJson = (path: string): Record<string, unknown> | null => {
    const e = byPath.get(path);
    if (!e || e.type !== 'file') return null;
    try {
      const v: unknown = JSON.parse(e.data.toString('utf8'));
      return isObject(v) ? v : null;
    } catch {
      refused.push({ path, reason: 'Not valid JSON.' });
      return null;
    }
  };

  const shallow = [...dirs].filter((d) => depth(d) <= SKILL_UPLOAD_LIMITS.depth).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  // Marketplaces first: their entries may name plugins anywhere in the upload.
  for (const d of shallow) {
    const m = readJson(join(d, '.claude-plugin/marketplace.json'));
    if (!m) continue;
    const pluginRoot = isObject(m.metadata) && typeof m.metadata.pluginRoot === 'string' ? resolveIn(d, m.metadata.pluginRoot) : d;
    for (const entry of Array.isArray(m.plugins) ? m.plugins : []) {
      if (!isObject(entry)) continue;
      const name = typeof entry.name === 'string' ? entry.name : '?';
      if (typeof entry.source !== 'string') {
        const kind = isObject(entry.source) && typeof entry.source.source === 'string' ? entry.source.source : 'unknown';
        notImported.push({ path: `${join(d, '.claude-plugin/marketplace.json')} (${name})`, reason: `A ${kind} plugin source: import it from its repository instead.` });
        continue;
      }
      const base = entry.source.startsWith('./') || entry.source.startsWith('../') ? d : (pluginRoot ?? d);
      const root = resolveIn(base, entry.source);
      if (root === null || !under(root, d) || !dirs.has(root)) {
        refused.push({ path: `${join(d, '.claude-plugin/marketplace.json')} (${name})`, reason: 'Its source path leaves the marketplace or doesn’t exist in the upload.' });
        continue;
      }
      const own = readJson(join(root, '.claude-plugin/plugin.json'));
      // `strict: false` entries describe the plugin themselves (their skills and commands paths).
      addPlugin(root, typeof own?.name === 'string' ? own.name : name, own ?? entry);
    }
  }
  for (const d of shallow) {
    const m = readJson(join(d, '.claude-plugin/plugin.json'));
    if (m) addPlugin(d, typeof m.name === 'string' ? m.name : basename(d) || (rootName ?? 'plugin'), m);
  }
  const inPlugin = (p: string) => pluginRoots.some((r) => under(p, r));
  for (const d of shallow) if (byPath.has(join(d, 'SKILL.md')) && !inPlugin(d)) addSkillFolder(d);
  const inSkill = (p: string) => skillFolders.some((sf) => under(p, sf));
  for (const d of shallow) if (basename(d) === 'commands' && !inPlugin(d) && !inSkill(d)) addCommands(d, null);
  for (const d of skillFolders)
    if (!claimed.has(d))
      notImported.push({ path: join(d, 'SKILL.md'), reason: inPlugin(d) ? 'Not in one of the plugin’s skills folders.' : `Deeper than ${SKILL_UPLOAD_LIMITS.depth} folders.` });
  const once = (list: { path: string; reason: string }[]) => list.filter((x, i) => list.findIndex((y) => y.path === x.path && y.reason === x.reason) === i);
  return { skills, notImported: once(notImported), refused: once(refused) };
}

/** Parses, names and scans one found skill: refused (with reasons) or ready to store. */
export function checkSkill(found: FoundSkill): { skill: CheckedSkill } | { refused: string[] } {
  const reasons = [...found.problems];
  const md = found.files.find((f) => f.path === 'SKILL.md');
  if (!md) return { refused: ['It has no SKILL.md.'] };
  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = parseSkillMd(md.data.toString('utf8')).frontmatter;
  } catch (e) {
    if (e instanceof FrontmatterError) return { refused: [...reasons, e.message] };
    throw e;
  }
  const declared = text(frontmatter.name).trim();
  const name = found.command ? found.command.name : declared || found.folder || 'skill';
  const scan = scanSkill({ name, folder: found.command ? null : found.folder, frontmatter, files: found.files });
  reasons.push(...scan.refused);
  if (reasons.length) return { refused: [...new Set(reasons)] };
  // Hashed with the modes the review shows (and delivery uses): executable only when marked so.
  const treeHash = skillTreeHash(scan.files.map((f) => ({ path: f.path, mode: f.mode, data: f.data })));
  return { skill: { found, name, frontmatter, scan, treeHash } };
}

/** Counts findings by tier, for the import summary. */
export const findingCounts = (scan: ScanResult): SkillImportItem['findings'] => ({
  high: scan.findings.filter((f) => f.tier === 'high').length,
  medium: scan.findings.filter((f) => f.tier === 'medium').length,
  low: scan.findings.filter((f) => f.tier === 'low').length,
});

export type { SkillReviewState };
