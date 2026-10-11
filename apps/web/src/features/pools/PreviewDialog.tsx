import { Dialog, RowsSkeleton } from '@isnanme/ui';
import type { MultiPoolType, PoolPreview } from '@portal/contracts';
import { FileLock2, FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { useEscapeFirst } from '@/lib/escape';
import { formatMode, formatOwner } from './labels';

/** Code reads in a code font; the tokens' `font-mono` is the UI font. */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/**
 * "Preview files" (foundation PRD §10): exactly what a pool would write, from the editor's unsaved
 * content when there is some, with paths, modes, owners and contents. Files that carry a secret come
 * back redacted from the portal. It may open over the editor, so Escape closes only the preview.
 */
export function PreviewDialog({
  open,
  onClose,
  type,
  poolId,
  content,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  type: MultiPoolType;
  /** Null for a pool not saved yet. */
  poolId: string | null;
  /** Unsaved content from the editor; undefined compiles the stored revision. */
  content?: unknown;
  /** Compile as this workspace gets it. */
  workspaceId?: string;
}) {
  const [preview, setPreview] = useState<PoolPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEscapeFirst(open, onClose);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError(null);
    let current = true;
    api.pools.preview(type, poolId, { content, workspaceId }).then(
      (p) => current && setPreview(p),
      (e: unknown) => current && setError(errorText(e, 'Could not compile it.')),
    );
    return () => void (current = false);
    // Compiled once per opening, from the content as it was then: not again on every keystroke.
  }, [open, type, poolId, workspaceId]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Preview files"
      description={
        preview
          ? `${preview.revision ? `Revision ${preview.revision}` : 'This pool'}${preview.workspaceId ? ` in ${preview.workspaceId.split('/').pop()}` : ''}: exactly what gets written. Secret files stay hidden.`
          : 'Exactly what gets written. Secret files stay hidden.'
      }
    >
      {error && (
        <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      {!preview && !error && <RowsSkeleton rows={2} lines={2} trailing={false} />}
      {preview && (
        <div className="flex flex-col gap-3">
          {preview.skipped.map((s) => (
            <p key={s.owner + s.reason} className="rounded-xl bg-flame-soft px-3.5 py-2.5 text-[13px] text-ink-soft">
              {s.reason}
            </p>
          ))}
          {preview.files.length === 0 ? (
            <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">Nothing to write.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {preview.files.map((f) => (
                <li key={f.path} className="overflow-hidden rounded-xl border border-line">
                  <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-3 py-2">
                    {f.redacted ? <FileLock2 className="size-3.5 shrink-0 text-muted" /> : <FileText className="size-3.5 shrink-0 text-muted" />}
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ fontFamily: MONO }} title={f.path}>
                      {f.path}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-muted" style={{ fontFamily: MONO }}>
                      {formatMode(f.mode)} {formatOwner(f.uid)}:{formatOwner(f.gid)}
                    </span>
                  </div>
                  <pre className="max-h-64 overflow-auto px-3 py-2 text-[12px] leading-relaxed break-all whitespace-pre-wrap" style={{ fontFamily: MONO }}>
                    {f.redacted ? <span className="text-muted">{f.content}</span> : f.content || <span className="text-muted">(empty)</span>}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
