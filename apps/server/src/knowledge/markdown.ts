// Knowledge: reads the structure of one note (Knowledge PRD FR11, §9) without rendering it: frontmatter,
// wikilinks and embeds, Markdown links to notes, #tags, headings, block ids and aliases. It is a scanner,
// not a parser: it masks what Obsidian ignores (fenced and inline code, %% comments %%, HTML comments, $$ math
// $$) and finds the rest with regular expressions, which is fast enough for tens of thousands of notes and
// keeps every offset in the original text, so a rename can rewrite links in place.

import { CORE_SCHEMA, load } from 'js-yaml';
import { knowledgeLimits, type KnowledgeLimits } from './limits.js';

export interface ParsedLink {
  /** `wiki`: `[[…]]` or `![[…]]`. `md`: `[text](path)` or `![alt](path)`. */
  style: 'wiki' | 'md';
  /** An embed: `![[…]]`, `![…](…)`. */
  embed: boolean;
  /** The target as written without its heading or block part, decoded for `md`; '' for a link into the same note. */
  target: string;
  heading: string | null;
  block: string | null;
  /** The text after the `|` of a wikilink (or the size of an embedded image), or the label of a Markdown link. */
  alias: string | null;
  /** `[[ticket:T-12]]` and the like: a link to a portal entity, not a file. */
  entity: { type: string; key: string } | null;
  /** 1-based line of the link in the original text. */
  line: number;
  /** The whole link syntax, as offsets into the original text. */
  start: number;
  end: number;
}

export interface ParsedHeading {
  level: number;
  text: string;
  /** Lowercased and stripped of what links can't carry, for matching `[[Note#Heading]]`. */
  norm: string;
  line: number;
}

export interface ParsedNote {
  hasFrontmatter: boolean;
  /** The text between the `---` lines, or null. */
  frontmatterRaw: string | null;
  /** The mapping, cut down to what the index keeps (small, shallow, text and numbers); {} when there is none or it is invalid. */
  frontmatter: Record<string, unknown>;
  /** Why the block isn't valid YAML, when it isn't. The block stays in the file as it is. */
  frontmatterError: string | null;
  /** Offset in the original text where the body starts (after the closing `---` line). */
  bodyStart: number;
  /** 1-based line where the body starts. */
  bodyLine: number;
  /** Tags, lowercase, without `#`, from the body and from frontmatter. */
  tags: { tag: string; source: 'inline' | 'frontmatter' }[];
  aliases: string[];
  links: ParsedLink[];
  headings: ParsedHeading[];
  blocks: { id: string; line: number }[];
  /** `title` from frontmatter, else the first level-1 heading. */
  title: string | null;
  words: number;
}

const ENTITY = /^(ticket|session|workspace|claude|persona|skillset|mcp):(.+)$/i;

