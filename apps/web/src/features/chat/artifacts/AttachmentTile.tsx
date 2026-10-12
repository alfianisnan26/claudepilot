import { cn, Spinner } from '@isnanme/ui';
import { RotateCw, X } from 'lucide-react';
import { InfoTip } from '@/components/InfoTip';
import type { Attachment } from './useAttachments';
import { fileUrl } from './contentApi';
import { formatSize, iconFor, limitNote } from './fileKinds';

/** A circle that fills as an upload goes: no number, the fill says it. */
function Ring({ value }: { value: number }) {
  const r = 11;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 28 28" className="size-7 -rotate-90" aria-hidden="true">
      <circle cx="14" cy="14" r={r} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <circle cx="14" cy="14" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0.04, value)))} className="transition-[stroke-dashoffset] duration-150" />
    </svg>
  );
}

const REMOVE =
  'press absolute -top-1.5 -right-1.5 z-10 flex size-6 items-center justify-center rounded-full bg-ink text-bg shadow-card tap:size-7';

/**
 * One attachment in the composer: a picture is its thumbnail, anything else an icon with its name and size.
 * While it goes up it shows its progress, and × stops it; a failure says so and offers to try again. Audio,
 * video and files Claude can't open carry one ⓘ that says what Claude will and won't be able to do.
 */
export function AttachmentTile({ item, sessionId, onRemove, onRetry }: { item: Attachment; sessionId: string; onRemove: () => void; onRetry: () => void }) {
  const Icon = iconFor(item);
  const picture = item.upload?.preview === 'image' || (!item.upload && item.thumb) ? (item.thumb ?? (item.upload ? fileUrl(sessionId, item.upload.blobId) : undefined)) : undefined;
  const going = item.state === 'preparing' || item.state === 'uploading';
  const failed = item.state === 'error';
  const note = item.state === 'ready' ? limitNote({ ...item, reach: item.upload?.reach }) : null;
  const remove = (
    <button type="button" onClick={onRemove} aria-label={going ? `Cancel ${item.name}` : `Remove ${item.name}`} className={REMOVE}>
      <X className="size-3.5" />
    </button>
  );

  if (picture) {
    return (
      <li className="relative shrink-0">
        <div className="relative size-16 overflow-hidden rounded-2xl bg-surface-2" title={failed ? item.error : item.name}>
          <img src={picture} alt={item.name} className={cn('size-full object-cover', (going || failed) && 'opacity-50')} />
          {going && (
            <span className="absolute inset-0 flex items-center justify-center text-white drop-shadow">
              {item.state === 'preparing' ? <Spinner className="size-4" /> : <Ring value={item.progress} />}
            </span>
          )}
          {failed && (
            <button type="button" onClick={onRetry} aria-label={`Try ${item.name} again`} className="absolute inset-0 flex items-center justify-center bg-danger-soft/80 text-danger">
              <RotateCw className="size-5" />
            </button>
          )}
        </div>
        {remove}
      </li>
    );
  }

  return (
    <li className="relative h-16 w-44 shrink-0">
      <div className={cn('flex h-full items-center gap-2.5 overflow-hidden rounded-2xl bg-surface-2 pr-3 pl-2.5', failed && 'bg-danger-soft')} title={failed ? item.error : item.name}>
        <span className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface text-ink-soft">
          {going ? item.state === 'preparing' ? <Spinner className="size-4" /> : <span className="text-ink"><Ring value={item.progress} /></span> : <Icon className="size-5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight font-medium">{item.name}</span>
          <span className={cn('flex items-center gap-0.5 text-[11.5px] leading-tight tabular-nums', failed ? 'text-danger' : 'text-muted')}>
            {failed ? 'Failed' : going && item.state === 'uploading' ? `${Math.round(item.progress * 100)}%` : formatSize(item.size)}
            {note && <InfoTip label="What Claude can do with this file" className="size-5 [&_svg]:size-3.5">{note}</InfoTip>}
            {failed && (
              <button type="button" onClick={onRetry} aria-label={`Try ${item.name} again`} className="press -my-1 ml-1 inline-flex size-6 items-center justify-center rounded-full hover:bg-black/5">
                <RotateCw className="size-3.5" />
              </button>
            )}
          </span>
        </span>
      </div>
      {remove}
    </li>
  );
}
