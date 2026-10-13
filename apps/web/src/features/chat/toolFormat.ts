// What a tool row's Input and Output blocks show (chat PRD FR7), and what the approval card shows, as pure functions: the renderer
// (`CodeBlock.tsx`) only draws what these return. Nothing here drops or folds the text it is given: a command, an approval's text and
// an output are shown whole (the output behind "Show all" when long).

import type { ChatToolInputValue } from '@portal/contracts';

export type CodeLang = 'shell' | 'json' | 'text';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'gap';
  text: string;
}

/** A call's Input block: the file it works on, small facts (a range, a mode), and its main text or its edit's lines. */
export interface InputView {
  path: string | null;
  facts: string[];
  code: { text: string; lang: CodeLang } | null;
  diff: DiffLine[] | null;
  /** The portal kept only part of the input. */
  cut: boolean;
}

type Input = { [key: string]: ChatToolInputValue };

const str = (v: ChatToolInputValue | undefined): string | null => (typeof v === 'string' ? v : null);
const num = (v: ChatToolInputValue | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** How many lines a text has (a final newline does not start one more); 0 for none. */
export function lineCount(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** "1 line", "5,000 lines". */
export const linesLabel = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'line' : 'lines'}`;

/** "lines 10–29", "from line 10", "lines 1–20", or null when the read has no range. */
export function readRange(offset: number | null, limit: number | null): string | null {
  if (offset !== null && limit !== null) return `lines ${offset}–${offset + limit - 1}`;
  if (offset !== null) return `from line ${offset}`;
  if (limit !== null) return `lines 1–${limit}`;
  return null;
}

/** The context kept around an edit's change: what a reader needs to place it, not the whole excerpt. */
const CONTEXT = 3;

/**
 * An edit's lines: what stays the same at its start and end as context (at most a few lines each side, a gap where more was left out),
 * then the removed lines and the added ones. Every changed line is shown.
 */
export function editDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const out: DiffLine[] = [];
  if (start > CONTEXT) out.push({ kind: 'gap', text: '…' });
  for (const t of a.slice(Math.max(0, start - CONTEXT), start)) out.push({ kind: 'ctx', text: t });
  for (const t of a.slice(start, a.length - end)) out.push({ kind: 'del', text: t });
  for (const t of b.slice(start, b.length - end)) out.push({ kind: 'add', text: t });
  for (const t of a.slice(a.length - end, a.length - end + CONTEXT)) out.push({ kind: 'ctx', text: t });
  if (end > CONTEXT) out.push({ kind: 'gap', text: '…' });
  return out;
}

const pretty = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

/**
 * A call's Input block from what the portal kept of its input (`toolInput`). Without it (a call stored before inputs were kept), the
 * one-line summary the row already has, as text.
 */
export function inputView(toolName: string | undefined, input: Input | undefined, summary: string | undefined, cut = false): InputView {
  const view: InputView = { path: null, facts: [], code: null, diff: null, cut };
  const tool = toolName ?? '';
  if (!input) {
    if (summary?.trim()) view.code = { text: summary, lang: tool === 'Bash' ? 'shell' : 'text' };
    return view;
  }
  switch (tool) {
    case 'Bash': {
      const command = str(input.command);
      if (command !== null) view.code = { text: command, lang: 'shell' };
      if (input.run_in_background === true) view.facts.push('background');
      const timeout = num(input.timeout);
      if (timeout !== null) view.facts.push(`timeout ${Math.round(timeout / 1000)} s`);
      return view;
    }
    case 'Edit': {
      view.path = str(input.file_path);
      view.diff = editDiff(str(input.old_string) ?? '', str(input.new_string) ?? '');
      if (input.replace_all === true) view.facts.push('every match');
      return view;
    }
    case 'MultiEdit': {
      view.path = str(input.file_path);
      const edits = Array.isArray(input.edits) ? input.edits : [];
      view.diff = edits.flatMap((e, i) => {
        const o = (e && typeof e === 'object' && !Array.isArray(e) ? e : {}) as Input;
        const lines = editDiff(str(o.old_string) ?? '', str(o.new_string) ?? '');
        return i === 0 ? lines : [{ kind: 'gap' as const, text: '…' }, ...lines];
      });
      view.facts.push(edits.length === 1 ? '1 edit' : `${edits.length} edits`);
      return view;
    }
    case 'Write': {
      view.path = str(input.file_path);
      const content = str(input.content) ?? '';
      view.diff = content ? content.replace(/\n$/, '').split('\n').map((text) => ({ kind: 'add' as const, text })) : [];
      return view;
    }
    case 'NotebookEdit': {
      view.path = str(input.notebook_path);
      const source = str(input.new_source);
      if (source !== null) view.code = { text: source, lang: 'text' };
      const mode = str(input.edit_mode);
      if (mode) view.facts.push(mode);
      return view;
    }
    case 'Read':
    case 'NotebookRead': {
      view.path = str(input.file_path) ?? str(input.notebook_path);
      const range = readRange(num(input.offset), num(input.limit));
      if (range) view.facts.push(range);
      return view;
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str(input.pattern);
      if (pattern !== null) view.code = { text: pattern, lang: 'text' };
      view.path = str(input.path);
      const glob = str(input.glob);
      if (glob) view.facts.push(glob);
      const type = str(input.type);
      if (type) view.facts.push(`type ${type}`);
      if (input['-i'] === true) view.facts.push('ignore case');
      const mode = str(input.output_mode);
      if (mode) view.facts.push(mode);
      return view;
    }
    case 'LS':
      view.path = str(input.path);
      return view;
    case 'WebFetch':
    case 'WebSearch': {
      const text = str(input.url) ?? str(input.query);
      if (text !== null) view.code = { text, lang: 'text' };
      return view;
    }
    default:
      view.code = { text: pretty(input), lang: 'json' };
      return view;
  }
}

/** How an approval's text is coloured: a command as shell, a tool's whole input (JSON) as JSON, the rest as plain text. */
export function approvalLang(toolName: string | null | undefined, text: string): CodeLang {
  if (toolName === 'Bash') return 'shell';
  if (/^\s*\{/.test(text)) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      return 'text';
    }
  }
  return 'text';
}

/** Lines shown at each end of a long output before "Show all". */
export const OUTPUT_HEAD = 40;
export const OUTPUT_TAIL = 40;

/**
 * A long output's first and last lines, and how many are between: an output of up to `head + tail` lines (and a few more, not worth a
 * button) is shown whole.
 */
export function clipOutput(text: string, head = OUTPUT_HEAD, tail = OUTPUT_TAIL): { head: string; tail: string | null; hidden: number; total: number } {
  const lines = text.split('\n');
  const total = lineCount(text);
  if (total <= head + tail + 5) return { head: text, tail: null, hidden: 0, total };
  return { head: lines.slice(0, head).join('\n'), tail: lines.slice(total - tail, total).join('\n'), hidden: total - head - tail, total };
}

/** The exit status a failed command's result starts with ("Exit code 2"), when it does. */
export function exitStatus(text: string): number | null {
  const m = /^(?:Error: )?Exit code (-?\d+)\b/.exec(text);
  return m ? Number(m[1]) : null;
}