/** What `[[Note#Heading]]` is compared against: Obsidian drops the characters links can't hold. */
export function normHeading(text: string): string {
  return text
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/[*_`~=]/g, '')
    .replace(/[#|^:%[\]\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* ---------- Frontmatter ---------- */

interface FrontmatterBlock {
  raw: string;
  /** Offset of the first character after the closing line (and its newline). */
  end: number;
  /** Lines the block (both `---` lines included) takes. */
  lines: number;
}

/** The block between a first line `---` and the next `---` or `...` line, within `maxBytes`; null if there isn't one. */
function findFrontmatter(text: string, maxBytes: number): FrontmatterBlock | null {
  let pos = text.startsWith('﻿') ? 1 : 0;
  const first = /^---[ \t]*\r?\n/.exec(text.slice(pos, pos + 16));
  if (!first) return null;
  pos += first[0].length;
  const startRaw = pos;
  let lines = 1;
  while (pos <= text.length) {
    if (pos - startRaw > maxBytes + 8) return null;
    let eol = text.indexOf('\n', pos);
    if (eol < 0) eol = text.length;
    const line = text.slice(pos, eol).replace(/\r$/, '').trimEnd();
    lines++;
    if (line === '---' || line === '...') {
      return { raw: text.slice(startRaw, pos).replace(/\r?\n$/, ''), end: Math.min(text.length, eol + 1), lines };
    }
    if (eol >= text.length) return null;
    pos = eol + 1;
  }
  return null;
}

/** A value reduced to something small and plain: depth, node count and string length are bounded, so a hostile block can't expand. */
function limitValue(value: unknown, budget: { nodes: number }, depth = 0): unknown {
  if (budget.nodes-- <= 0) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 3) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => limitValue(v, budget, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= 100) break;
      out[k.slice(0, 100)] = limitValue(v, budget, depth + 1);
    }
    return out;
  }
  return String(value);
}

const TAG_BODY = /^[\p{L}\p{N}\p{M}_\-/]+$/u;

/** A tag as the index keeps it: no `#`, lowercase, no trailing slash, at least one non-digit; null when it isn't one. */
export function cleanTag(raw: string): string | null {
  const t = raw.trim().replace(/^#+/, '').replace(/\/+$/, '').toLowerCase();
  if (!t || t.length > 100 || !TAG_BODY.test(t) || !/[^\d/]/.test(t)) return null;
  return t;
}

function listOf(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : value === null || value === undefined ? [] : [value];
  return items.filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => String(v).trim()).filter(Boolean);
}

function tagList(value: unknown): string[] {
  // `tags: a, b c` and `tags: [a, b]` and a block list all work; spaces separate tags in a string.
  const items = typeof value === 'string' ? value.split(/[,\s]+/) : listOf(value);
  const out: string[] = [];
  for (const raw of items) {
    const tag = cleanTag(raw);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/* ---------- Masking ---------- */

const blank = (s: string) => s.replace(/[^\n\r]/g, ' ');

/**
 * The text with everything Obsidian doesn't read as Markdown (code, comments, math blocks, and the
 * frontmatter) replaced by spaces, newlines kept, so offsets and line numbers still match the original.
 */
export function maskText(text: string, bodyStart: number): string {
  let out = blank(text.slice(0, bodyStart));
  const body = text.slice(bodyStart);
  // 1. Fenced code, line by line (a fence closes with the same character and at least as many).
  const lines = body.split('\n');
  let fence: { ch: string; len: number } | null = null;
  const masked: string[] = [];
  for (const line of lines) {
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.ch === '`' ? '`' : '~'}{${fence.len},}[ \\t\\r]*$`);
      masked.push(blank(line));
      if (close.test(line)) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line.replace(/\r$/, ''));
    if (open) {
      fence = { ch: open[1]![0]!, len: open[1]!.length };
      masked.push(blank(line));
      continue;
    }
    masked.push(line);
  }
  let rest = masked.join('\n');
  // 2. Inline code, within a line.
  rest = rest.replace(/(`+)(?!`)([^\n]*?[^`\n]|[^`\n]?)\1(?!`)/g, (m) => blank(m));
  // 3. Comments and display math, which may span lines.
  rest = rest.replace(/%%[\s\S]*?%%/g, blank).replace(/<!--[\s\S]*?-->/g, blank).replace(/\$\$[\s\S]*?\$\$/g, blank);
  out += rest;
  return out;
}

/* ---------- The scan ---------- */

const WIKILINK = /(!?)\[\[([^[\]\n]{1,512}?)\]\]/g;
const MDLINK = /(!?)\[((?:\\.|[^\]\\\n])*)\]\(\s*(<[^>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const TAG_AT = /(?<![^\s])#([\p{L}\p{N}\p{M}_\-/]+)/gu;
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]{1,64})\s*$/;
const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function splitFragment(target: string): { path: string; heading: string | null; block: string | null } {
  const hash = target.indexOf('#');
  if (hash < 0) return { path: target, heading: null, block: null };
  const path = target.slice(0, hash);
  const frag = target.slice(hash + 1).trim();
  if (frag.startsWith('^')) return { path, heading: null, block: frag.slice(1) || null };
  return { path, heading: frag || null, block: null };
}

function decode(dest: string): string {
  try {
    return decodeURIComponent(dest);
  } catch {
    return dest;
  }
}

/** Reads one note. `text` is the file as a string (a leading byte-order mark is read past). */
export function parseNote(text: string, limits: KnowledgeLimits = knowledgeLimits()): ParsedNote {
  const fmBlock = findFrontmatter(text, limits.frontmatterBytes);
  const bodyStart = fmBlock ? fmBlock.end : text.startsWith('﻿') ? 1 : 0;
  let frontmatter: Record<string, unknown> = {};
  let frontmatterError: string | null = null;
  let fmTags: string[] = [];
  let aliases: string[] = [];
  let title: string | null = null;
  if (fmBlock) {
    try {
      const value = fmBlock.raw.trim() ? load(fmBlock.raw, { schema: CORE_SCHEMA, maxAliases: 100, maxDepth: 50 }) : {};
      if (value === null || value === undefined) {
        frontmatter = {};
      } else if (typeof value !== 'object' || Array.isArray(value)) {
        frontmatterError = 'The frontmatter must be a mapping of keys to values.';
      } else {
        const raw = value as Record<string, unknown>;
        fmTags = tagList(raw.tags ?? raw.tag);
        aliases = [...new Set(listOf(raw.aliases ?? raw.alias))].slice(0, 50);
        if (typeof raw.title === 'string' && raw.title.trim()) title = raw.title.trim().slice(0, 300);
        const kept = limitValue(raw, { nodes: 2000 }) as Record<string, unknown>;
        frontmatter = JSON.stringify(kept).length > limits.propsBytes ? { _truncated: true, ...Object.fromEntries(Object.entries(kept).slice(0, 12)) } : kept;
        if (JSON.stringify(frontmatter).length > limits.propsBytes) frontmatter = { _truncated: true };
      }
    } catch (e) {
      frontmatterError = `Not valid YAML: ${String((e as Error).message ?? e).split('\n')[0]!.slice(0, 160)}`;
    }
  }

  const masked = maskText(text, bodyStart);
  const starts = lineStarts(text);
  const links: ParsedLink[] = [];
  const tags: ParsedNote['tags'] = fmTags.map((tag) => ({ tag, source: 'frontmatter' }));
  const seenTags = new Set(fmTags);

  for (const m of masked.matchAll(WIKILINK)) {
    if (links.length >= limits.linksPerNote) break;
    const inner = m[2]!;
    const pipe = /^(.*?)\\?\|(.*)$/s.exec(inner);
    const rawTarget = (pipe ? pipe[1]! : inner).trim();
    const alias = pipe ? pipe[2]!.trim() || null : null;
    const { path, heading, block } = splitFragment(rawTarget);
    if (!path && !heading && !block) continue;
    const entity = ENTITY.exec(rawTarget);
    links.push({
      style: 'wiki',
      embed: m[1] === '!',
      target: entity ? rawTarget : path.trim(),
      heading: entity ? null : heading,
      block: entity ? null : block,
      alias,
      entity: entity ? { type: entity[1]!.toLowerCase(), key: entity[2]!.trim() } : null,
      line: lineAt(starts, m.index),
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  for (const m of masked.matchAll(MDLINK)) {
    if (links.length >= limits.linksPerNote) break;
    let dest = m[3]!;
    if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1);
    dest = dest.trim();
    if (!dest || SCHEME.test(dest) || dest.startsWith('//')) continue;
    const decoded = decode(dest);
    const { path, heading, block } = splitFragment(decoded);
    // Only links that point at a file of the vault: a path, a `.md` note or an attachment.
    if (!path && !heading && !block) continue;
    const target = path.replace(/^\.\//, '');
    links.push({
      style: 'md',
      embed: m[1] === '!',
      target,
      heading,
      block,
      alias: m[2]!.replace(/\\(.)/g, '$1') || null,
      entity: null,
      line: lineAt(starts, m.index),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  links.sort((a, b) => a.start - b.start);

  // Tags: in the body, where a `#` starts a word.
  for (const m of masked.matchAll(TAG_AT)) {
    if (tags.length >= limits.tagsPerNote) break;
    const tag = cleanTag(m[1]!);
    if (tag && !seenTags.has(tag)) {
      seenTags.add(tag);
      tags.push({ tag, source: 'inline' });
    }
  }

  // Headings and block ids, line by line over the masked text.
  const headings: ParsedHeading[] = [];
  const blocks: { id: string; line: number }[] = [];
  const mlines = masked.split('\n');
  const firstBody = lineAt(starts, bodyStart);
  for (let i = firstBody - 1; i < mlines.length; i++) {
    const line = mlines[i]!;
    const atx = ATX.exec(line);
    if (atx) {
      const textOf = atx[2]!.trim();
      if (textOf) headings.push({ level: atx[1]!.length, text: textOf, norm: normHeading(textOf), line: i + 1 });
    } else if (line.trim() && !/^\s*(?:[-*+>|]|\d+[.)])\s/.test(line) && !/^\s{4}/.test(line)) {
      const next = mlines[i + 1];
      const setext = next === undefined ? null : /^ {0,3}(=+|-+)[ \t]*\r?$/.exec(next);
      if (setext && !/^\s*[-=]+\s*$/.test(line)) {
        const textOf = line.trim();
        headings.push({ level: setext[1]!.startsWith('=') ? 1 : 2, text: textOf, norm: normHeading(textOf), line: i + 1 });
      }
    }
    const block = BLOCK_ID.exec(line.replace(/\r$/, ''));
    if (block) blocks.push({ id: block[1]!, line: i + 1 });
  }
  if (!title) {
    const h1 = headings.find((h) => h.level === 1);
    if (h1) title = h1.text.slice(0, 300);
  }

  const bodyText = text.slice(bodyStart);
  const words = bodyText.trim() ? bodyText.trim().split(/\s+/).length : 0;
  return {
    hasFrontmatter: !!fmBlock,
    frontmatterRaw: fmBlock ? fmBlock.raw : null,
    frontmatter,
    frontmatterError,
    bodyStart,
    bodyLine: lineAt(starts, bodyStart),
    tags,
    aliases,
    links,
    headings,
    blocks,
    title,
    words,
  };
}

/**
 * The text of the section under a heading: from the heading line to the next heading of the same or a
 * higher level (or the end). Returns null when there is no such heading. `norm` is compared with
 * `normHeading`; the first match wins.
 */
export function sectionOf(text: string, parsed: ParsedNote, headingNorm: string): { start: number; end: number } | null {
  const h = parsed.headings.find((x) => x.norm === headingNorm);
  if (!h) return null;
  const starts = lineStarts(text);
  const start = starts[h.line - 1] ?? 0;
  const next = parsed.headings.find((x) => x.line > h.line && x.level <= h.level);
  const end = next ? (starts[next.line - 1] ?? text.length) : text.length;
  return { start, end };
}

/**
 * Where text added "under a heading" goes: the end of that section, before the next heading, with trailing
 * blank lines kept after the new text. Returns the offset, or null when the heading doesn't exist.
 */
export function endOfSection(text: string, parsed: ParsedNote, headingNorm: string): number | null {
  const s = sectionOf(text, parsed, headingNorm);
  if (!s) return null;
  let end = s.end;
  // Back up over trailing blank lines so the addition sits right after the section's last text line.
  while (end > s.start && /\s/.test(text[end - 1]!)) end--;
  return end;
}
