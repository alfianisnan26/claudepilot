import { cn } from '@isnanme/ui';
import { Check, Copy, ImageIcon } from 'lucide-react';
import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Copies text: the Clipboard API where the page may use it (HTTPS or localhost), else the old
 * select-and-copy, which also works when the portal is opened over plain HTTP on a LAN.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Copy, then a tick for a moment. `label` names what it copies for screen readers. */
export function CopyButton({ text, label, className, children }: { text: string; label: string; className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() =>
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        })
      }
      className={cn(
        'press inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-semibold text-muted hover:bg-surface-2 hover:text-ink',
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />}
      {children && <span>{copied ? 'Copied' : children}</span>}
    </button>
  );
}

/** The text inside rendered children (a code block's source). */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** A fenced block: its language (from `language-*`) over the code, with Copy always visible. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find((c): c is ReactElement<{ className?: string; children?: ReactNode }> => isValidElement(c));
  const lang = /language-([\w+#.-]+)/.exec(code?.props.className ?? '')?.[1];
  const source = textOf(code?.props.children ?? children).replace(/\n$/, '');
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-line bg-surface-2/60">
      <div className="flex items-center justify-between border-b border-line py-0.5 pr-1 pl-3">
        <span className="font-mono text-[11px] text-muted">{lang ?? 'text'}</span>
        <CopyButton text={source} label={lang ? `Copy ${lang} code` : 'Copy code'}>
          Copy
        </CopyButton>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed">
        <code>{source}</code>
      </pre>
    </div>
  );
}

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children, className }) => (
    <code className={cn('rounded-md bg-surface-2 px-1 py-0.5 font-mono text-[0.88em] break-words', className)}>{children}</code>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-ink underline underline-offset-2 hover:text-accent">
      {children}
    </a>
  ),
  // Remote images in replies show as links: loading one could carry data out (chat PRD §12.7).
  img: ({ src, alt }) => {
    const href = typeof src === 'string' ? src : undefined;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 font-medium text-ink underline underline-offset-2">
        <ImageIcon className="size-3.5 shrink-0" aria-hidden="true" />
        {alt || href || 'image'}
      </a>
    );
  },
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-muted">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  h1: ({ children }) => <h3 className="mt-4 mb-2 text-[17px] font-bold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 mb-2 text-[16px] font-bold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1.5 text-[15px] font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h5>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-line pl-3 text-ink-soft">{children}</blockquote>,
  hr: () => <hr className="my-4 border-line" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-line">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-line bg-surface-2/60 px-3 py-1.5 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-line px-3 py-1.5 align-top">{children}</td>,
};

const PLUGINS = [remarkGfm];

/**
 * A reply as markdown (GitHub flavored). Raw HTML is never rendered (it shows as text), links open in
 * a new tab, and unsafe URLs are dropped. Memoized per text, so a streaming token re-renders only the
 * block it lands in.
 */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('min-w-0 break-words', className)}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
