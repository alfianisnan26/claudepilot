// SKILL.md frontmatter (Skillset FR5, FR12, FR13): parsed as YAML 1.2 with the core schema only (no
// custom tags), at most 100 aliases and 64 KB, so a hostile header can't expand or run anything; and
// rewritten, when a set asks for it, by changing keys and dumping the mapping again.

import { CORE_SCHEMA, dump, load } from 'js-yaml';

export const FRONTMATTER_MAX_BYTES = 64 * 1024;

export interface ParsedSkillMd {
  /** The mapping between the `---` lines; {} when there is none. */
  frontmatter: Record<string, unknown>;
  /** Whether the file had a frontmatter block at all. */
  present: boolean;
  /** Everything after the closing `---` line (the whole file without frontmatter). */
  body: string;
  /** 1-based line where the body starts, for findings in it. */
  bodyLine: number;
}

export class FrontmatterError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Splits and parses a SKILL.md (or command file). Throws FrontmatterError with a plain reason. */
export function parseSkillMd(text: string): ParsedSkillMd {
  const src = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const lines = src.split('\n');
  if ((lines[0] ?? '').replace(/\r$/, '').trimEnd() !== '---') return { frontmatter: {}, present: false, body: src, bodyLine: 1 };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!.replace(/\r$/, '').trimEnd();
    if (l === '---' || l === '...') {
      end = i;
      break;
    }
  }
  if (end < 0) throw new FrontmatterError('The frontmatter has no closing --- line.');
  const raw = lines.slice(1, end).join('\n');
  if (Buffer.byteLength(raw) > FRONTMATTER_MAX_BYTES) throw new FrontmatterError('The frontmatter is larger than 64 KB.');
  let value: unknown;
  try {
    value = raw.trim() ? load(raw, { schema: CORE_SCHEMA, maxAliases: 100, maxDepth: 50 }) : {};
  } catch (e) {
    const first = String((e as Error).message ?? e).split('\n')[0]!.slice(0, 200);
    throw new FrontmatterError(`The frontmatter isn’t valid YAML 1.2: ${first}`);
  }
  if (value === null || value === undefined) value = {};
  if (!isObject(value)) throw new FrontmatterError('The frontmatter must be a mapping of keys to values.');
  return { frontmatter: value, present: true, body: lines.slice(end + 1).join('\n'), bodyLine: end + 2 };
}

/** A frontmatter value as a short display string. */
export function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** The changes a skillset makes to a skill as it delivers it (FR12, FR13, FR18). */
export interface SkillTransform {
  /** Frontmatter `name` becomes the folder name. */
  name: string;
  /** Manual: `disable-model-invocation: true`, and `user-invocable: false` cleared. */
  manual: boolean;
  /** Remove `allowed-tools`. */
  stripAllowedTools: boolean;
}

/**
 * The SKILL.md as a set delivers it. Untouched (byte for byte) when nothing needs to change, so a
 * delivered file equals the reviewed one whenever it can; otherwise the mapping is dumped again with the
 * core schema (comments in the frontmatter don't survive that; the body always does).
 */
export function transformSkillMd(original: string, t: SkillTransform): string {
  const parsed = parseSkillMd(original);
  const fm = { ...parsed.frontmatter };
  let changed = false;
  if (fm.name !== t.name) {
    // `name` first, as authors write it.
    const { name: _old, ...rest } = fm;
    void _old;
    for (const k of Object.keys(fm)) delete fm[k];
    Object.assign(fm, { name: t.name }, rest);
    changed = true;
  }
  if (t.manual) {
    if (fm['disable-model-invocation'] !== true) {
      fm['disable-model-invocation'] = true;
      changed = true;
    }
    if (fm['user-invocable'] === false) {
      delete fm['user-invocable'];
      changed = true;
    }
  }
  if (t.stripAllowedTools && 'allowed-tools' in fm) {
    delete fm['allowed-tools'];
    changed = true;
  }
  if (!changed) return original;
  const yaml = dump(fm, { schema: CORE_SCHEMA, lineWidth: -1, noRefs: true });
  return `---\n${yaml}---\n${parsed.body}`;
}
