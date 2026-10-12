/**
 * Words, for the reveal: a word is a run of non-whitespace characters, and the reveal never cuts inside one (the last
 * word of what has arrived is held back until whitespace follows it, or the stream ends). Text written without
 * spaces between words (Chinese, Japanese, Thai, Lao, Khmer, Burmese) would be one endless word, so a run holding
 * such text is split into the words the browser's own segmenter finds in it (a character at a time where it has none).
 */

const WS = /\s/;
const NO_SPACE = /[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

/** The [start, end) ranges of the units of one run of non-whitespace: the run itself, or its words when it holds text written without spaces. */
function units(run: string): [number, number][] {
  if (!NO_SPACE.test(run)) return [[0, run.length]];
  const out: [number, number][] = [];
  if (segmenter) for (const part of segmenter.segment(run)) out.push([part.index, part.index + part.segment.length]);
  else for (let i = 0; i < run.length; ) {
    const step = (run.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    out.push([i, i + step]);
    i += step;
  }
  return out;
}

/**
 * Finds the words that are complete in `text` from `from` on (`from` is where the previous scan stopped: the
 * start of the first word that was not complete yet). A word is complete when whitespace follows it, or
 * `ended`. Pushes each complete word's end offset to `ends`; returns where the next scan resumes.
 */
export function scanWords(text: string, from: number, ended: boolean, ends: number[]): number {
  let i = from;
  const n = text.length;
  while (i < n) {
    while (i < n && WS.test(text[i]!)) i++;
    if (i >= n) return n;
    let j = i;
    while (j < n && !WS.test(text[j]!)) j++;
    const complete = j < n || ended;
    const parts = units(text.slice(i, j));
    for (let k = 0; k < parts.length; k++) {
      // The last unit of a run that may still grow is not complete: the next scan starts there.
      if (k === parts.length - 1 && !complete) return i + parts[k]![0];
      ends.push(i + parts[k]![1]);
    }
    i = j;
  }
  return n;
}

/**
 * Where the reveal must stop for now: the start of a line that could still turn into something else. A table is
 * only a table once its delimiter row (`|---|---|`) has come, until then the header line is a paragraph of pipes,
 * so the first pipe line of a block waits until the line after it has started. Everything else may show as far as
 * its last complete word.
 */
export function holdEnd(text: string): number {
  const pipe = (line: string) => line.trimStart().startsWith('|');
  const lineStart = (end: number) => text.lastIndexOf('\n', end - 1) + 1;
  let end = text.length;
  // A text ending in a newline has a line that has not started: the one before it is the last that has.
  if (text.endsWith('\n')) end -= 1;
  const start = lineStart(end);
  if (!pipe(text.slice(start, end))) return text.length;
  // Only the first pipe line is the header; once there is a line above it that is a pipe line too, the table is settled.
  if (start > 0 && pipe(text.slice(lineStart(start - 1), start - 1))) return text.length;
  return start;
}

/** The words of `value` as [start, end) ranges. */
export function wordRanges(value: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /\S+/g;
  for (let m = re.exec(value); m; m = re.exec(value)) for (const [a, b] of units(m[0])) out.push([m.index + a, m.index + b]);
  return out;
}

/**
 * How much of a text node's `value` has been revealed, given how far into its source (`source`, the markdown it
 * was parsed from) the reveal has reached (`cut`, an offset into `source`). Usually the value is its source
 * (the same length), and it is a subtraction; where the markdown added or removed characters (an escape, an
 * entity, indentation of a continued line) the two are walked together: an escape or entity in the source is
 * one character of the value, and a character only the source has is skipped.
 */
export function valueCut(value: string, source: string, cut: number): number {
  if (cut >= source.length) return value.length;
  if (cut <= 0) return 0;
  if (value.length === source.length) return cut;
  let i = 0;
  let j = 0;
  while (i < value.length && j < cut) {
    const c = source[j];
    if (c === value[i]) {
      i++;
      j++;
    } else if (c === '\\' && source[j + 1] === value[i]) {
      i++;
      j += 2;
    } else if (c === '&') {
      const ref = REFERENCE.exec(source.slice(j, j + 12));
      if (ref) {
        // A character reference is one character of the value (two when it is outside the basic plane).
        const code = ref[1] ? (ref[1][0] === 'x' || ref[1][0] === 'X' ? parseInt(ref[1].slice(1), 16) : parseInt(ref[1], 10)) : 0;
        i += code > 0xffff ? 2 : 1;
        j += ref[0].length;
      } else j++;
    } else j++;
  }
  return i;
}

const REFERENCE = /^&(?:#([0-9]+|[xX][0-9a-fA-F]+)|[A-Za-z][A-Za-z0-9]*);/;
