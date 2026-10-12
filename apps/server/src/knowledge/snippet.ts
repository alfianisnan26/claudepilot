// Knowledge: the piece of a note shown under a search hit, with the matched words marked (Knowledge PRD FR12).
// Marks are positions in plain text, never HTML, so nothing in a note can reach the page as markup.

/** Lowercase, accents removed, with a map from each folded character back to its index in the original. */
function fold(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const piece = text[i]!.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const ch of piece) {
      folded += ch;
      map.push(i);
    }
  }
  return { folded, map };
}

export interface Snippet {
  text: string;
  marks: [number, number][];
}

/** A window of `body` around the first match of any of `words`, whitespace collapsed, with every match in it marked. */
export function makeSnippet(body: string, words: string[], width = 220): Snippet {
  const needles = [...new Set(words.map((w) => fold(w).folded).filter(Boolean))];
  const { folded, map } = fold(body.length > 400_000 ? body.slice(0, 400_000) : body);
  let first = -1;
  for (const n of needles) {
    const at = folded.indexOf(n);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  let start = 0;
  if (first >= 0) {
    start = Math.max(0, (map[first] ?? 0) - Math.floor(width / 3));
    // Start at a word boundary, not in the middle of a word.
    while (start > 0 && start < body.length && /\S/.test(body[start - 1]!)) start++;
  } else {
    // No match in the body (the title or a tag matched): the opening, past any heading lines.
    const open = /^(?:\s*#{1,6}[^\n]*\n)*/.exec(body);
    start = open ? open[0].length : 0;
  }
  const raw = body.slice(start, start + width * 2);
  const text = raw.replace(/\s+/g, ' ').trim();
  const cut = text.length > width ? text.slice(0, width).replace(/\S*$/, '').trimEnd() || text.slice(0, width) : text;
  // An opening ellipsis only when the window starts in the middle of the text because of the match.
  const before = first >= 0 && start > 0;
  const out = (before ? '… ' : '') + cut + (start + raw.length < body.length || text.length > width ? ' …' : '');
  const lead = before ? 2 : 0;
  const f = fold(cut);
  const marks: [number, number][] = [];
  for (const n of needles) {
    let at = f.folded.indexOf(n);
    while (at >= 0) {
      const s = f.map[at]!;
      const e = (f.map[at + n.length - 1] ?? cut.length - 1) + 1;
      marks.push([s + lead, e + lead]);
      at = f.folded.indexOf(n, at + n.length);
    }
  }
  marks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([m[0], m[1]]);
  }
  return { text: out, marks: merged.slice(0, 40) };
}
