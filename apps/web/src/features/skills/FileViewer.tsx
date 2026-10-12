import { Button, RowsSkeleton } from '@isnanme/ui';
import { SKILL_FILE_PAGE_LINES, type SkillFileContent, type SkillFinding } from '@portal/contracts';
import { useEffect, useRef, useState } from 'react';
import { errorText } from '@/lib/api';
import { skillsApi } from './api';
import { MONO } from './labels';

/**
 * A read-only viewer for one file of a skill version (Skillset §13): monospace, line numbers, 500 lines
 * at a time, the lines findings point at highlighted. Skill files are hostile text: they show as plain
 * text only, never as rendered HTML, and the portal masks credentials before they get here (§14).
 */
export function FileViewer({
  versionId,
  path,
  findings,
  jumpTo,
}: {
  versionId: string;
  path: string;
  /** Findings in this file: their lines are highlighted. */
  findings: SkillFinding[];
  /** A 1-based line to bring into view (from a finding). */
  jumpTo?: { line: number; nonce: number } | null;
}) {
  const [pages, setPages] = useState<SkillFileContent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = async (offset: number) => {
    setLoading(true);
    try {
      const page = await skillsApi.file(versionId, path, offset);
      setPages((p) => [...p.filter((x) => x.offset !== offset), page].sort((a, b) => a.offset - b.offset));
      setError(null);
    } catch (e) {
      setError(errorText(e, 'Could not load the file.'));
    } finally {
      setLoading(false);
    }
  };
  // A new file starts from its first page; a finding deeper in loads the page it sits on.
  useEffect(() => {
    setPages([]);
    setError(null);
    void load(0);
  }, [versionId, path]);
  useEffect(() => {
    if (!jumpTo) return;
    const offset = Math.floor((jumpTo.line - 1) / SKILL_FILE_PAGE_LINES) * SKILL_FILE_PAGE_LINES;
    const have = pages.some((p) => p.offset === offset);
    if (!have) void load(offset);
    else document.getElementById(`line-${jumpTo.line}`)?.scrollIntoView({ block: 'center' });
  }, [jumpTo?.nonce]);
  useEffect(() => {
    if (jumpTo && pages.some((p) => p.offset === Math.floor((jumpTo.line - 1) / SKILL_FILE_PAGE_LINES) * SKILL_FILE_PAGE_LINES))
      document.getElementById(`line-${jumpTo.line}`)?.scrollIntoView({ block: 'center' });
  }, [pages.length]);

  const marked = new Map<number, SkillFinding[]>();
  for (const f of findings) if (f.line) marked.set(f.line, [...(marked.get(f.line) ?? []), f]);
  const first = pages[0];
  if (error && !first) return <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">{error}</p>;
  if (!first) return <RowsSkeleton rows={3} lines={1} trailing={false} />;
  if (first.binary) return <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">Not text: {first.size.toLocaleString('en')} bytes. Binary files are never shown.</p>;
  const last = pages[pages.length - 1]!;
  const more = last.offset + last.lines.length < last.totalLines;
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div ref={box} className="max-h-[28rem] overflow-auto bg-surface-2/40 py-1.5 text-[12.5px] leading-relaxed" style={{ fontFamily: MONO }}>
        {pages.flatMap((p) =>
          p.lines.map((text, i) => {
            const n = p.offset + i + 1;
            const hit = marked.get(n);
            return (
              <div key={n} id={`line-${n}`} className={hit ? 'flex bg-amber-500/15' : 'flex'} title={hit?.map((f) => f.title).join(' · ')}>
                <span className="w-12 shrink-0 pr-3 text-right text-muted select-none">{n}</span>
                <span className="min-w-0 flex-1 pr-3 break-all whitespace-pre-wrap">{text || ' '}</span>
              </div>
            );
          }),
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line bg-surface px-3 py-1.5 text-[12px] text-muted">
        <span>
          {last.totalLines.toLocaleString('en')} line{last.totalLines === 1 ? '' : 's'} · {first.size.toLocaleString('en')} bytes
        </span>
        {more && (
          <Button size="sm" variant="ghost" loading={loading} onClick={() => void load(last.offset + SKILL_FILE_PAGE_LINES)}>
            Show the next {SKILL_FILE_PAGE_LINES}
          </Button>
        )}
      </div>
    </div>
  );
}
