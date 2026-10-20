import { Button, cn } from '@isnanme/ui';
import type { ChatDiff, ChatDiffFile } from '@portal/contracts';
import { FileDiff, GitBranch } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorText } from '@/lib/api';
import { chatApi } from './api';

/** A real code font: the kit's `font-mono` is the UI font with tabular figures. */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
/** Patch lines drawn at first and per "Show more": a 1 MB patch runs to tens of thousands of lines. */
const LINE_BUDGET = 2000;

type LineKind = 'file' | 'meta' | 'hunk' | 'add' | 'del' | 'ctx' | 'note';

const LINE_CLASS: Record<LineKind, string> = {
  file: 'mt-3 border-y border-line bg-surface-2 py-1 font-semibold text-ink first:mt-0',
  meta: 'text-muted',
  hunk: 'bg-surface-2/70 text-muted',
  add: 'bg-accent-soft text-accent',
  del: 'bg-danger-soft text-danger',
  ctx: 'text-ink-soft',
  note: 'italic text-muted',
};

const WARN = 'bg-amber-500/12 text-amber-700 dark:text-amber-400';
const STATUS: Record<string, { label: string; className: string }> = {
  M: { label: 'Modified', className: WARN },
  A: { label: 'Added', className: 'bg-accent-soft text-accent' },
  D: { label: 'Deleted', className: 'bg-danger-soft text-danger' },
  R: { label: 'Renamed', className: 'bg-surface-2 text-ink-soft' },
  C: { label: 'Copied', className: 'bg-surface-2 text-ink-soft' },
  T: { label: 'Type changed', className: WARN },
  U: { label: 'Conflict', className: 'bg-danger-soft text-danger' },
  '??': { label: 'Untracked', className: 'bg-surface-2 text-muted' },
};

/** Calls `refresh` when `active` turns true again after the first time (a tab you come back to). */
export function useReturnRefresh(active: boolean, refresh: () => void) {
  const was = useRef(active);
  const refreshRef = useRef(refresh);
  useLayoutEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    if (active && !was.current) refreshRef.current();
    was.current = active;
  }, [active]);
}

