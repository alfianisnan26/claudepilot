import { Badge, ConfirmDialog, useToast } from '@isnanme/ui';
import { TICKET_API, TICKET_ATTACHMENT_INLINE_TYPES, TICKET_ATTACHMENT_LIMITS, type TicketAttachment } from '@portal/contracts';
import { Download, FileText, Paperclip, Trash2 } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { ticketsApi } from './api';
import { actorName } from './labels';

/** `1.2 MB`, `840 KB`, `12 B`. */
export function fileSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

const isPreview = (a: TicketAttachment) => (TICKET_ATTACHMENT_INLINE_TYPES as readonly string[]).includes(a.mediaType);

/**
 * A ticket's files (owner, 2026-10-17: "ticket support with attachment, all files"): any type, up to 50 MB each. Pick files with the
 * button or drop them on the card; images show a small preview, everything downloads. Rows are 44 px targets; names break anywhere.
 */
export function Attachments({ ticketId, attachments, onChanged }: { ticketId: string; attachments: TicketAttachment[]; onChanged: () => Promise<void> | void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const [removing, setRemoving] = useState<TicketAttachment | null>(null);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    const tooBig = list.filter((f) => f.size > TICKET_ATTACHMENT_LIMITS.maxBytes);
    if (tooBig.length) toast(`${tooBig.map((f) => f.name).join(', ')}: over ${TICKET_ATTACHMENT_LIMITS.maxBytes / 1024 / 1024} MB`, 'error');
    const ok = list.filter((f) => f.size <= TICKET_ATTACHMENT_LIMITS.maxBytes);
    setBusy((n) => n + ok.length);
    let done = 0;
    for (const f of ok) {
      try {
        await ticketsApi.attach(ticketId, f);
        done++;
      } catch (e) {
        toast(`${f.name}: ${errorText(e, 'Couldn’t attach it.')}`, 'error');
      } finally {
        setBusy((n) => n - 1);
      }
    }
    if (done) {
      toast(done === 1 ? 'File attached' : `${done} files attached`);
      await onChanged();
    }
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
  };

  const remove = async () => {
    const a = removing;
    if (!a) return;
    setRemoving(null);
    try {
      await ticketsApi.removeAttachment(ticketId, a.id);
      toast('File removed');
      await onChanged();
    } catch (e) {
      toast(errorText(e, 'Couldn’t remove it.'), 'error');
    }
  };

  return (
    <div
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      data-ticket-files=""
    >
    <Card className={`p-4 sm:p-5 ${over ? 'ring-2 ring-accent' : ''}`}>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="flex min-w-0 flex-1 items-center gap-1 text-[13px] font-semibold text-muted">
          Files {attachments.length > 0 && <span className="tabular-nums">· {attachments.length}</span>}
          <InfoTip label="About files">Any file, up to {TICKET_ATTACHMENT_LIMITS.maxBytes / 1024 / 1024} MB each. Drop files here or pick them. Agents read and add files through the portal's tools.</InfoTip>
        </h2>
        <input ref={input} type="file" multiple className="hidden" onChange={(e) => (e.target.files ? void upload(e.target.files).finally(() => (e.target.value = '')) : undefined)} />
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy > 0}
          className="press inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-[13px] font-semibold hover:bg-surface-2 disabled:opacity-60"
          aria-label="Attach files"
        >
          <Paperclip className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">{busy > 0 ? `Uploading ${busy}` : 'Attach'}</span>
          {busy > 0 && <span className="sm:hidden tabular-nums">{busy}</span>}
        </button>
      </div>
      {attachments.length === 0 ? (
        <p className="text-sm text-muted">No files.</p>
      ) : (
        <ul className="divide-y divide-line">
          {attachments.map((a) => {
            const href = TICKET_API.attachment(ticketId, a.id);
            return (
              <li key={a.id} className="flex min-h-11 items-center gap-3 py-2">
                {isPreview(a) ? (
                  <a href={href} target="_blank" rel="noreferrer" className="shrink-0" aria-label={`Open ${a.name}`}>
                    <img src={href} alt="" loading="lazy" className="size-11 rounded-lg border border-line object-cover" />
                  </a>
                ) : (
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted" aria-hidden="true">
                    <FileText className="size-5" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <a href={`${href}?download`} className="block text-[14px] font-medium [overflow-wrap:anywhere] hover:text-accent" download={a.name}>
                    {a.name}
                  </a>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
                    <span className="tabular-nums">{fileSize(a.size)}</span>
                    <span>{actorName(a.actor, a.actorLabel)}</span>
                    <span title={a.at}>{timeAgo(a.at)}</span>
                    {a.fromAgent && <Badge>Agent</Badge>}
                  </span>
                </span>
                <a href={`${href}?download`} download={a.name} className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink" aria-label={`Download ${a.name}`}>
                  <Download className="size-[18px]" />
                </a>
                <button type="button" onClick={() => setRemoving(a)} className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-danger-soft hover:text-danger" aria-label={`Remove ${a.name}`}>
                  <Trash2 className="size-[18px]" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={!!removing}
        title="Remove file?"
        description={removing ? `${removing.name} is removed from this ticket.` : ''}
        confirmLabel="Remove"
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </Card>
    </div>
  );
}
