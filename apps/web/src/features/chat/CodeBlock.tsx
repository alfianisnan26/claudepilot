import { cn, Spinner, useToast } from '@isnanme/ui';
import { Check, Copy, WrapText } from 'lucide-react';
import { forwardRef, useEffect, useMemo, useState, type ReactNode, type UIEventHandler } from 'react';
import { MONO } from '../code/font';
import { splitEscapes, tokenizeShell, visibly, type ShellKind } from './shellTokens';
import { clipOutput, linesLabel, lineCount, type CodeLang, type DiffLine, type InputView } from './toolFormat';

// The one renderer of a tool's text (chat PRD FR7): a tool row's Input and Output blocks, the approval card, and the glance widget's
// review. Monospace, real line breaks, light shell colouring; the text is drawn whole and in order (the tokens joined are the text), and a
// disguising character the portal escaped (`⟦U+202E⟧`) is marked.

/** The code font (shared with the code viewer). */
export { MONO };

const KIND_CLASS: Record<ShellKind, string> = {
  text: '',
  command: 'font-semibold text-ink',
  keyword: 'text-violet-700 dark:text-violet-300',
  string: 'text-emerald-700 dark:text-emerald-400',
  heredoc: 'text-emerald-700 dark:text-emerald-400',
  flag: 'text-blue-700 dark:text-blue-300',
  operator: 'font-semibold text-amber-700 dark:text-amber-400',
  variable: 'text-cyan-700 dark:text-cyan-300',
  comment: 'italic text-muted',
};

/** Plain text with each disguising character escaped (if the portal had not) and marked. */
function Marked({ text, className }: { text: string; className?: string }) {
  const parts = splitEscapes(visibly(text));
  if (parts.length === 1 && !parts[0]!.escape) return className ? <span className={className}>{parts[0]!.text}</span> : <>{parts[0]!.text}</>;
  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.escape ? (
          <span key={i} className="rounded-sm bg-danger-soft font-semibold text-danger">
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </span>
  );
}

/**
 * A text coloured for its language. `review` (an approval) draws comments at full strength: what a person is asked to allow is never
 * dimmed, whatever the tokenizer took it for.
 */
export function Highlighted({ text, lang, review = false }: { text: string; lang: CodeLang; review?: boolean }) {
  const tokens = useMemo(() => (lang === 'shell' ? tokenizeShell(text) : null), [text, lang]);
  if (!tokens) return <Marked text={text} />;
  return (
    <>
      {tokens.map((t, i) => (
        <Marked key={i} text={t.text} className={review && t.kind === 'comment' ? 'italic' : KIND_CLASS[t.kind] || undefined} />
      ))}
    </>
  );
}

/** The class of a block's text: monospace, wrapped anywhere (default) or one line per line and scrolled sideways. */
export const preClass = (wrap: boolean) =>
  cn('px-3 py-2 text-[12px] leading-relaxed', wrap ? 'break-words whitespace-pre-wrap wrap-anywhere' : 'whitespace-pre');

/** An icon button of a block's header: 44 px on a phone, smaller with a pointer. */
function HeadButton({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'press flex size-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink sm:size-7',
        pressed && 'text-ink',
      )}
    >
      {children}
    </button>
  );
}

/** Copies `text`; the icon turns into a tick for a moment. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
    } catch {
      toast('Couldn’t copy. The browser blocked the clipboard.', 'error');
    }
  };
  return (
    <HeadButton label={done ? 'Copied' : label} onClick={() => void copy()}>
      {done ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
    </HeadButton>
  );
}

/** A block's header: its name, small facts, and its buttons at the end. */
function BlockHead({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-2 border-b border-line/70 pl-3 sm:min-h-8">
      <span className="shrink-0 text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-[11.5px] text-muted tabular-nums">{children}</span>
      {actions && <span className="flex shrink-0 items-center">{actions}</span>}
    </div>
  );
}

