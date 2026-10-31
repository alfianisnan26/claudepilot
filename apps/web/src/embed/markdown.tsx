import type { ReactNode } from 'react';

/*
 * A small Markdown subset for untrusted ticket comments and notes in the panel: paragraphs, lists, headings (as bold lines), code
 * fences, inline code, bold, italics and links. Text only ever becomes React text nodes (no HTML is parsed), and only http(s) links
 * are kept, opened in a new tab without the opener. Keeps the embed bundle free of a full Markdown stack.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'link'; v: string; href: string };

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export function inlineTokens(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'strong', v: m[2] });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ t: 'em', v: (m[3] ?? m[4])! });
    else {
      const href = safeHref(m[6]!);
      out.push(href ? { t: 'link', v: m[5]!, href } : { t: 'text', v: m[5]! });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

export type Block = { t: 'p' | 'h'; v: string } | { t: 'ul'; items: string[] } | { t: 'pre'; v: string };

export function blocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (para.length) out.push({ t: 'p', v: para.join('\n') });
    para = [];
    if (list) out.push({ t: 'ul', items: list });
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith('```'); i++) code.push(lines[i]!);
      out.push({ t: 'pre', v: code.join('\n') });
      continue;
    }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      if (para.length) {
        out.push({ t: 'p', v: para.join('\n') });
        para = [];
      }
      (list ??= []).push(li[1]!);
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ t: 'h', v: h[1]! });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list) flush();
    para.push(line);
  }
  flush();
  return out;
}

function renderInline(text: string): ReactNode[] {
  return inlineTokens(text).map((tok, i) => {
    switch (tok.t) {
      case 'code':
        return (
          <code key={i} className="rounded bg-surface-2 px-1 text-[0.92em] break-all">
            {tok.v}
          </code>
        );
      case 'strong':
        return <strong key={i}>{tok.v}</strong>;
      case 'em':
        return <em key={i}>{tok.v}</em>;
      case 'link':
        return (
          <a key={i} href={tok.href} target="_blank" rel="noopener noreferrer" className="text-accent underline break-all">
            {tok.v}
          </a>
        );
      default:
        return <span key={i}>{tok.v}</span>;
    }
  });
}

export function Md({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 break-words ${className}`}>
      {blocks(text).map((b, i) =>
        b.t === 'pre' ? (
          <pre key={i} className="overflow-x-auto rounded-lg bg-surface-2 p-2 text-[12px]">
            {b.v}
          </pre>
        ) : b.t === 'ul' ? (
          <ul key={i} className="list-disc pl-5">
            {b.items.map((it, j) => (
              <li key={j}>{renderInline(it)}</li>
            ))}
          </ul>
        ) : b.t === 'h' ? (
          <p key={i} className="font-semibold">
            {renderInline(b.v)}
          </p>
        ) : (
          <p key={i} className="whitespace-pre-line">
            {renderInline(b.v)}
          </p>
        ),
      )}
    </div>
  );
}
