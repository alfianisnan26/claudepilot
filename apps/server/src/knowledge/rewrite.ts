// Knowledge: what a link says after the note or file it points at moved (Knowledge PRD FR10). Obsidian
// rewrites links when you rename a file; so does this, in each link's own style: a wikilink keeps its
// heading, block and alias and is a bare name when the new name is still unique; a Markdown link keeps its
// label, its title, its `%20` or `<angle>` spelling and whether it was relative or from the vault root.

import type { ParsedLink } from './markdown.js';
import { folderOf } from './paths.js';
import { linkTextFor, type FileRef, type NameTable } from './resolve.js';

export interface RewriteContext {
  /** The folder of the note the link is in. */
  srcFolder: string;
  /** The moved file as it is now, and the names of the vault after the move (for "is the bare name still unique"). */
  moved: FileRef;
  table: NameTable;
}

/** `to` as a path relative to `fromFolder`: `../x/y.md`, `y.md`. */
export function relativeTo(fromFolder: string, to: string): string {
  const a = fromFolder ? fromFolder.split('/') : [];
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => '..');
  return [...up, ...b.slice(i)].join('/');
}

/** Replaces `new`-able parts of one link's text; returns the new link text. */
export function rewriteLink(raw: string, link: ParsedLink, ctx: RewriteContext): string {
  return link.style === 'wiki' ? rewriteWiki(raw, link, ctx) : rewriteMarkdown(raw, link, ctx);
}

function rewriteWiki(raw: string, link: ParsedLink, ctx: RewriteContext): string {
  const moved = ctx.moved;
  const hadMd = /\.md$/i.test(link.target);
  const pathForm = link.target.includes('/') || link.target.startsWith('.');
  let target: string;
  if (pathForm) {
    const full = moved.kind === 'note' && !hadMd ? moved.path.replace(/\.md$/i, '') : moved.path;
    target = link.target.startsWith('./') || link.target.startsWith('../') ? relativeTo(ctx.srcFolder, full) : full;
  } else {
    const bare = linkTextFor(ctx.table, moved);
    target = hadMd && moved.kind === 'note' ? `${bare}.md` : bare;
  }
  const pipe = /\\\|/.test(raw) ? '\\|' : '|';
  const heading = link.heading !== null ? `#${link.heading}` : '';
  const block = link.block !== null ? `#^${link.block}` : '';
  const alias = link.alias !== null ? `${pipe}${link.alias}` : '';
  return `${link.embed ? '!' : ''}[[${target}${heading}${block}${alias}]]`;
}

const MD = /^(!?\[(?:\\.|[^\]\\\n])*\]\()(\s*)(<[^>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)([\s\S]*)$/;

function rewriteMarkdown(raw: string, link: ParsedLink, ctx: RewriteContext): string {
  const m = MD.exec(raw);
  if (!m) return raw;
  const [, head, gap, destRaw, tail] = m as unknown as [string, string, string, string, string];
  const angle = destRaw.startsWith('<') && destRaw.endsWith('>');
  const inner = angle ? destRaw.slice(1, -1) : destRaw;
  const hash = inner.indexOf('#');
  const fragment = hash >= 0 ? inner.slice(hash) : '';
  const written = hash >= 0 ? inner.slice(0, hash) : inner;
  const encoded = /%[0-9A-Fa-f]{2}/.test(written);
  const rooted = written.startsWith('/');
  const relative = written.startsWith('./') || written.startsWith('../') || (!written.includes('/') && folderOf(ctx.moved.path) === ctx.srcFolder);
  let path = ctx.moved.path;
  if (relative) path = relativeTo(ctx.srcFolder, ctx.moved.path);
  else if (rooted) path = `/${path}`;
  if (encoded) path = path.split('/').map(encodeURIComponent).join('/');
  const needsAngle = !encoded && /[\s()]/.test(path);
  const dest = angle || needsAngle ? `<${path}${fragment}>` : `${path}${fragment}`;
  return `${head}${gap}${dest}${tail}`;
}

/**
 * The text with each of `edits` applied (offsets into the original, non-overlapping), last to first so the
 * earlier offsets stay right.
 */
export function applyEdits(text: string, edits: { start: number; end: number; text: string }[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** A Markdown link written relative to its own note (`./x.md`, `../x.md`): the kind that breaks when the note moves. */
export function isRelativeDest(raw: string): boolean {
  const m = MD.exec(raw);
  if (!m) return false;
  const dest = m[3]!.startsWith('<') ? m[3]!.slice(1, -1) : m[3]!;
  return dest.startsWith('./') || dest.startsWith('../');
}
