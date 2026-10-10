import { Button, cn, Spinner, useMediaQuery, useToast } from '@isnanme/ui';
import { CHAT_IMAGE_TYPES, CHAT_MAX_IMAGE_BYTES, CHAT_MAX_IMAGES, type ChatAttachment, type ChatImageType } from '@portal/contracts';
import { ArrowUp, ChevronUp, ImagePlus, Paperclip, X } from 'lucide-react';
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import type { ChatSendOptions } from './useChatSocket';

export interface ComposerHandle {
  /** Puts text back in the box (a withdrawn message), unless something is already being written there. */
  restore: (text: string) => void;
}

/** An attached image, read and ready to send; `preview` is its `data:` URL. */
interface Picked extends ChatAttachment {
  id: string;
  preview: string;
}

let nextPickedId = 0;
const ACCEPT = CHAT_IMAGE_TYPES.join(',');
const MAX_SIZE = `${+(CHAT_MAX_IMAGE_BYTES / 1_000_000).toFixed(2)} MB`;
const isImageType = (type: string): type is ChatImageType => (CHAT_IMAGE_TYPES as readonly string[]).includes(type);
const hasFiles = (e: { dataTransfer: DataTransfer | null }) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * The message box. A textarea that grows with its content, a paperclip for images (paste and drop
 * work too) and Send. On a mouse-and-keyboard screen Enter sends and Shift+Enter makes a newline; on
 * a touch screen Enter makes a newline (so the on-screen keyboard's return key doesn't fire off
 * half-written messages) and Send is the way to send. Cmd/Ctrl+Enter always sends.
 *
 * While a turn is running, Send becomes Steer (Claude reads it at its next step) and its menu offers
 * "Send after this turn" (also Alt+Enter), which queues the message as its own turn. A message that
 * doesn't go through comes back into the box, unless something new is being written there.
 */
