import { cn } from '@isnanme/ui';
import type { ChatEvent, ChatFile } from '@portal/contracts';
import { Archive, ChevronDown, Download } from 'lucide-react';
import { useState } from 'react';
import { ImageThumbs, type ViewerImage } from '../ImageViewer';
import { fileUrl, zipUrl } from './contentApi';
import { FileViewer } from './FileViewer';
import { formatSize, iconFor } from './fileKinds';
import { saveFile } from './save';
import type { TurnFiles } from './turns';

/** Pictures the browser shows as pictures; everything else (an SVG included) is a file you open or save. */
const isPicture = (f: ChatFile) => f.preview === 'image' && /^image\/(?:png|jpeg|gif|webp)$/.test(f.mediaType);

const ICON_BUTTON = 'press inline-flex size-9 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-surface-2 hover:text-ink tap:size-11';

/** A picture as the viewer takes it. */
export const asViewerImage = (sessionId: string, f: ChatFile): ViewerImage => ({
  src: fileUrl(sessionId, f.blobId),
  alt: f.name,
  name: f.name,
  width: f.width,
  height: f.height,
  mediaType: f.mediaType,
});

/** One file as a card: its icon, its name and size, and a Download; a tap anywhere else opens the preview. */
function FileCard({ sessionId, file, onOpen }: { sessionId: string; file: ChatFile; onOpen: () => void }) {
  const Icon = iconFor(file);
  return (
    <div className="flex w-full max-w-md items-center gap-1 rounded-2xl border border-line bg-surface py-1.5 pr-1.5 pl-2">
      <button type="button" onClick={onOpen} aria-haspopup="dialog" className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-0.5 pr-1 text-left">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-soft">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] leading-tight font-medium" title={file.name}>
            {file.name}
          </span>
          <span className="block text-[11.5px] leading-tight text-muted tabular-nums">{formatSize(file.size)}</span>
        </span>
      </button>
      <button type="button" onClick={() => void saveFile(sessionId, file)} className={ICON_BUTTON} aria-label={`Download ${file.name}`} title="Download">
        <Download className="size-[18px]" />
      </button>
    </div>
  );
}

/** "Download all": the files of the turn's artifact events in one zip. */
function DownloadAll({ sessionId, turn }: { sessionId: string; turn: TurnFiles }) {
  return (
    <a
      href={zipUrl(sessionId, turn.seqs)}
      download
      aria-label={`Download all ${turn.count} files`}
      title="Download all"
      className="press inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold text-ink-soft hover:bg-surface-2 hover:text-ink tap:h-11"
    >
      <Archive className="size-4" aria-hidden="true" />
      <span className="tabular-nums">{turn.count}</span>
    </a>
  );
}

/** More than this many files in one place fold into a group. */
const GROUP_FROM = 4;

/**
 * What the agent produced, where it happened: pictures as thumbnails, the rest as file cards. A tap opens a
 * preview, each card has its Download, and the turn's last block also has one Download all. Several files
 * fold into one row that opens.
 */
export function ArtifactBlock({ sessionId, event, turn }: { sessionId: string; event: ChatEvent; turn?: TurnFiles }) {
  const [viewing, setViewing] = useState<ChatFile | null>(null);
  const [open, setOpen] = useState(false);
  const files = (event.files ?? []).filter((_, i) => !turn?.replaced.has(i));
  if (files.length === 0) return null;
  const pictures = files.filter(isPicture);
  const others = files.filter((f) => !isPicture(f));
  const grouped = others.length >= GROUP_FROM;
  return (
    <div className="flex flex-col items-start gap-2">
      {pictures.length > 0 && <ImageThumbs images={pictures.map((f) => asViewerImage(sessionId, f))} actions />}
      {grouped && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="press flex w-full max-w-md items-center gap-2 rounded-2xl border border-line bg-surface px-3 py-2.5 text-left text-[13.5px] font-medium"
        >
          <span className="flex-1">{others.length} files</span>
          <ChevronDown className={cn('size-4 text-muted transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </button>
      )}
      {(!grouped || open) && others.map((f, i) => <FileCard key={`${f.blobId}:${i}`} sessionId={sessionId} file={f} onOpen={() => setViewing(f)} />)}
      {turn?.last && turn.count >= 2 && <DownloadAll sessionId={sessionId} turn={turn} />}
      <FileViewer sessionId={sessionId} file={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

/** Files attached to a message, as chips in its bubble; a tap opens the preview. */
export function FileChips({ sessionId, files, align = 'start' }: { sessionId: string; files: ChatFile[]; align?: 'start' | 'end' }) {
  const [viewing, setViewing] = useState<ChatFile | null>(null);
  if (files.length === 0) return null;
  return (
    <>
      <ul className={cn('flex max-w-full flex-wrap gap-2', align === 'end' && 'justify-end')}>
        {files.map((f, i) => {
          const Icon = iconFor(f);
          return (
            <li key={`${f.blobId}:${i}`} className="min-w-0 max-w-full">
              <button type="button" onClick={() => setViewing(f)} aria-haspopup="dialog" className="press flex max-w-full items-center gap-2 rounded-2xl bg-ink/[0.08] py-1.5 pr-3 pl-2 text-left">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-ink-soft">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block max-w-[14rem] truncate text-[13px] leading-tight font-medium" title={f.name}>
                    {f.name}
                  </span>
                  <span className="block text-[11px] leading-tight text-muted tabular-nums">{formatSize(f.size)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <FileViewer sessionId={sessionId} file={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
