import { valueCut, wordRanges } from './words';

/**
 * The reveal as a rehype step: it cuts the rendered document of one Markdown block at the point the reveal has
 * reached and wraps the words before it in spans, so what shows is always well-formed Markdown output (a list
 * is a list, a table a table) whose last words are still arriving. The text was parsed whole (everything that
 * has arrived), so `**bold**` is bold as soon as its words show, not after its closing marker; the cut only
 * decides how much of the result is visible.
 *
 * Positions come from the source offsets the parser puts on every node: nothing after `cut` is kept, words end
 * at word boundaries, and a block that cannot show half of itself appears whole: a code block line by line,
 * a table row at a time, inline code and images as one piece.
 *
 * Words get `mo-w` while they play their animation and `mo-s` once they are plain (older than `staticCut`): both
 * are the same element, only the class changes, so React keeps old words untouched and a word's animation
 * runs once, when it first mounts.
 */
export interface RevealOptions {
  /** How far into this block's source the reveal has reached (an offset at a word boundary). */
  cut: number;
  /** Words that end at or before this offset have finished their animation. */
  staticCut: number;
}

/** The parts of a hast node this needs (typed here so the plugin has no dependency on the hast types). */
export interface HNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

interface Ctx extends RevealOptions {
  source: string;
}

export const WORD_FRESH = 'mo-w';
export const WORD_STILL = 'mo-s';

/** Elements with no text of their own: kept once their start has been reached. */
const VOID = new Set(['br', 'hr', 'img', 'input']);

const span = (children: HNode[], fresh: boolean): HNode => ({
  type: 'element',
  tagName: 'span',
  properties: { className: [fresh ? WORD_FRESH : WORD_STILL] },
  children,
});

/** The plugin: `[rehypeReveal, { cut, staticCut }]`. */
export function rehypeReveal(options: RevealOptions) {
  return (tree: HNode, file: { value?: unknown }): void => {
    const source = typeof file.value === 'string' ? file.value : String(file.value ?? '');
    walk(tree, { ...options, source });
  };
}

/** Cuts `parent`'s children at the reveal point. Returns whether the cut was reached inside it. */
function walk(parent: HNode, ctx: Ctx): boolean {
  const kids = parent.children;
  if (!kids) return false;
  const out: HNode[] = [];
  let reached = false;
  for (const kid of kids) {
    const start = kid.position?.start.offset;
    if (start !== undefined && start >= ctx.cut) {
      reached = true;
      break;
    }
    if (kid.type === 'text') {
      const r = revealText(kid, ctx);
      out.push(...r.nodes);
      if (r.reached) {
        reached = true;
        break;
      }
    } else if (kid.type === 'element') {
      const r = revealElement(kid, ctx);
      if (r.node) out.push(r.node);
      if (r.reached) {
        reached = true;
        break;
      }
    } else if (kid.type === 'raw') {
      // Raw HTML shows as text, in one piece.
      const end = kid.position?.end.offset;
      if (end !== undefined && end > ctx.cut) {
        reached = true;
        break;
      }
      out.push(kid);
    } else out.push(kid);
  }
  parent.children = out;
  return reached;
}

/** What of an element shows: the node to keep (itself, or a wrapper for the reveal), or none; and whether the cut was reached in it. */
function revealElement(el: HNode, ctx: Ctx): { node: HNode | null; reached: boolean } {
  const end = el.position?.end.offset;
  switch (el.tagName) {
    case 'pre':
      return revealCode(el, ctx);
    // Inline code is one piece: a command never shows half of itself.
    case 'code':
      if (end !== undefined && end > ctx.cut) return { node: null, reached: true };
      mark(el, end !== undefined && end > ctx.staticCut);
      return { node: el, reached: false };
    // A table row shows whole (its cells would otherwise change the column widths word by word).
    case 'tr': {
      if (end !== undefined && end > ctx.cut) return { node: null, reached: true };
      const fresh = end !== undefined && end > ctx.staticCut;
      for (const cell of el.children ?? []) {
        if (cell.type === 'element') cell.children = [span(cell.children ?? [], fresh)];
      }
      return { node: el, reached: false };
    }
  }
  const reached = walk(el, ctx);
  // Nothing of it is revealed yet (an item whose first word has not shown): it does not show either. (The
  // newlines the parser puts between block elements are not content.)
  const empty = !el.children?.some((c) => c.type !== 'text' || (c.value ?? '').trim() !== '');
  if (empty && !VOID.has(el.tagName ?? '')) return { node: null, reached };
  return { node: el, reached };
}

/**
 * A fenced code block shows the lines the reveal has passed, whole, in a frame that comes into focus once (a
 * wrapper element: the code block's own component draws the card, and it is the card that appears).
 */
function revealCode(pre: HNode, ctx: Ctx): { node: HNode | null; reached: boolean } {
  const s = pre.position?.start.offset;
  const e = pre.position?.end.offset;
  const code = pre.children?.find((c) => c.type === 'element' && c.tagName === 'code');
  const text = code?.children?.[0];
  if (s === undefined || e === undefined || !text || text.type !== 'text') return { node: pre, reached: false };
  const frame = (reached: boolean) => ({ node: { type: 'element', tagName: 'div', properties: { className: [e > ctx.staticCut ? WORD_FRESH : WORD_STILL] }, children: [pre] }, reached });
  if (e <= ctx.cut) return frame(false);
  // The first newline ends the opening fence; each newline after it ends a line of code.
  let newlines = 0;
  for (let i = ctx.source.indexOf('\n', s); i >= 0 && i < ctx.cut; i = ctx.source.indexOf('\n', i + 1)) newlines++;
  const lines = newlines - 1;
  if (lines <= 0) return { node: null, reached: true };
  text.value = `${(text.value ?? '').split('\n').slice(0, lines).join('\n')}\n`;
  return frame(true);
}

function revealText(node: HNode, ctx: Ctx): { nodes: HNode[]; reached: boolean } {
  const value = node.value ?? '';
  const s = node.position?.start.offset;
  const e = node.position?.end.offset;
  // No position: the newline the parser puts between block elements.
  if (s === undefined || e === undefined) return { nodes: [node], reached: false };
  const whole = e <= ctx.cut;
  const source = ctx.source.slice(s, e);
  const limit = whole ? value.length : valueCut(value, source, ctx.cut - s);
  const stillFrom = e <= ctx.staticCut ? value.length : valueCut(value, source, ctx.staticCut - s);
  const nodes: HNode[] = [];
  let at = 0;
  for (const [a, b] of wordRanges(value)) {
    if (b > limit) break;
    if (a > at) nodes.push({ type: 'text', value: value.slice(at, a) });
    nodes.push(span([{ type: 'text', value: value.slice(a, b) }], b > stillFrom));
    at = b;
  }
  if (whole && at < value.length) nodes.push({ type: 'text', value: value.slice(at) });
  return { nodes, reached: !whole };
}

/** Marks an element as one animated piece (inline code). */
function mark(el: HNode, fresh: boolean): void {
  const cls = el.properties?.className;
  const list = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? [cls] : [];
  el.properties = { ...el.properties, className: [...list, fresh ? WORD_FRESH : WORD_STILL] };
}
