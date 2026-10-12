import { cn } from '@isnanme/ui';
import type { NoteView } from '@portal/contracts';
import { AlertOctagon, AlertTriangle, Bug, Check, ChevronRight, CircleHelp, FileText, Info, Lightbulb, List, Paperclip, Pencil, Quote, type LucideIcon } from 'lucide-react';
import { Children, isValidElement, memo, useMemo, type ComponentType, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { QuietCopyButton } from '@/features/chat/Markdown';
import { knowledgeApi } from './api';
import { excerptOf, linkIndex, linkKey, NoteEnvContext, useNoteEnv, type NoteEnv } from './env';
import { useLoad } from './hooks';
import { headingId, normHeading, prepareMarkdown, remarkObsidian } from './remarkObsidian';

/** The text inside rendered children (a code block's source, a heading's words). */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const AUDIO = /\.(mp3|m4a|wav|ogg|flac)$/i;
const VIDEO = /\.(mp4|webm|mov)$/i;
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const CALLOUTS: Record<string, { icon: LucideIcon; tone: string }> = {
  note: { icon: Pencil, tone: 'border-sky-500/60 bg-sky-500/10' },
  info: { icon: Info, tone: 'border-sky-500/60 bg-sky-500/10' },
  todo: { icon: Check, tone: 'border-sky-500/60 bg-sky-500/10' },
  tip: { icon: Lightbulb, tone: 'border-teal-500/60 bg-teal-500/10' },
  hint: { icon: Lightbulb, tone: 'border-teal-500/60 bg-teal-500/10' },
  success: { icon: Check, tone: 'border-emerald-500/60 bg-emerald-500/10' },
  check: { icon: Check, tone: 'border-emerald-500/60 bg-emerald-500/10' },
  done: { icon: Check, tone: 'border-emerald-500/60 bg-emerald-500/10' },
  question: { icon: CircleHelp, tone: 'border-amber-500/60 bg-amber-500/10' },
  help: { icon: CircleHelp, tone: 'border-amber-500/60 bg-amber-500/10' },
  faq: { icon: CircleHelp, tone: 'border-amber-500/60 bg-amber-500/10' },
  warning: { icon: AlertTriangle, tone: 'border-amber-500/60 bg-amber-500/10' },
  caution: { icon: AlertTriangle, tone: 'border-amber-500/60 bg-amber-500/10' },
  attention: { icon: AlertTriangle, tone: 'border-amber-500/60 bg-amber-500/10' },
  danger: { icon: AlertOctagon, tone: 'border-red-500/60 bg-red-500/10' },
  error: { icon: AlertOctagon, tone: 'border-red-500/60 bg-red-500/10' },
  failure: { icon: AlertOctagon, tone: 'border-red-500/60 bg-red-500/10' },
  fail: { icon: AlertOctagon, tone: 'border-red-500/60 bg-red-500/10' },
  missing: { icon: AlertOctagon, tone: 'border-red-500/60 bg-red-500/10' },
  bug: { icon: Bug, tone: 'border-red-500/60 bg-red-500/10' },
  abstract: { icon: List, tone: 'border-teal-500/60 bg-teal-500/10' },
  summary: { icon: List, tone: 'border-teal-500/60 bg-teal-500/10' },
  tldr: { icon: List, tone: 'border-teal-500/60 bg-teal-500/10' },
  example: { icon: List, tone: 'border-violet-500/60 bg-violet-500/10' },
  quote: { icon: Quote, tone: 'border-line bg-surface-2/60' },
  cite: { icon: Quote, tone: 'border-line bg-surface-2/60' },
};

function Callout({ kind, fold, title, children }: { kind: string; fold: string; title: string; children?: ReactNode }) {
  const c = CALLOUTS[kind] ?? CALLOUTS.note!;
  const Icon = c.icon;
  const label = title || kind.charAt(0).toUpperCase() + kind.slice(1);
  const head = (
    <span className="flex items-center gap-2 font-semibold">
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{label}</span>
    </span>
  );
  const hasBody = Children.count(children) > 0;
  const box = cn('my-3 rounded-xl border-l-4 px-3.5 py-2.5 text-[14.5px]', c.tone);
  if (fold)
    return (
      <details className={cn(box, 'group')} open={fold === '+'}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
          {head}
          <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden="true" />
        </summary>
        <div className="mt-1.5">{children}</div>
      </details>
    );
  return (
    <div className={box}>
      {head}
      {hasBody && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

const Heading = (level: 1 | 2 | 3 | 4 | 5 | 6) =>
  function Heading({ children }: { children?: ReactNode }) {
    const Tag = `h${level}` as 'h1';
    const size = ['text-[26px]', 'text-[22px]', 'text-[19px]', 'text-[17px]', 'text-[16px]', 'text-[15px]'][level - 1];
    return (
      <Tag id={headingId(textOf(children))} className={cn('mt-6 mb-2 scroll-mt-20 leading-tight font-bold tracking-tight first:mt-0', size)}>
        {children}
      </Tag>
    );
  };

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find((c): c is ReactElement<{ className?: string; children?: ReactNode }> => isValidElement(c));
  const lang = /language-([\w+#.-]+)/.exec(code?.props.className ?? '')?.[1];
  const source = textOf(code?.props.children ?? children).replace(/\n$/, '');
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-line bg-surface-2/60">
      <div className="flex items-center justify-between border-b border-line py-0.5 pr-1 pl-3">
        <span className="font-mono text-[11px] text-muted">{lang ?? 'text'}</span>
        <QuietCopyButton text={source} label="Copy" />
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed">
        <code>{source}</code>
      </pre>
    </div>
  );
}

/** `[[Note]]`, `[[Note#Heading|alias]]`, `![[Note]]`, `![[image.png|300]]`, `[[ticket:T-1]]`. */
function WikiNode(props: Record<string, unknown>) {
  const env = useNoteEnv();
  const target = String(props['data-target'] ?? '');
  const heading = String(props['data-heading'] ?? '') || null;
  const block = String(props['data-block'] ?? '') || null;
  const alias = String(props['data-alias'] ?? '') || null;
  const embed = props['data-embed'] === '1';
  const entity = String(props['data-entity'] ?? '');
  const index = useMemo(() => linkIndex(env.links), [env.links]);

  if (entity) {
    const colon = target.indexOf(':');
    const key = target.slice(colon + 1).trim();
    const href = env.entityHref(entity, key);
    const label = alias ?? `${entity} ${key}`;
    const cls = 'inline-flex items-center rounded-md bg-surface-2 px-1.5 py-0.5 text-[0.9em] font-medium text-ink-soft';
    return href ? (
      <a href={href} className={cn(cls, 'hover:text-ink')}>
        {label}
      </a>
    ) : (
      <span className={cls}>{label}</span>
    );
  }

  const link = target ? index.get(linkKey('wiki', embed, target)) : null;
  const to = target ? (link?.to ?? null) : env.path;
  const anchor = { heading: heading ?? undefined, block: block ?? undefined };
  const label = alias ?? (target ? (heading ? `${target} > ${heading}` : block ? `${target} > ^${block}` : target) : (heading ?? block ?? ''));

  if (embed && to) {
    if (IMAGE.test(to)) {
      const size = /^(\d+)(?:x(\d+))?$/.exec(alias ?? '');
      return <img src={knowledgeApi.fileUrl(env.vaultId, to)} alt={alias && !size ? alias : target} width={size ? Number(size[1]) : undefined} height={size?.[2] ? Number(size[2]) : undefined} className="my-2 inline-block h-auto max-w-full rounded-lg" loading="lazy" />;
    }
    if (AUDIO.test(to)) return <audio src={knowledgeApi.fileUrl(env.vaultId, to)} controls className="my-2 w-full" />;
    if (VIDEO.test(to)) return <video src={knowledgeApi.fileUrl(env.vaultId, to)} controls className="my-2 max-w-full rounded-lg" />;
    if (!/\.md$/i.test(to))
      return (
        <a href={knowledgeApi.fileUrl(env.vaultId, to)} target="_blank" rel="noopener noreferrer" className="my-1 inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[0.9em] font-medium">
          <Paperclip className="size-3.5" aria-hidden="true" />
          {to.split('/').pop()}
        </a>
      );
    return <EmbeddedNote path={to} heading={heading} block={block} />;
  }

  if (!to) {
    if (!target) return <span className="text-muted">{label}</span>;
    return (
      <button type="button" onClick={() => env.create(target)} title="Create" className="cursor-pointer border-b border-dashed border-muted text-muted hover:text-ink">
        {label}
      </button>
    );
  }
  return (
    <a
      href={env.href(to, anchor)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        env.open(to, anchor);
      }}
      className="font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {label}
    </a>
  );
}

const cache = new Map<string, { at: number; value: Promise<NoteView> }>();
function loadNote(vaultId: string, path: string): Promise<NoteView> {
  const key = `${vaultId}|${path}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.value;
  const value = knowledgeApi.note(vaultId, path);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/** `![[Note]]`, `![[Note#Heading]]`, `![[Note#^id]]`: the text itself, a few levels deep and never in a loop. */
function EmbeddedNote({ path, heading, block }: { path: string; heading: string | null; block: string | null }) {
  const env = useNoteEnv();
  const loop = env.depth >= 3 || env.seen.includes(path) || env.path === path;
  const { data, error } = useLoad(`${env.vaultId}|${path}`, () => loadNote(env.vaultId, path), !loop);
  const name = path.replace(/\.md$/i, '').split('/').pop()!;
  const head = (
    <a
      href={env.href(path)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        env.open(path);
      }}
      className="flex items-center gap-1.5 text-[12.5px] font-semibold text-muted hover:text-ink"
    >
      <FileText className="size-3.5" aria-hidden="true" />
      {name}
      {heading ? ` > ${heading}` : ''}
    </a>
  );
  if (loop || error || !data) return <div className="my-2 rounded-xl border border-line px-3 py-2">{head}</div>;
  // Headings carry line numbers over the whole file, so a section is cut from the whole text.
  const text = heading || block ? excerptOf(data.content, data.headings, normHeading, heading, block) : data.content.slice(data.frontmatter.bodyOffset);
  return (
    <div className="my-2 rounded-xl border-l-2 border-line bg-surface-2/40 px-3.5 py-2">
      {head}
      <NoteMarkdown text={text} note={data} depth={env.depth + 1} seen={[...env.seen, env.path]} className="mt-1" />
    </div>
  );
}

function Anchor({ href, children }: { href?: string; children?: ReactNode }) {
  const env = useNoteEnv();
  const index = useMemo(() => linkIndex(env.links), [env.links]);
  if (!href) return <span>{children}</span>;
  if (href.startsWith('#')) {
    const id = headingId(safeDecode(href.slice(1)));
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
        className="font-medium text-accent underline decoration-accent/40 underline-offset-2"
      >
        {children}
      </a>
    );
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//')) {
    // A link to a file of the vault.
    const decoded = safeDecode(href);
    const hash = decoded.indexOf('#');
    const path = (hash < 0 ? decoded : decoded.slice(0, hash)).replace(/^\.\//, '');
    const link = index.get(linkKey('md', false, path));
    if (link?.to) {
      const to = link.to;
      const anchor = { heading: link.heading ?? undefined, block: link.block ?? undefined };
      return (
        <a
          href={env.href(to, anchor)}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            env.open(to, anchor);
          }}
          className="font-medium text-accent underline decoration-accent/40 underline-offset-2"
        >
          {children}
        </a>
      );
    }
    return <span className="border-b border-dashed border-muted text-muted">{children}</span>;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-ink underline underline-offset-2 hover:text-accent">
      {children}
    </a>
  );
}

function Img({ src, alt }: { src?: string | Blob; alt?: string }) {
  const env = useNoteEnv();
  const index = useMemo(() => linkIndex(env.links), [env.links]);
  const href = typeof src === 'string' ? src : '';
  if (!href) return null;
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) {
    // A remote image could carry data out: it shows as a link, as in the chat.
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-ink underline underline-offset-2">
        {alt || href}
      </a>
    );
  }
  const path = safeDecode(href).replace(/^\.\//, '').split('#')[0]!;
  const link = index.get(linkKey('md', true, path));
  if (!link?.to) return <span className="text-muted">{alt || path}</span>;
  return <img src={knowledgeApi.fileUrl(env.vaultId, link.to)} alt={alt ?? ''} className="my-2 inline-block h-auto max-w-full rounded-lg" loading="lazy" />;
}

const COMPONENTS = {
  'kg-wiki': WikiNode as ComponentType<Record<string, unknown>>,
  'kg-tag': ({ children, ...p }: Record<string, unknown> & { children?: ReactNode }) => <TagChip tag={String(p['data-tag'] ?? '')}>{children}</TagChip>,
  'kg-callout': ({ children, ...p }: Record<string, unknown> & { children?: ReactNode }) => (
    <Callout kind={String(p['data-callout'] ?? 'note')} fold={String(p['data-fold'] ?? '')} title={String(p['data-title'] ?? '')}>
      {children}
    </Callout>
  ),
  a: Anchor,
  img: Img,
  pre: CodeBlock,
  code: ({ children, className }: { children?: ReactNode; className?: string }) => <code className={cn('rounded-md bg-surface-2 px-1 py-0.5 font-mono text-[0.88em] break-words', className)}>{children}</code>,
  p: ({ children }: { children?: ReactNode }) => <p className="my-2.5 first:mt-0 last:mb-0">{children}</p>,
  // A paragraph that holds an embed (see remarkObsidian) is a block.
  div: ({ children, ...p }: Record<string, unknown> & { children?: ReactNode }) => (p['data-block'] ? <div className="my-2.5 first:mt-0 last:mb-0">{children}</div> : <div>{children}</div>),
  ul: ({ children, className }: { children?: ReactNode; className?: string }) => <ul className={cn('my-2.5 space-y-1 pl-5 marker:text-muted', className?.includes('contains-task-list') ? 'list-none pl-1' : 'list-disc')}>{children}</ul>,
  ol: ({ children }: { children?: ReactNode }) => <ol className="my-2.5 list-decimal space-y-1 pl-5 marker:text-muted">{children}</ol>,
  li: ({ children }: { children?: ReactNode }) => <li className="pl-0.5">{children}</li>,
  input: ({ type, checked }: { type?: string; checked?: boolean }) => (type === 'checkbox' ? <input type="checkbox" checked={!!checked} readOnly disabled className="mr-2 size-3.5 translate-y-[1px] accent-[var(--color-accent)]" /> : null),
  h1: Heading(1),
  h2: Heading(2),
  h3: Heading(3),
  h4: Heading(4),
  h5: Heading(5),
  h6: Heading(6),
  blockquote: ({ children }: { children?: ReactNode }) => <blockquote className="my-3 border-l-2 border-line pl-3.5 text-ink-soft">{children}</blockquote>,
  hr: () => <hr className="my-5 border-line" />,
  mark: ({ children }: { children?: ReactNode }) => <mark className="rounded bg-amber-400/30 px-0.5 text-inherit">{children}</mark>,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-line">
      <table className="w-full border-collapse text-[13.5px]">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: ReactNode }) => <th className="border-b border-line bg-surface-2/60 px-3 py-1.5 text-left font-semibold">{children}</th>,
  td: ({ children }: { children?: ReactNode }) => <td className="border-b border-line px-3 py-1.5 align-top">{children}</td>,
} as unknown as Components;

