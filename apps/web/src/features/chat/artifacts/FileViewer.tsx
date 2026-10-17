import { cn, ease, Spinner, useMediaQuery } from '@isnanme/ui';
import type { ChatFile, ChatTextPreview } from '@portal/contracts';
import { Code2, Download, ExternalLink, WrapText, X } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { errorText } from '@/lib/api';
import { CodeViewer } from '../../code/CodeViewer';
import { LANGUAGE_LABEL, languageFor } from '../../code/language';
import { Markdown, QuietCopyButton } from '../Markdown';
import { useModal } from '../shared';
import { fetchTextPreview, fileUrl } from './contentApi';
import { formatSize, iconFor } from './fileKinds';
import { saveFile } from './save';

const BAR_BUTTON = 'press inline-flex size-10 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-surface-2 hover:text-ink tap:size-11';

/** Whether the file is Markdown (shown rendered, with its source a tap away). */
const isMarkdown = (f: ChatFile) => f.mediaType === 'text/markdown' || /\.(?:md|markdown)$/i.test(f.name);
const isDelimited = (f: ChatFile) => f.mediaType === 'text/csv' || f.mediaType === 'text/tab-separated-values';

/** A small RFC 4180 reader: quoted fields, doubled quotes, newlines inside quotes. At most `maxRows` rows are read. */
export function parseDelimited(text: string, delimiter: string, maxRows = 500): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (rows.length < maxRows && (field !== '' || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function Table({ rows }: { rows: string[][] }) {
  const head = rows[0] ?? [];
  const body = rows.slice(1);
  return (
    <div className="overflow-auto rounded-xl border border-line">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 bg-surface-2">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border-b border-line px-3 py-1.5 text-left font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, y) => (
            <tr key={y} className="odd:bg-surface-2/40">
              {head.map((_, x) => (
                <td key={x} className="max-w-[24rem] truncate border-b border-line px-3 py-1 align-top whitespace-nowrap">
                  {r[x] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A text file (or the source of an HTML one): fetched once, secrets already hidden by the portal. */
function useTextPreview(sessionId: string, file: ChatFile, enabled: boolean) {
  const [state, setState] = useState<{ preview?: ChatTextPreview; error?: string }>({});
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    setState({});
    fetchTextPreview(sessionId, file.blobId, ctl.signal).then(
      (preview) => setState({ preview }),
      (e: unknown) => !ctl.signal.aborted && setState({ error: errorText(e, 'Couldn’t read this file.') }),
    );
    return () => ctl.abort();
  }, [sessionId, file.blobId, enabled]);
  return state;
}

function TextBody({ sessionId, file }: { sessionId: string; file: ChatFile }) {
  const { preview, error } = useTextPreview(sessionId, file, true);
  const [source, setSource] = useState(false);
  const [wrap, setWrap] = useState(true);
  const delimited = isDelimited(file);
  const md = isMarkdown(file);
  const rows = useMemo(() => (preview && delimited ? parseDelimited(preview.text, file.mediaType === 'text/tab-separated-values' ? '\t' : ',') : null), [preview, delimited, file.mediaType]);
  const pretty = useMemo(() => {
    if (!preview || file.mediaType !== 'application/json' || preview.truncated) return null;
    try {
      return JSON.stringify(JSON.parse(preview.text), null, 2);
    } catch {
      return null;
    }
  }, [preview, file.mediaType]);

  if (error) return <p role="alert" className="p-4 text-sm text-danger">{error}</p>;
  if (!preview)
    return (
      <div className="flex justify-center p-8 text-muted">
        <Spinner className="size-5" />
      </div>
    );
  const tableRows = rows && rows.length > 0 && (rows[0]?.length ?? 0) > 1 ? rows : null;
  const asCode = !((md || tableRows) && !source);
  const language = delimited ? 'plain' : languageFor(file.name, file.mediaType);
  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-end gap-1">
        {asCode && (
          <span data-testid="code-language" className="mr-auto truncate text-[12px] font-medium text-muted">
            {LANGUAGE_LABEL[language]}
          </span>
        )}
        {asCode && (
          <button type="button" onClick={() => setWrap((v) => !v)} aria-pressed={wrap} aria-label="Wrap lines" title="Wrap lines" className={cn(BAR_BUTTON, wrap && 'bg-surface-2 text-ink')}>
            <WrapText className="size-4" />
          </button>
        )}
        {(md || tableRows) && (
          <button type="button" onClick={() => setSource((v) => !v)} aria-pressed={source} aria-label="Show source" title="Source" className={cn(BAR_BUTTON, 'size-9', source && 'bg-surface-2 text-ink')}>
            <Code2 className="size-4" />
          </button>
        )}
        <QuietCopyButton text={preview.text} label="Copy text" className="size-10 justify-center rounded-full p-0 tap:size-11" />
      </div>
      {md && !source ? (
        <Markdown text={preview.text} className="text-[14.5px] leading-relaxed" />
      ) : tableRows && !source ? (
        <Table rows={tableRows} />
      ) : (
        <CodeViewer text={pretty ?? preview.text} language={language} wrap={wrap} />
      )}
      {preview.truncated && <p className="mt-3 text-[12px] text-muted">First {formatSize(preview.text.length)} only.</p>}
    </div>
  );
}

function HtmlBody({ sessionId, file }: { sessionId: string; file: ChatFile }) {
  const { preview, error } = useTextPreview(sessionId, file, true);
  if (error) return <p role="alert" className="p-4 text-sm text-danger">{error}</p>;
  if (!preview)
    return (
      <div className="flex justify-center p-8 text-muted">
        <Spinner className="size-5" />
      </div>
    );
  if (preview.truncated) return <Nothing file={file} sessionId={sessionId} />;
  // A document of its own: no scripts, no forms, no access to this page or its cookies (an empty `sandbox` is every restriction).
  return <iframe title={file.name} sandbox="" srcDoc={preview.text} referrerPolicy="no-referrer" className="h-full min-h-[60vh] w-full border-0 bg-white" />;
}

/** A file with nothing to show: its icon and name, and the way to take it. */
function Nothing({ sessionId, file }: { sessionId: string; file: ChatFile }) {
  const Icon = iconFor(file);
  return (
    <div className="flex flex-col items-center gap-3 p-10 text-center">
      <span className="flex size-16 items-center justify-center rounded-2xl bg-surface-2 text-ink-soft">
        <Icon className="size-8" />
      </span>
      <p className="max-w-full truncate text-sm font-semibold">{file.name}</p>
      <p className="text-[12px] text-muted tabular-nums">{formatSize(file.size)}</p>
      <button type="button" onClick={() => void saveFile(sessionId, file)} aria-label={`Download ${file.name}`} className="press inline-flex size-12 items-center justify-center rounded-full bg-ink text-bg">
        <Download className="size-5" />
      </button>
    </div>
  );
}

function Body({ sessionId, file }: { sessionId: string; file: ChatFile }) {
  const touch = useMediaQuery('(hover: none) and (pointer: coarse)');
  const url = fileUrl(sessionId, file.blobId);
  switch (file.preview) {
    case 'text':
      return <TextBody sessionId={sessionId} file={file} />;
    case 'html':
      return <HtmlBody sessionId={sessionId} file={file} />;
    case 'audio':
      return (
        <div className="flex h-full items-center justify-center p-6">
          <audio controls preload="metadata" src={url} className="w-full max-w-md" aria-label={file.name} />
        </div>
      );
    case 'video':
      return (
        <div className="flex h-full items-center justify-center bg-black p-2">
          <video controls playsInline preload="metadata" src={url} className="max-h-full max-w-full" aria-label={file.name} />
        </div>
      );
    // A phone's browser can't show a PDF inside a page: it opens in a tab of its own (the Open button).
    case 'pdf':
      return touch ? <Nothing file={file} sessionId={sessionId} /> : <iframe title={file.name} src={url} className="h-full min-h-[70vh] w-full border-0 bg-white" />;
    default:
      return <Nothing file={file} sessionId={sessionId} />;
  }
}

/** Opens in a tab of its own: what a browser can show by itself (a PDF, audio, video). */
const OPENS_IN_TAB = new Set(['pdf', 'audio', 'video']);

/**
 * A file previewed over the chat: text and code (secrets hidden), Markdown, CSV as a table, PDF, audio, video,
 * and HTML in a sandbox. Anything else shows its icon and a Download. A bottom sheet on a phone, a dialog from 640 px.
 */
export function FileViewer({ sessionId, file, onClose }: { sessionId: string; file: ChatFile | null; onClose: () => void }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{file && <Panel key={file.blobId} sessionId={sessionId} file={file} onClose={onClose} />}</AnimatePresence>
    </MotionConfig>,
    document.body,
  );
}

function Panel({ sessionId, file, onClose }: { sessionId: string; file: ChatFile; onClose: () => void }) {
  const ref = useModal<HTMLDivElement>(onClose);
  const Icon = iconFor(file);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <motion.div className="absolute inset-0 bg-black/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onClick={onClose} aria-hidden="true" />
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={file.name}
        tabIndex={-1}
        data-focus-container
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0, transition: { duration: 0.14 } }}
        transition={{ duration: 0.22, ease }}
        className="relative flex max-h-[92dvh] min-h-[40dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-bg shadow-lift outline-none sm:h-[80dvh] sm:max-w-3xl sm:rounded-3xl sm:border sm:border-line"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line py-1.5 pr-1.5 pl-4">
          <Icon className="size-[18px] shrink-0 text-muted" aria-hidden="true" />
          <p className="min-w-0 flex-1 truncate text-sm font-semibold" title={file.name}>
            {file.name}
            <span className="ml-2 font-normal text-muted tabular-nums">{formatSize(file.size)}</span>
          </p>
          {OPENS_IN_TAB.has(file.preview) && (
            <a href={fileUrl(sessionId, file.blobId)} target="_blank" rel="noopener noreferrer" className={BAR_BUTTON} aria-label="Open in a new tab" title="Open in a new tab">
              <ExternalLink className="size-[18px]" />
            </a>
          )}
          <button type="button" onClick={() => void saveFile(sessionId, file)} className={BAR_BUTTON} aria-label={`Download ${file.name}`} title="Download">
            <Download className="size-[18px]" />
          </button>
          <button type="button" onClick={onClose} className={BAR_BUTTON} aria-label="Close" title="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          <Body sessionId={sessionId} file={file} />
        </div>
      </motion.div>
    </div>
  );
}