/** Each line's role: file headers and their metadata up to the first hunk, then hunk lines by prefix. */
function classify(lines: string[]): LineKind[] {
  const kinds: LineKind[] = [];
  let header = false;
  for (const l of lines) {
    if (l.startsWith('diff --git ')) {
      kinds.push('file');
      header = true;
    } else if (l.startsWith('@@')) {
      kinds.push('hunk');
      header = false;
    } else if (header) kinds.push('meta');
    else kinds.push(l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l[0] === '\\' ? 'note' : 'ctx');
  }
  return kinds;
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A path from a patch header: git C-quotes special characters and tabs a name that has a space. */
function headerName(raw: string): string {
  const s = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const enc = new TextEncoder();
  const bytes: number[] = [];
  let last = 0;
  for (const m of body.matchAll(/\\([0-7]{3}|[abtnvfr"\\])/g)) {
    bytes.push(...enc.encode(body.slice(last, m.index)));
    const e = m[1]!;
    bytes.push(e.length === 3 ? parseInt(e, 8) & 0xff : ESCAPES[e]!);
    last = m.index + m[0].length;
  }
  bytes.push(...enc.encode(body.slice(last)));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const unprefix = (name: string, prefix: string) => (name.startsWith(prefix) ? name.slice(prefix.length) : name);

/** Where each file's section starts in the patch, by the path git status names it with. */
function sectionStarts(lines: string[], kinds: LineKind[]): Map<string, number> {
  const starts = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    if (kinds[i] !== 'file') continue;
    let path: string | null = null;
    for (let j = i + 1; j < lines.length && kinds[j] === 'meta'; j++) {
      const l = lines[j]!;
      if (l.startsWith('+++ ') && l !== '+++ /dev/null') path = unprefix(headerName(l.slice(4)), 'b/');
      else if (l.startsWith('--- ') && l !== '--- /dev/null') path ??= unprefix(headerName(l.slice(4)), 'a/');
      else if (l.startsWith('rename to ')) path = headerName(l.slice('rename to '.length));
      else if (l.startsWith('copy to ')) path = headerName(l.slice('copy to '.length));
    }
    // No ---/+++ (binary, mode only): `diff --git a/<p> b/<p>` when both sides name the same path.
    if (path === null) {
      const rest = lines[i]!.slice('diff --git '.length);
      const n = (rest.length - 5) / 2;
      if (Number.isInteger(n) && n > 0 && rest.startsWith('a/') && rest.slice(2 + n, 5 + n) === ' b/' && rest.slice(2, 2 + n) === rest.slice(5 + n)) path = rest.slice(2, 2 + n);
    }
    if (path !== null && !starts.has(path)) starts.set(path, i);
  }
  return starts;
}

const ROW = 'flex min-h-11 w-full items-center gap-2.5 px-4 py-2 text-left';

/**
 * The Changes tab: the files git reports (status letter, +/− counts; a tap jumps to the file's diff),
 * then the unified patch, added lines green and removed lines red, scrolling sideways on its own.
 */
export function DiffView({ sessionId, active }: { sessionId: string; active: boolean }) {
  const [diff, setDiff] = useState<ChatDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [budget, setBudget] = useState(LINE_BUDGET);
  const [jump, setJump] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    chatApi.diff(sessionId).then(
      (d) => {
        if (!alive) return;
        setDiff(d);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(errorText(e, 'Couldn’t read the changes.'));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [sessionId, reload]);

  useReturnRefresh(active, () => setReload((n) => n + 1));

  const patch = useMemo(() => {
    const lines = diff?.patch ? diff.patch.split('\n') : [];
    if (lines.at(-1) === '') lines.pop();
    const kinds = classify(lines);
    return { lines, kinds, starts: sectionStarts(lines, kinds) };
  }, [diff?.patch]);

  // A jump into lines not drawn yet draws up to them first, then scrolls.
  useEffect(() => {
    if (jump === null) return;
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>(`[data-line="${jump}"]`);
    if (box && el) box.scrollTo({ top: el.offsetTop - 8, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setJump(null);
  }, [jump, budget]);
  const goTo = (line: number) => {
    if (line >= budget) setBudget(line + LINE_BUDGET);
    setJump(line);
  };

  const added = diff?.files.reduce((n, f) => n + (f.additions ?? 0), 0) ?? 0;
  const removed = diff?.files.reduce((n, f) => n + (f.deletions ?? 0), 0) ?? 0;
  const summary = !diff
    ? loading
      ? 'Reading changes…'
      : ''
    : diff.repo === null
      ? 'Not a git repository'
      : diff.files.length === 0
        ? 'No changes'
        : `${diff.files.length} ${diff.files.length === 1 ? 'file' : 'files'} changed`;
  const rest = patch.lines.length - budget;

  return (
    <section hidden={!active} aria-label="Changes" className="absolute inset-0 flex flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line py-1.5 pr-2 pl-4">
        <p className="min-w-0 flex-1 truncate text-[12.5px] text-muted tabular-nums">
          {summary}
          {diff && diff.files.length > 0 && (added > 0 || removed > 0) && (
            <>
              {' · '}
              <span className="text-accent">+{added}</span> <span className="text-danger">−{removed}</span>
            </>
          )}
        </p>
        <Button size="sm" variant="ghost" loading={loading} onClick={() => setReload((n) => n + 1)}>
          Refresh
        </Button>
      </div>

      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={loading || undefined}>
        {error ? (
          <div role="alert" className="m-4 rounded-2xl border border-line bg-surface p-4">
            <p className="text-[13.5px] text-ink-soft">{error}</p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => setReload((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : !diff ? (
          <PatchSkeleton />
        ) : diff.repo === null ? (
          <Empty icon={<GitBranch className="size-6" />} title="Not a git repository">
            The agent’s folder isn’t in a git repository, so there are no changes to show.
          </Empty>
        ) : diff.files.length === 0 ? (
          <Empty icon={<FileDiff className="size-6" />} title="No changes">
            Nothing has changed since the last commit.
          </Empty>
        ) : (
          <div className={cn(loading && 'opacity-60 transition-opacity')}>
            <ul aria-label="Changed files" className="divide-y divide-line border-b border-line">
              {diff.files.map((f) => (
                <FileRow key={f.path} file={f} line={patch.starts.get(f.path)} onJump={goTo} />
              ))}
            </ul>
            {diff.truncated && (
              <p role="note" className={cn('mx-3 mt-3 rounded-xl px-3 py-2 text-[12.5px] font-medium', WARN)}>
                Diff was cut short: it’s too large to show in full here.
              </p>
            )}
            {patch.lines.length === 0 ? (
              <p className="px-4 py-4 text-[12.5px] text-muted">No tracked changes to show. Untracked files are listed, not diffed.</p>
            ) : (
              <div className="py-3">
                <div
                  role="region"
                  aria-label="Unified diff"
                  tabIndex={0}
                  className="overflow-x-auto overscroll-x-contain focus-visible:outline-offset-[-2px]"
                  style={{ fontFamily: MONO }}
                >
                  <div className="inline-block min-w-full text-[12px] leading-[1.6]" style={{ tabSize: 4 }}>
                    {patch.lines.slice(0, budget).map((line, i) => (
                      <div key={i} data-line={i} className={cn('px-3 whitespace-pre', LINE_CLASS[patch.kinds[i]!])}>
                        {line || ' '}
                      </div>
                    ))}
                  </div>
                </div>
                {rest > 0 && (
                  <div className="flex items-center gap-3 px-4 pt-3">
                    <Button size="sm" variant="secondary" onClick={() => setBudget((b) => b + LINE_BUDGET)}>
                      Show {Math.min(rest, LINE_BUDGET).toLocaleString()} more lines
                    </Button>
                    <span className="text-[12px] text-muted tabular-nums">{rest.toLocaleString()} left</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** One changed file: its status letter, name and folder, and +/− counts; a tap jumps to its diff. */
function FileRow({ file: f, line, onJump }: { file: ChatDiffFile; line: number | undefined; onJump: (line: number) => void }) {
  const status = STATUS[f.status] ?? { label: f.status, className: 'bg-surface-2 text-ink-soft' };
  const slash = f.path.replace(/\/$/, '').lastIndexOf('/');
  const name = f.path.slice(slash + 1);
  const dir = f.path.slice(0, slash + 1);
  const body = (
    <>
      <span
        title={status.label}
        className={cn('flex h-5 min-w-6 shrink-0 items-center justify-center rounded-md px-1 text-[11px] font-bold', status.className)}
        style={{ fontFamily: MONO }}
      >
        {f.status}
        <span className="sr-only">, {status.label}:</span>
      </span>
      <span title={f.path} className="min-w-0 flex-1 truncate text-[13px]">
        <span className="font-medium">{name}</span>
        {dir && <span className="ml-1.5 text-[11.5px] text-muted">{dir}</span>}
      </span>
      <Counts file={f} />
    </>
  );
  return (
    <li>
      {line === undefined ? (
        <div className={ROW}>{body}</div>
      ) : (
        <button type="button" onClick={() => onJump(line)} className={cn(ROW, 'hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-offset-[-2px]')}>
          {body}
        </button>
      )}
    </li>
  );
}

function Counts({ file: f }: { file: ChatDiffFile }) {
  if (f.additions === null && f.deletions === null) return f.status === '??' ? null : <span className="shrink-0 text-[11.5px] text-muted">binary</span>;
  return (
    <span title={`${f.additions ?? 0} added, ${f.deletions ?? 0} removed`} className="flex shrink-0 gap-1.5 text-[12px] font-semibold tabular-nums">
      {!!f.additions && <span className="text-accent">+{f.additions}</span>}
      {!!f.deletions && <span className="text-danger">−{f.deletions}</span>}
    </span>
  );
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-ink-soft">{icon}</span>
      <p className="mt-4 text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-xs text-[13px] text-muted">{children}</p>
    </div>
  );
}

function PatchSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-2.5 p-4">
      {['w-3/5', 'w-2/5', 'w-1/2', 'w-full', 'w-11/12', 'w-4/5', 'w-full', 'w-2/3'].map((w, i) => (
        <span key={i} className={cn('skeleton h-3 rounded-full', w)} />
      ))}
    </div>
  );
}