const DIFF_CLASS: Record<DiffLine['kind'], string> = {
  add: 'bg-accent-soft text-accent',
  del: 'bg-danger-soft text-danger',
  ctx: 'text-ink-soft',
  gap: 'text-muted',
};
const DIFF_SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '−', ctx: ' ', gap: ' ' };

/** A tool call's Input block: the path and facts, then its command (coloured), its text, or its edit's lines. */
export function InputBlock({ view, wrapDefault = true }: { view: InputView; wrapDefault?: boolean }) {
  const [wrap, setWrap] = useState(wrapDefault);
  const text = view.code?.text ?? (view.diff ? view.diff.filter((l) => l.kind !== 'gap').map((l) => l.text).join('\n') : '');
  const lines = view.code ? lineCount(view.code.text) : view.diff ? view.diff.filter((l) => l.kind !== 'gap').length : 0;
  const body = view.code || view.diff;
  return (
    <section aria-label="Input" className="overflow-hidden rounded-lg border border-line bg-surface-2/50">
      <BlockHead
        title="Input"
        actions={
          body ? (
            <>
              <HeadButton label={wrap ? 'Don’t wrap lines' : 'Wrap lines'} pressed={wrap} onClick={() => setWrap(!wrap)}>
                <WrapText className="size-4" aria-hidden="true" />
              </HeadButton>
              <CopyButton text={view.code?.text ?? text} />
            </>
          ) : null
        }
      >
        {lines > 1 && <span>{linesLabel(lines)}</span>}
        {view.facts.map((f) => (
          <span key={f}>{f}</span>
        ))}
        {view.cut && <span className="text-danger">cut short</span>}
      </BlockHead>
      {view.path && (
        <p className={cn('border-b border-line/70 px-3 py-1.5 text-[12px] break-all text-ink-soft', !body && 'border-b-0')} style={{ fontFamily: MONO }}>
          <Marked text={view.path} />
        </p>
      )}
      {view.code && (
        <pre tabIndex={0} className={cn(preClass(wrap), 'max-h-80 overflow-auto overscroll-contain text-ink')} style={{ fontFamily: MONO, tabSize: 4 }}>
          <Highlighted text={view.code.text} lang={view.code.lang} />
        </pre>
      )}
      {view.diff && (
        <div tabIndex={0} className="max-h-80 overflow-auto overscroll-contain py-1 text-[12px] leading-relaxed" style={{ fontFamily: MONO, tabSize: 4 }}>
          <div className={cn(!wrap && 'inline-block min-w-full')}>
            {view.diff.length === 0 && <p className="px-3 text-muted">Empty.</p>}
            {view.diff.map((l, i) => (
              <div key={i} className={cn('flex px-3', DIFF_CLASS[l.kind], wrap ? 'whitespace-pre-wrap wrap-anywhere' : 'whitespace-pre')}>
                <span aria-hidden="true" className="w-4 shrink-0 select-none">
                  {DIFF_SIGN[l.kind]}
                </span>
                <span className="min-w-0">{l.kind === 'gap' ? l.text : <Marked text={l.text || ' '} />}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * A tool call's Output block: what the portal stored of the result, monospace; a long one shows its first and last lines and "Show all"
 * between; a failure in the danger tone with its exit status when known. With `cut` (T-376) the text is a preview of a longer whole the
 * transcript's page left out: it shows whole, says how long the whole is, and "Show all" reads the whole (Copy waits for it).
 */
export function OutputBlock({
  text,
  error,
  exit,
  empty,
  cut,
}: {
  text: string;
  error: boolean;
  exit: number | null;
  empty: string;
  cut?: { length: number; load: () => Promise<void> };
}) {
  const [wrap, setWrap] = useState(true);
  const [all, setAll] = useState(false);
  const [whole, setWhole] = useState<'idle' | 'loading' | 'failed'>('idle');
  const clip = useMemo(() => clipOutput(text), [text]);
  const shown = !!cut || all || clip.tail === null;
  const loadWhole = () => {
    if (!cut || whole === 'loading') return;
    setWhole('loading');
    cut.load().then(
      () => setWhole('idle'),
      () => setWhole('failed'),
    );
  };
  return (
    <section aria-label="Output" className={cn('overflow-hidden rounded-lg border', error ? 'border-danger/30 bg-danger-soft' : 'border-line bg-surface-2/50')}>
      <BlockHead
        title="Output"
        actions={
          text ? (
            <>
              <HeadButton label={wrap ? 'Don’t wrap lines' : 'Wrap lines'} pressed={wrap} onClick={() => setWrap(!wrap)}>
                <WrapText className="size-4" aria-hidden="true" />
              </HeadButton>
              {!cut && <CopyButton text={text} />}
            </>
          ) : null
        }
      >
        {cut ? <span>preview</span> : clip.total > 1 && <span>{linesLabel(clip.total)}</span>}
        {exit !== null && <span className={cn('font-semibold', exit === 0 ? 'text-ink-soft' : 'text-danger')}>exit {exit}</span>}
        {error && exit === null && <span className="font-semibold text-danger">failed</span>}
      </BlockHead>
      {text ? (
        <pre
          tabIndex={0}
          className={cn(preClass(wrap), 'max-h-[60vh] overflow-auto overscroll-contain sm:max-h-96', error ? 'text-danger' : 'text-ink')}
          style={{ fontFamily: MONO, tabSize: 4 }}
        >
          <Marked text={shown ? text : clip.head} />
          {!shown && (
            <>
              {'\n'}
              <button
                type="button"
                onClick={() => setAll(true)}
                className="press my-1 inline-flex min-h-11 items-center rounded-md border border-line bg-surface px-3 font-sans text-[12.5px] font-medium text-ink hover:bg-surface-2 sm:min-h-8"
              >
                Show all ({linesLabel(clip.total)})
              </button>
              <span className="sr-only">{clip.hidden.toLocaleString('en-US')} lines not shown</span>
              {'\n'}
              <Marked text={clip.tail ?? ''} />
            </>
          )}
          {cut && (
            <>
              {'…\n'}
              <button
                type="button"
                onClick={loadWhole}
                disabled={whole === 'loading'}
                className="press my-1 inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line bg-surface px-3 font-sans text-[12.5px] font-medium text-ink hover:bg-surface-2 sm:min-h-8"
              >
                {whole === 'loading' && <Spinner className="size-3" />}
                {whole === 'failed' ? 'Couldn’t load. Retry' : `Show all (${cut.length.toLocaleString('en-US')} chars)`}
              </button>
            </>
          )}
        </pre>
      ) : (
        <p className="px-3 py-1.5 text-[12px] text-muted">{empty}</p>
      )}
    </section>
  );
}

/**
 * What a person is asked to allow, in the same renderer: wrapped always (a run of spaces cannot push the end out of sight sideways), and
 * never dimmed. The scroll element is the caller's (`ApprovalBlock` measures it to know when it has been read to the end).
 */
export const ReviewText = forwardRef<HTMLPreElement, { text: string; lang: CodeLang; className?: string; onScroll?: UIEventHandler<HTMLPreElement> }>(
  function ReviewText({ text, lang, className, onScroll }, ref) {
    return (
      <pre
        ref={ref}
        tabIndex={0}
        role="region"
        aria-label="What is being allowed"
        onScroll={onScroll}
        className={cn(
          'max-h-40 overflow-y-auto rounded-lg bg-surface-2 px-2.5 py-2 text-xs leading-snug break-words whitespace-pre-wrap text-ink-soft wrap-anywhere overscroll-contain',
          className,
        )}
        style={{ fontFamily: MONO, tabSize: 4 }}
      >
        <Highlighted text={text} lang={lang} review />
      </pre>
    );
  },
);
