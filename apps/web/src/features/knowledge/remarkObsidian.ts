// Knowledge: Obsidian's Markdown on top of GitHub-flavored Markdown (Knowledge PRD §9), for the note preview.
// `prepareMarkdown` first drops what Obsidian hides (`%% comments %%` and trailing `^block-ids`) outside code;
// the remark plugin then turns what it adds into elements the preview renders itself: `[[wikilinks]]` and
// `![[embeds]]`, `#tags`, `==highlights==`, `> [!callouts]`, and single line breaks (Obsidian's default).
// Everything becomes text and data attributes: nothing here produces HTML from a note.

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** The same normalization the server uses to match `[[Note#Heading]]`: lowercase, without what links can't carry. */
export function normHeading(text: string): string {
  return text
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/[*_`~=]/g, '')
    .replace(/[#|^:%[\]\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The element id a heading gets, so `[[#Heading]]` can scroll to it. */
export const headingId = (text: string): string => `h-${encodeURIComponent(normHeading(text))}`;

/** Comments and trailing block ids removed outside fenced and inline code. */
export function prepareMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let block: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  const flush = () => {
    if (!block.length) return;
    let t = block.join('\n');
    t = t.replace(/(`+)[^`\n]*?\1|%%[\s\S]*?%%/g, (m, tick: string | undefined) => (tick ? m : ''));
    t = t.replace(/[ \t]+\^[A-Za-z0-9-]+[ \t]*$/gm, '').replace(/^\^[A-Za-z0-9-]+[ \t]*$/gm, '');
    out.push(t);
    block = [];
  };
  for (const line of lines) {
    if (fence) {
      out.push(line);
      if (new RegExp(`^ {0,3}${fence.ch === '`' ? '`' : '~'}{${fence.len},}[ \\t\\r]*$`).test(line)) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line.replace(/\r$/, ''));
    if (open) {
      flush();
      fence = { ch: open[1]![0]!, len: open[1]!.length };
      out.push(line);
      continue;
    }
    block.push(line);
  }
  flush();
  return out.join('\n');
}

const SKIP = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'html', 'yaml', 'math', 'inlineMath']);
const TOKEN = /(!?)\[\[([^[\]\n]{1,512}?)\]\]|==([^=\n][^\n]*?)==|(?<![^\s])#([\p{L}\p{N}\p{M}_\-/]+)/gu;
const ENTITY = /^(ticket|session|workspace|claude|persona|skillset|mcp):(.+)$/i;

const el = (tag: string, props: Record<string, unknown>, children: MdNode[] = []): MdNode => ({ type: tag, data: { hName: tag, hProperties: props }, children });
const text = (value: string): MdNode => ({ type: 'text', value });

function wiki(embed: boolean, inner: string): MdNode {
  const pipe = /^(.*?)\\?\|(.*)$/s.exec(inner);
  const raw = (pipe ? pipe[1]! : inner).trim();
  const alias = pipe ? pipe[2]!.trim() : '';
  const hash = raw.indexOf('#');
  const path = hash < 0 ? raw : raw.slice(0, hash);
  const frag = hash < 0 ? '' : raw.slice(hash + 1).trim();
  const block = frag.startsWith('^') ? frag.slice(1) : '';
  const heading = frag.startsWith('^') ? '' : frag;
  const entity = ENTITY.exec(raw);
  return el('kg-wiki', {
    'data-target': entity ? raw : path.trim(),
    'data-heading': entity ? '' : heading,
    'data-block': entity ? '' : block,
    'data-alias': alias,
    'data-embed': embed ? '1' : '',
    'data-entity': entity ? entity[1]!.toLowerCase() : '',
  });
}

/** Splits one text node into text, line breaks and the elements above. */
function tokens(value: string): MdNode[] {
  const out: MdNode[] = [];
  const pushText = (s: string) => {
    const parts = s.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) out.push({ type: 'break' });
      if (p) out.push(text(p));
    });
  };
  let last = 0;
  for (const m of value.matchAll(TOKEN)) {
    if (m[4] !== undefined && !/[^\d/]/.test(m[4])) continue; // a number alone isn't a tag
    pushText(value.slice(last, m.index));
    if (m[2] !== undefined) {
      if (!m[2].trim()) pushText(m[0]);
      else out.push(wiki(m[1] === '!', m[2]));
    } else if (m[3] !== undefined) out.push({ type: 'kgMark', data: { hName: 'mark' }, children: [text(m[3])] });
    else out.push(el('kg-tag', { 'data-tag': m[4]!.replace(/\/+$/, '').toLowerCase() }, [text(`#${m[4]!}`)]));
    last = m.index + m[0].length;
  }
  pushText(value.slice(last));
  return out;
}

const CALLOUT = /^\[!([A-Za-z0-9-]+)\]([+-]?)[ \t]*([^\n]*)(?:\n([\s\S]*))?$/;

/** `> [!type]+ Title`: the quote becomes a callout and its first line the title. */
function callout(node: MdNode): void {
  const first = node.children?.[0];
  const t = first?.type === 'paragraph' ? first.children?.[0] : undefined;
  const m = t?.type === 'text' && t.value ? CALLOUT.exec(t.value) : null;
  if (!m || !first || !t) return;
  const rest = m[4] ?? '';
  if (rest) t.value = rest;
  else first.children!.shift();
  if (!first.children!.length) node.children!.shift();
  node.data = { hName: 'kg-callout', hProperties: { 'data-callout': m[1]!.toLowerCase(), 'data-fold': m[2] ?? '', 'data-title': (m[3] ?? '').trim() } };
}

function walk(node: MdNode): void {
  if (!node.children) return;
  if (node.type === 'blockquote') callout(node);
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined && !SKIP.has(node.type)) {
      next.push(...tokens(child.value));
      continue;
    }
    if (!SKIP.has(child.type)) walk(child);
    next.push(child);
  }
  node.children = next;
  // A paragraph holding an embed may end up holding a whole note (headings, lists): it can't be a <p>.
  if (node.type === 'paragraph' && next.some((c) => c.data?.hName === 'kg-wiki' && c.data.hProperties?.['data-embed'] === '1')) node.data = { hName: 'div', hProperties: { 'data-block': '1' } };
}

/** The remark plugin. Register as `[remarkGfm, remarkObsidian]`. */
export function remarkObsidian() {
  return (tree: MdNode) => walk(tree);
}
