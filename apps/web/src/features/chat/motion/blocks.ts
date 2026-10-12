/**
 * Splits a Markdown reply into its top-level blocks, so a block that is finished is rendered once and only
 * the block still being written is parsed again as more text arrives (parsing the whole reply on every frame
 * would be O(n) per frame).
 *
 * A block ends at a blank line outside a fenced code block, and only where that cannot change what the
 * Markdown means: the next line must start at column 0 (an indented line continues a list item or a code
 * block), and a list does not end where the next line is another item of it ("loose" lists have blank lines
 * between items). A reply that uses link reference definitions, footnotes or multi-line HTML blocks, where
 * a definition far below changes how text above it renders, is never split.
 */
export interface Block {
  start: number;
  end: number;
}

/** A list item's marker: "- ", "* ", "+ ", "1. ", "1) " (also a bare marker at the end of the line). */
const LIST_ITEM = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*)$/;
/** Constructs where something far below can change how the text above renders (or that run across blank lines). */
const UNSAFE = [
  /^ {0,3}\[[^\]\n]+\]:[ \t]*\S/, // link reference definition
  /^ {0,3}\[\^[^\]\n]+\]:/, // footnote definition
  /^ {0,3}<(?:!--|\?|!\[CDATA\[|![A-Za-z]|(?:pre|script|style|textarea)(?:[ \t>]|$))/i, // HTML blocks that run across blank lines
];

/** Where a block of `text` (starting at `from`) ends, scanning line by line; the state is only what a line needs. */
function scan(text: string, from: number): { blocks: Block[]; unsafe: boolean } {
  const blocks: Block[] = [];
  let blockStart = from;
  let first = '';
  let fence: { ch: string; len: number } | null = null;
  let blankBefore = false;
  let pos = from;
  while (pos < text.length) {
    let eol = text.indexOf('\n', pos);
    if (eol < 0) eol = text.length;
    const line = text.slice(pos, eol);
    const next = eol + 1;
    if (fence) {
      // A closing fence: the same character, at least as long, nothing else on the line.
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.ch && close[1]!.length >= fence.len) fence = null;
      pos = next;
      continue;
    }
    if (line.trim() === '') {
      blankBefore = true;
      pos = next;
      continue;
    }
    if (UNSAFE.some((re) => re.test(line))) return { blocks: [], unsafe: true };
    if (blankBefore) {
      // A line still being typed ("2" may become "2. Second", or stay a number) decides nothing yet: a split is only
      // made on what cannot change, so a block's end never moves back and the words in it are never re-parsed elsewhere.
      if (eol >= text.length && !/\S\s/.test(line)) break;
      const continues = /^[ \t]/.test(line) || (LIST_ITEM.test(first) && LIST_ITEM.test(line));
      // (Leading blank lines belong to the first block: nothing has started yet.)
      if (!continues && first !== '' && pos > blockStart) {
        blocks.push({ start: blockStart, end: pos });
        blockStart = pos;
        first = '';
      }
    }
    blankBefore = false;
    if (first === '') first = line;
    const open = FENCE_OPEN.exec(line);
    // A backtick fence's info string cannot contain a backtick (that would be inline code).
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) fence = { ch: open[1]![0]!, len: open[1]!.length };
    pos = next;
  }
  blocks.push({ start: blockStart, end: text.length });
  return { blocks, unsafe: false };
}

/** The blocks of `text`, covering it end to end. An empty text has none. */
export function splitBlocks(text: string): Block[] {
  if (!text) return [];
  const { blocks, unsafe } = scan(text, 0);
  return unsafe ? [{ start: 0, end: text.length }] : blocks;
}

/**
 * The same, for a text that only grows: blocks before the last are final (what ends a block is decided by
 * lines already seen), so only the last one is scanned again. Anything that is not a continuation of the
 * previous text starts over.
 */
export class BlockSplitter {
  #text = '';
  #blocks: Block[] = [];
  #unsafe = false;

  update(text: string): readonly Block[] {
    if (!text) {
      this.#text = '';
      this.#blocks = [];
      this.#unsafe = false;
      return this.#blocks;
    }
    if (text === this.#text) return this.#blocks;
    if (!text.startsWith(this.#text)) {
      this.#blocks = [];
      this.#unsafe = false;
      this.#text = '';
    }
    this.#text = text;
    if (this.#unsafe) {
      this.#blocks = [{ start: 0, end: text.length }];
      return this.#blocks;
    }
    const last = this.#blocks.pop();
    const from = last ? last.start : 0;
    const { blocks, unsafe } = scan(text, from);
    if (unsafe) {
      this.#unsafe = true;
      this.#blocks = [{ start: 0, end: text.length }];
    } else this.#blocks.push(...blocks);
    return this.#blocks;
  }
}
