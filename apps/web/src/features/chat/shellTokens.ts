// A small shell tokenizer for colouring a command (chat PRD FR7): keywords, commands, strings, flags, operators, variables, comments and
// heredoc bodies. Display only and never a parser of record: the tokens put together are always exactly the text given (nothing is
// dropped, folded or reordered), so what is coloured is what will run, and a command it reads wrongly is still shown whole.

export type ShellKind = 'text' | 'command' | 'keyword' | 'string' | 'flag' | 'operator' | 'variable' | 'comment' | 'heredoc';

export interface ShellToken {
  kind: ShellKind;
  text: string;
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', 'select', 'time', '!', '[[', ']]', '{', '}']);
/** Keywords after which a command comes next. */
const LEADS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', 'time', '!', '{']);
/** Operators, longest first. */
const OPERATORS = ['<<<', '<<-', '2>&1', '>&2', '&>>', '&&', '||', ';;', '|&', '>>', '<<', '&>', '2>', '>|', '|', ';', '&', '>', '<', '(', ')'];
/** Operators after which a command comes next. */
const SEPARATORS = new Set(['&&', '||', ';;', '|&', '|', ';', '&', '(']);
/** What ends a plain word. */
const WORD_END = /[\s|&;<>()"'`$\\]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** The tokens of `src`; joined, they are `src` itself. */
export function tokenizeShell(src: string): ShellToken[] {
  const out: ShellToken[] = [];
  const push = (kind: ShellKind, text: string) => {
    if (text) out.push({ kind, text });
  };
  /** Heredocs opened on the current line, read from the next line on: their delimiter, and whether leading tabs are stripped. */
  const pending: { delim: string; tabs: boolean }[] = [];
  let i = 0;
  let commandNext = true;
  /** Just after `<<`: the next word is a heredoc's delimiter. */
  let heredocOp: '<<' | '<<-' | null = null;

  while (i < src.length) {
    const c = src[i]!;

    if (c === '\n') {
      push('text', c);
      i++;
      commandNext = true;
      // The heredocs opened on the line just ended: each body runs to a line that is its delimiter alone.
      while (pending.length && i <= src.length) {
        const { delim, tabs } = pending.shift()!;
        let body = '';
        let closed = false;
        while (i < src.length) {
          const nl = src.indexOf('\n', i);
          const end = nl === -1 ? src.length : nl;
          const lineText = src.slice(i, end);
          if ((tabs ? lineText.replace(/^\t+/, '') : lineText) === delim) {
            push('heredoc', body);
            const lead = tabs ? (/^\t*/.exec(lineText)?.[0] ?? '') : '';
            push('text', lead);
            push('keyword', lineText.slice(lead.length));
            // the next heredoc's body (two opened on one line) starts on the line after this one
            if (nl !== -1 && pending.length) {
              push('text', '\n');
              i = nl + 1;
            } else i = end;
            closed = true;
            break;
          }
          body += src.slice(i, nl === -1 ? end : nl + 1);
          i = nl === -1 ? end : nl + 1;
        }
        if (!closed) push('heredoc', body);
      }
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\r') {
      let j = i;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j++;
      push('text', src.slice(i, j));
      i = j;
      continue;
    }

    // A comment starts a word (`a#b` and `"a"#b` are words) and runs to the end of the line.
    if (c === '#' && (i === 0 || /[\s;|&()]/.test(src[i - 1]!))) {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      push('comment', src.slice(i, end));
      i = end;
      continue;
    }

    if (c === '\\') {
      push('text', src.slice(i, i + 2));
      i += 2;
      continue;
    }

    if (c === "'" || c === '"' || (c === '$' && src[i + 1] === "'")) {
      const start = i;
      const quote = c === '$' ? "'" : c;
      i += c === '$' ? 2 : 1;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' && (quote === '"' || c === '$') ? 2 : 1;
      i = Math.min(src.length, i + 1);
      const text = src.slice(start, i);
      if (heredocOp) {
        pending.push({ delim: text.slice(c === '$' ? 2 : 1, text.endsWith(quote) && text.length > 1 ? -1 : undefined), tabs: heredocOp === '<<-' });
        heredocOp = null;
      }
      push('string', text);
      commandNext = false;
      continue;
    }

    if (c === '`') {
      push('operator', c);
      i++;
      commandNext = true;
      continue;
    }

    if (c === '$') {
      const next = src[i + 1];
      if (next === '(') {
        const two = src[i + 2] === '(' ? '$((' : '$(';
        push('operator', two);
        i += two.length;
        commandNext = two === '$(';
        continue;
      }
      if (next === '{') {
        const close = src.indexOf('}', i);
        const end = close === -1 ? src.length : close + 1;
        push('variable', src.slice(i, end));
        i = end;
        continue;
      }
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9#?@*!$-])/.exec(src.slice(i, i + 64));
      if (m) {
        push('variable', m[0]);
        i += m[0].length;
        continue;
      }
      push('text', c);
      i++;
      continue;
    }

    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      push('operator', op);
      i += op.length;
      if (op === '<<' || op === '<<-') heredocOp = op;
      if (SEPARATORS.has(op)) commandNext = true;
      continue;
    }

    // A plain word.
    let j = i;
    while (j < src.length && !WORD_END.test(src[j]!)) j++;
    if (j === i) j = i + 1; // a lone character no rule took
    const word = src.slice(i, j);
    i = j;
    if (heredocOp) {
      pending.push({ delim: word, tabs: heredocOp === '<<-' });
      heredocOp = null;
      push('string', word);
      continue;
    }
    if ((commandNext && KEYWORDS.has(word)) || word === ']]') {
      push('keyword', word);
      commandNext = LEADS.has(word);
      continue;
    }
    if (commandNext && ASSIGNMENT.test(word)) {
      push('variable', word);
      continue; // `FOO=1 cmd`: the command still comes next
    }
    if (commandNext) {
      push('command', word);
      commandNext = false;
      continue;
    }
    push(/^--?[A-Za-z0-9]/.test(word) ? 'flag' : 'text', word);
  }
  return out;
}

/** A disguising character as the portal escapes it (`⟦U+202E⟧`): the renderer marks each one. */
export const ESCAPE = /⟦U\+[0-9A-F]{4,6}⟧/g;

/** A text split into plain runs and escapes, in order; joined, they are the text. */
export function splitEscapes(text: string): { text: string; escape: boolean }[] {
  const out: { text: string; escape: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(ESCAPE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), escape: false });
    out.push({ text: m[0], escape: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), escape: false });
  return out;
}
