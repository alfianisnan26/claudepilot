import type { SkillsetMode } from '@portal/contracts';
import { compilePlugin, treeHash } from '../delivery/marketplace.js';
import type { PluginBundle } from '../delivery/types.js';
import { transformSkillMd } from './frontmatter.js';
import type { LibraryVersion, SkillsLibrary } from './library.js';
import { isText } from './scan.js';

/** One skill as a set lists it in a revision (`pool_revisions.content`, Skillset §9). */
export interface StoredEntry {
  versionId: string;
  treeHash: string;
  mode: SkillsetMode;
  stripAllowedTools: boolean;
}

export interface StoredSkillset {
  prefix: string;
  skills: StoredEntry[];
}

/** A set compiled into its plugin for one revision. */
export interface CompiledSet {
  /** Null when nothing in the set can be delivered (every skill off, unapproved or revoked). */
  bundle: PluginBundle | null;
  /** The version folder's name: the first 12 hex digits of the compiled plugin's tree hash. */
  hash12: string | null;
  /** Skill names delivered, and the tree hashes behind them. */
  skills: { name: string; treeHash: string; mode: SkillsetMode; scripted: boolean }[];
  /** Skills listed but not delivered, with why. */
  leftOut: { name: string; reason: string }[];
}

/** Why a listed skill isn't delivered, by its review state. */
const LEFT_OUT = {
  needs_review: 'Not approved yet.',
  rejected: 'Rejected.',
  revoked: 'Revoked.',
} as const;

/**
 * Compiles one set at one revision into the plugin a workspace gets (Skillset §10.2): `skills/<name>/`
 * per approved skill that isn't Off, with the version's files byte for byte except SKILL.md's FR12 and
 * FR13 transforms; scripts the review marked executable 0755, everything else 0644. The plugin's version
 * is `<revision>.0.0+<hash8>`, where hash8 labels the skills it carries.
 *
 * `preview`: binary files become a short placeholder, since "Preview files" shows text.
 */
export function compileSet(
  library: SkillsLibrary,
  pool: { name: string; revision: number },
  content: StoredSkillset,
  opts: { preview?: boolean } = {},
): CompiledSet {
  const versions = library.versions(content.skills.map((s) => s.versionId));
  const reviews = library.reviewStates(content.skills.map((s) => s.treeHash));
  const files: PluginBundle['files'] = [];
  const skills: CompiledSet['skills'] = [];
  const leftOut: CompiledSet['leftOut'] = [];
  for (const entry of content.skills) {
    if (entry.mode === 'off') continue;
    const v: LibraryVersion | undefined = versions.get(entry.versionId);
    if (!v || v.treeHash !== entry.treeHash) {
      leftOut.push({ name: v?.name ?? 'Removed skill', reason: 'The version no longer exists.' });
      continue;
    }
    const state = reviews.get(v.treeHash)?.state ?? 'needs_review';
    if (state !== 'approved') {
      leftOut.push({ name: v.name, reason: LEFT_OUT[state] });
      continue;
    }
    const own: PluginBundle['files'] = [];
    let missing = false;
    for (const f of library.files(v.id)) {
      const bytes = library.blob(f.blob_sha256);
      if (!bytes) {
        missing = true;
        break;
      }
      const path = `skills/${v.name}/${f.path}`;
      if (f.path === 'SKILL.md') {
        const md = transformSkillMd(bytes.toString('utf8'), { name: v.name, manual: entry.mode === 'manual', stripAllowedTools: entry.stripAllowedTools && v.allowedTools });
        own.push({ path, content: md, mode: 0o644 });
      } else if (isText(bytes)) own.push({ path, content: bytes.toString('utf8'), mode: f.mode });
      else if (opts.preview) own.push({ path, content: `‹binary file, ${bytes.length.toLocaleString('en')} bytes›`, mode: f.mode });
      else own.push({ path, content: bytes.toString('base64'), mode: f.mode, encoding: 'base64' });
    }
    if (missing) {
      leftOut.push({ name: v.name, reason: 'Its files are missing from the blob store. Import it again.' });
      continue;
    }
    files.push(...own);
    skills.push({ name: v.name, treeHash: v.treeHash, mode: entry.mode, scripted: v.scripted });
  }
  if (!skills.length) return { bundle: null, hash12: null, skills, leftOut };
  const bundle: PluginBundle = {
    name: content.prefix,
    version: `${pool.revision}.0.0+${treeHash(files).slice(0, 8)}`,
    description: pool.name.slice(0, 200),
    files,
  };
  const compiled = compilePlugin('skillset', bundle);
  // An invalid set is caught by the delivery compiler with the same message; no folder name then.
  const hash12 = typeof compiled === 'string' ? null : compiled.treeHash.slice(0, 12);
  return { bundle, hash12, skills, leftOut };
}