export function Composer({
  ref,
  onSend,
  connected,
  working,
}: {
  ref?: Ref<ComposerHandle>;
  onSend: (text: string, opts: ChatSendOptions) => Promise<void>;
  connected: boolean;
  working: boolean;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Picked[]>([]);
  const [reading, setReading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Counts kept outside render so quick successive adds see each other.
  const count = useRef({ attached: 0, reading: 0 });
  const dragDepth = useRef(0);
  const touch = useMediaQuery('(hover: none) and (pointer: coarse)');

  useImperativeHandle(ref, () => ({ restore: (value: string) => setText((t) => (t.trim() ? t : value)) }), []);

  useLayoutEffect(() => {
    count.current.attached = attachments.length;
  }, [attachments]);

  // Grow to fit the text, up to a cap, then scroll inside.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // A file dropped beside the composer would make the browser open it and leave the session.
  useEffect(() => {
    const guard = (e: globalThis.DragEvent) => hasFiles(e) && e.preventDefault();
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    const ok = files.filter((f) => isImageType(f.type) && f.size <= CHAT_MAX_IMAGE_BYTES);
    const room = Math.max(0, CHAT_MAX_IMAGES - count.current.attached - count.current.reading);
    const take = ok.slice(0, room);
    const problem = files.some((f) => !isImageType(f.type))
      ? 'Only PNG, JPEG, GIF and WebP images can be attached.'
      : ok.length < files.length
        ? `Each image can be up to ${MAX_SIZE}.`
        : take.length < ok.length
          ? `Up to ${CHAT_MAX_IMAGES} images per message.`
          : null;
    if (problem) toast(problem, 'error');
    if (take.length === 0) return;

    count.current.reading += take.length;
    setReading(count.current.reading);
    void Promise.all(
      take.map(async (file): Promise<Picked | null> => {
        try {
          const url = await readDataUrl(file);
          return {
            id: String(++nextPickedId),
            name: file.name || `image.${file.type.split('/')[1] ?? 'png'}`,
            mediaType: file.type as ChatImageType,
            dataBase64: url.slice(url.indexOf(',') + 1),
            preview: url,
          };
        } catch {
          return null;
        }
      }),
    ).then((read) => {
      count.current.reading -= take.length;
      setReading(count.current.reading);
      const good = read.filter((p): p is Picked => p !== null);
      if (good.length < read.length) toast('Could not read that image.', 'error');
      setAttachments((a) => [...a, ...good].slice(0, CHAT_MAX_IMAGES));
    });
  };

  const canSend = connected && reading === 0 && (text.trim().length > 0 || attachments.length > 0);

  const submit = (priority?: 'next' | 'later') => {
    if (!canSend) return;
    const draft = { text, attachments };
    setText('');
    setAttachments([]);
    const files = attachments.map(({ name, mediaType, dataBase64 }) => ({ name, mediaType, dataBase64 }));
    onSend(text.trim(), { priority, attachments: files }).catch((e: unknown) => {
      setText((t) => (t.trim() ? t : draft.text));
      setAttachments((a) => (a.length ? a : draft.attachments));
      toast(e instanceof Error ? e.message : 'Not sent.', 'error');
    });
    // Keep the caret in the box so a desktop user can keep typing.
    if (!touch) requestAnimationFrame(() => box.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.altKey) {
      e.preventDefault();
      submit(working ? 'later' : undefined);
    } else if (e.metaKey || e.ctrlKey || (!touch && !e.shiftKey)) {
      e.preventDefault();
      submit(working ? 'next' : undefined);
    }
  };

  // A pasted screenshot or copied image is attached rather than pasted as text.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items).flatMap((item) => {
      const file = item.kind === 'file' ? item.getAsFile() : null;
      return file ? [file] : [];
    });
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  };

  const drag = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      addFiles(Array.from(e.dataTransfer.files));
    },
  };

  return (
    <div className="relative flex flex-col gap-2" {...drag}>
      {(attachments.length > 0 || reading > 0) && (
        <ul aria-label="Images to send" className="flex flex-wrap gap-2 pt-1.5">
          {attachments.map((a) => (
            <li key={a.id} className="relative">
              <img src={a.preview} alt={a.name} className="size-16 rounded-xl border border-line bg-surface-2 object-cover" />
              <button
                type="button"
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                aria-label={`Remove ${a.name}`}
                className="press absolute -top-1.5 -right-1.5 flex size-6 items-center justify-center rounded-full bg-primary text-primary-ink shadow-card tap:size-7"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
          {reading > 0 && (
            <li className="flex size-16 items-center justify-center rounded-xl border border-line bg-surface-2 text-muted">
              <Spinner className="size-4" />
              <span className="sr-only">Reading the image…</span>
            </li>
          )}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <Button variant="ghost" size="icon" aria-label="Attach images" title="Attach images" onClick={() => fileInput.current?.click()} className="mb-0.5">
          <Paperclip className="size-[18px]" />
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <textarea
          ref={box}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label="Message"
          placeholder={working ? 'Steer Claude…' : 'Message Claude…'}
          className="max-h-[200px] min-h-[2.75rem] min-w-0 flex-1 resize-none rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-base text-ink outline-none transition-[border-color,box-shadow] placeholder:text-muted/70 hover:border-line-strong focus:border-ink/40 focus:ring-4 focus:ring-[var(--ring)]"
        />
        {working ? (
          <SteerButton canSend={canSend} connected={connected} showKeys={!touch} onSend={submit} />
        ) : (
          <Button size="icon" aria-label="Send message" disabled={!canSend} onClick={() => submit()} className="mb-0.5">
            <ArrowUp className="size-[18px]" />
          </Button>
        )}
      </div>
      {dragging && (
        <div className="pointer-events-none absolute -inset-1.5 z-10 flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-ink/30 bg-surface/90 text-sm font-semibold text-ink-soft">
          <ImagePlus className="size-4" aria-hidden="true" />
          Drop images to attach
        </div>
      )}
      {!connected && (
        <p className="px-1 text-[12px] text-muted" aria-live="polite">
          Reconnecting…
        </p>
      )}
    </div>
  );
}

const SPLIT =
  'inline-flex h-9 items-center justify-center bg-primary text-[13px] font-semibold text-primary-ink transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50 tap:h-11';

/**
 * Send while a turn runs: "Steer" (the message reaches Claude at its next step), and a menu that also
 * offers "Send after this turn". The menu opens upward, away from the screen edge.
 */
function SteerButton({
  canSend,
  connected,
  showKeys,
  onSend,
}: {
  canSend: boolean;
  connected: boolean;
  showKeys: boolean;
  onSend: (priority: 'next' | 'later') => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (priority: 'next' | 'later') => {
    setOpen(false);
    onSend(priority);
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div ref={wrap} className="relative mb-0.5 flex shrink-0">
      <button type="button" disabled={!canSend} onClick={() => onSend('next')} className={cn(SPLIT, 'gap-1.5 rounded-l-full pr-2.5 pl-3.5')}>
        <ArrowUp className="size-4" aria-hidden="true" />
        Steer
      </button>
      <button
        ref={trigger}
        type="button"
        disabled={!connected}
        onClick={() => setOpen((v) => !v)}
        aria-label="More ways to send"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(SPLIT, 'w-8 rounded-r-full border-l border-primary-ink/20 tap:w-9')}
      >
        <ChevronUp className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Send"
          onKeyDown={onMenuKey}
          className="absolute right-0 bottom-full z-40 mb-2 w-64 rounded-2xl border border-line bg-surface p-1.5 shadow-lift"
        >
          <SendItem label="Steer now" hint="Claude reads it at its next step." keys={showKeys ? 'Enter' : undefined} disabled={!canSend} onClick={() => pick('next')} />
          <SendItem
            label="Send after this turn"
            hint="Runs as its own turn when this one ends."
            keys={showKeys ? 'Alt+Enter' : undefined}
            disabled={!canSend}
            onClick={() => pick('later')}
          />
          {!canSend && <p className="px-3 pt-1 pb-1.5 text-[12px] text-muted">Write a message first.</p>}
        </div>
      )}
    </div>
  );
}

function SendItem({ label, hint, keys, disabled, onClick }: { label: string; hint: string; keys?: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left outline-none hover:bg-surface-2 focus:bg-surface-2 disabled:opacity-40"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="block text-[12px] text-muted">{hint}</span>
      </span>
      {keys && <kbd className="mt-0.5 shrink-0 rounded-md border border-line px-1.5 py-0.5 font-sans text-[10.5px] font-semibold text-muted">{keys}</kbd>}
    </button>
  );
}