function TagChip({ tag, children }: { tag: string; children?: ReactNode }) {
  const env = useNoteEnv();
  return (
    <button type="button" onClick={() => env.tag(tag)} className="cursor-pointer rounded-md bg-accent-soft px-1.5 py-0.5 text-[0.88em] font-medium text-accent">
      {children}
    </button>
  );
}

const PLUGINS = [remarkGfm, remarkObsidian] as never;
/** A preview of more than this many characters is cut (a note can be a megabyte). */
const PREVIEW_MAX = 300_000;

/**
 * A note as Obsidian shows it: GitHub-flavored Markdown with wikilinks, embeds, tags, callouts, highlights
 * and Obsidian's line breaks. Raw HTML never renders (it shows as text), remote images are links, and links
 * go where the vault resolved them. `note` supplies how its links resolve.
 */
export const NoteMarkdown = memo(function NoteMarkdown({
  text,
  note,
  className,
  depth = 0,
  seen = [],
  env,
}: {
  text: string;
  note: Pick<NoteView, 'vaultId' | 'path' | 'links'>;
  className?: string;
  depth?: number;
  seen?: string[];
  /** The page's hooks into navigation; embedded notes inherit them from context. */
  env?: Pick<NoteEnv, 'href' | 'open' | 'create' | 'tag' | 'entityHref'>;
}) {
  const parent = useNoteEnv();
  const merged = useMemo<NoteEnv>(
    () => ({ ...parent, ...env, vaultId: note.vaultId, path: note.path, links: note.links, depth, seen }),
    [parent, env, note.vaultId, note.path, note.links, depth, seen],
  );
  const body = useMemo(() => prepareMarkdown(text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text), [text]);
  return (
    <NoteEnvContext.Provider value={merged}>
      <div className={cn('min-w-0 text-[15.5px] leading-[1.65] break-words', className)}>
        <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
          {body}
        </ReactMarkdown>
        {text.length > PREVIEW_MAX && <p className="mt-4 text-[13px] text-muted">Preview cut at 300,000 characters.</p>}
      </div>
    </NoteEnvContext.Provider>
  );
});
