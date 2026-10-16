import { cn, useMediaQuery, useToast } from '@isnanme/ui';
import type { ChatFile, ChatUpload } from '@portal/contracts';
import { ArrowUp, ChevronUp, MessageCircleQuestionMark, Plus, Square, Upload } from 'lucide-react';
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { AttachmentTile } from './artifacts/AttachmentTile';
import { fileUrl } from './artifacts/contentApi';
import { useAttachments } from './artifacts/useAttachments';
import { parseSlash, slashMatches } from './btw/slash';
import { isTrustDeclined } from './TrustSheet';
import type { ChatSendOptions } from './useChatSocket';

export interface ComposerHandle {
  /** Puts text back in the box (a withdrawn message), unless something is already being written there. */
  restore: (text: string) => void;
  /** Puts the caret back in the box (the btw card closed). */
  focus: () => void;
}

const hasFiles = (e: { dataTransfer: DataTransfer | null }) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

/** What the transcript shows for attachments just sent, until the stored message replaces it (the files are already in the portal). */
function shownFor(sessionId: string, uploads: ChatUpload[]): NonNullable<ChatSendOptions['shown']> {
  const images: { src: string; name: string; width?: number; height?: number }[] = [];
  const files: ChatFile[] = [];
  for (const { id: _id, ...file } of uploads) {
    if (file.preview === 'image' && file.mediaType !== 'image/svg+xml') images.push({ src: fileUrl(sessionId, file.blobId), name: file.name, width: file.width, height: file.height });
    else files.push(file);
  }
  return { images, files };
}

/**
 * The message box, one floating frosted card: the text on top, growing with what's written, and a row
 * under it with + for files (paste works, and so does dropping them anywhere on the page), the session's
 * controls (`accessory`) and Send. Anything can be attached: photos, screenshots, documents, audio, video.
 * Each file gets a tile that shows its upload; Send waits for them. On a mouse-and-keyboard screen Enter
 * sends and Shift+Enter makes a newline; on a touch screen Enter makes a newline (so the on-screen
 * keyboard's return key doesn't fire off half-written messages) and Send is the way to send. Cmd/Ctrl+Enter
 * always sends.
 *
 * While a turn is running, Send becomes Steer (Claude reads it at its next step) and its menu offers
 * "Send after this turn" (also Alt+Enter), which queues the message as its own turn. A message that
 * doesn't go through comes back into the box, unless something new is being written there.
 */
export function Composer({
  ref,
  sessionId,
  onSend,
  connected,
  working,
  onStop,
  accessory,
  onBtw,
  btwBusy,
}: {
  ref?: Ref<ComposerHandle>;
  /** The chat the files are uploaded to. */
  sessionId: string;
  onSend: (text: string, opts: ChatSendOptions) => Promise<void>;
  connected: boolean;
  working: boolean;
  /** While a turn runs and nothing is written, Send becomes Stop. */
  onStop?: () => void;
  /** The session's controls (model and effort, mode, context), in the row under the text. */
  accessory?: ReactNode;
  /** Asks a side question (btw): `/btw <question>` or the button. Absent: no btw here. */
  onBtw?: (question: string) => void;
  /** One is still running: another can't start. */
  btwBusy?: boolean;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const touch = useMediaQuery('(hover: none) and (pointer: coarse)');
  const att = useAttachments(sessionId, (message) => toast(message, 'error'));
  const add = useRef(att.add);
  add.current = att.add;

  useImperativeHandle(ref, () => ({ restore: (value: string) => setText((t) => (t.trim() ? t : value)), focus: () => box.current?.focus() }), []);

  // Slash commands: typing "/" suggests them; Enter or Tab completes the highlighted one. Escape hides the list until the text changes.
  const matches = onBtw ? slashMatches(text) : [];
  const [pick, setPick] = useState(0);
  const [hidden, setHidden] = useState(false);
  const listOpen = matches.length > 0 && !hidden;
  const listId = useId();
  useEffect(() => {
    setHidden(false);
    setPick(0);
  }, [text]);
  const complete = (name: string) => {
    setText(`/${name} `);
    requestAnimationFrame(() => box.current?.focus());
  };
  /** The button: asks what is written, or starts the command when the box is empty. */
  const askBtw = () => {
    if (!onBtw) return;
    const t = text.trim();
    const q = parseSlash(t)?.name === 'btw' ? parseSlash(t)!.rest : t;
    if (!q) {
      setText('/btw ');
      box.current?.focus();
      return;
    }
    runBtw(q);
  };
  const runBtw = (q: string) => {
    if (btwBusy) return toast('One side question at a time.', 'error');
    if (!connected) return;
    onBtw?.(q);
    setText('');
  };

  // Grow to fit the text, up to about a third of the screen, then scroll inside.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.max(120, Math.round(window.innerHeight * 0.32)))}px`;
  }, [text]);

  // Files dropped anywhere on the page are attached (and a file dropped beside the composer must not make the browser open it and leave the chat).
  useEffect(() => {
    const enter = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    };
    const over = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const drop = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      add.current(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const ready = att.items.filter((a) => a.state === 'ready').length;
  const failed = att.items.some((a) => a.state === 'error');
  const canSend = connected && !att.busy && !failed && (text.trim().length > 0 || ready > 0);

  const submit = (priority?: 'next' | 'later') => {
    const cmd = onBtw ? parseSlash(text) : null;
    if (cmd?.name === 'btw') {
      if (cmd.rest) runBtw(cmd.rest);
      return;
    }
    if (!canSend) return;
    const draft = { text, uploads: att.take() };
    setText('');
    onSend(text.trim(), { priority, attachments: draft.uploads.map((u) => ({ uploadId: u.id })), shown: shownFor(sessionId, draft.uploads) }).catch((e: unknown) => {
      setText((t) => (t.trim() ? t : draft.text));
      att.restore(draft.uploads);
      // Cancelled on "Trust this folder?": the words coming back say enough.
      if (!isTrustDeclined(e)) toast(e instanceof Error ? e.message : 'Not sent.', 'error');
    });
    // Keep the caret in the box so a desktop user can keep typing.
    if (!touch) requestAnimationFrame(() => box.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (listOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPick((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        complete(matches[pick]!.name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setHidden(true);
        return;
      }
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.altKey) {
      e.preventDefault();
      submit(working ? 'later' : undefined);
    } else if (e.metaKey || e.ctrlKey || (!touch && !e.shiftKey)) {
      e.preventDefault();
      submit(working ? 'next' : undefined);
    }
  };

  // A pasted screenshot or copied file is attached rather than pasted as text.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items).flatMap((item) => {
      const file = item.kind === 'file' ? item.getAsFile() : null;
      return file ? [file] : [];
    });
    if (files.length === 0) return;
    e.preventDefault();
    att.add(files);
  };

  return (
    // The floor of a popover opened above it (lib/popover.ts): a note from the stack above never covers the composer.
    <div data-popover-floor="" className="relative">
      {listOpen && (
        <ul id={listId} role="listbox" aria-label="Commands" className="absolute right-0 bottom-full left-0 z-40 mb-2 max-w-xs rounded-2xl border border-line bg-surface p-1.5 shadow-lift">
          {matches.map((c, i) => (
            <li
              key={c.name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === pick}
              onPointerDown={(e) => {
                e.preventDefault();
                complete(c.name);
              }}
              className={cn('flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm', i === pick && 'bg-surface-2')}
            >
              <span className="font-semibold text-ink">/{c.name}</span>
              <span className="min-w-0 truncate text-[12px] text-muted">{c.hint}</span>
            </li>
          ))}
        </ul>
      )}
      <div data-composer="" className="glass-card rounded-[28px]">
        {att.items.length > 0 && (
          <ul aria-label="Attachments" className="no-scrollbar flex gap-2 overflow-x-auto px-3.5 pt-3.5 pb-0.5">
            {att.items.map((item) => (
              <AttachmentTile key={item.key} item={item} sessionId={sessionId} onRemove={() => att.remove(item.key)} onRetry={() => att.retry(item.key)} />
            ))}
          </ul>
        )}
        <textarea
          ref={box}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label="Message"
          {...(listOpen ? { role: 'combobox', 'aria-expanded': true, 'aria-controls': listId, 'aria-activedescendant': `${listId}-${pick}`, 'aria-autocomplete': 'list' as const } : {})}
          placeholder={working ? 'Steer Claude…' : 'Message Claude…'}
          className="block min-h-[52px] w-full resize-none bg-transparent px-[18px] pt-[15px] pb-1 text-[16.5px] leading-[1.45] text-ink outline-hidden placeholder:text-muted sm:text-[15.5px]"
        />
        <div data-steer={working && canSend ? '' : undefined} className="flex items-center gap-1 px-2 pt-1 pb-2.5 sm:gap-1.5 sm:px-2.5">
          <button type="button" aria-label="Attach files" title="Attach files" onClick={() => fileInput.current?.click()} className={cn(ROUND, GHOST)}>
            <Plus className="size-5" />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              att.add(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <div className="flex min-w-0 flex-1 items-center">{accessory}</div>
          {onBtw && (
            <button
              type="button"
              data-guide="btw"
              aria-label="Ask btw"
              title={btwBusy ? 'One side question at a time' : 'btw'}
              disabled={!connected || btwBusy}
              onClick={askBtw}
              className={cn(ROUND, GHOST, 'lg:w-auto lg:gap-1.5 lg:px-3.5')}
            >
              <MessageCircleQuestionMark className="size-5" aria-hidden="true" />
              <span className="hidden text-[13.5px] font-semibold lg:inline">btw</span>
            </button>
          )}
          {working && canSend ? (
            <SteerButton canSend={canSend} connected={connected} showKeys={!touch} onSend={submit} onStop={onStop} />
          ) : working && onStop ? (
            <button type="button" aria-label="Stop" title="Stop" onClick={onStop} className={cn(ROUND, PRIMARY, 'relative')}>
              <WorkingRing className="inset-[3px]" />
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button type="button" aria-label="Send message" disabled={!canSend} onClick={() => submit()} className={cn(ROUND, canSend ? PRIMARY : IDLE)}>
              <ArrowUp className="size-5" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm" aria-hidden="true">
          <div className="flex items-center gap-2 rounded-full border-2 border-dashed border-ink/30 bg-surface px-5 py-3 text-sm font-semibold text-ink-soft shadow-lift">
            <Upload className="size-4" />
            Drop to attach
          </div>
        </div>
      )}
      <span role="status" className="sr-only">
        {working ? 'Claude is working' : att.busy ? 'Uploading files' : ''}
      </span>
      {!connected && (
        <p className="px-3 pt-1.5 text-[12px] text-muted" aria-live="polite">
          Reconnecting…
        </p>
      )}
    </div>
  );
}

/** The card's round buttons: 40 px (44 px taps on touch screens). */
const ROUND = 'press inline-flex size-10 shrink-0 select-none items-center justify-center rounded-full transition-colors tap:size-11 disabled:pointer-events-none';
/** The kit's button looks (its `size` can't be overridden: its `cn` joins classes, it doesn't merge them). */
const GHOST = 'bg-ink/[0.07] text-ink-soft hover:bg-ink/[0.12] hover:text-ink';
const PRIMARY = 'bg-ink text-bg hover:opacity-90';
/** Send with nothing to send yet. */
const IDLE = 'bg-ink/[0.07] text-muted';
const SPLIT = 'inline-flex h-10 items-center justify-center bg-ink text-[13.5px] font-semibold text-bg transition-opacity hover:opacity-90 tap:h-11';

/**
 * Send while a turn runs: "Steer" (the message reaches Claude at its next step), and a menu that also
 * offers "Send after this turn". The menu opens upward, away from the screen edge.
 */
function SteerButton({
  canSend,
  connected,
  showKeys,
  onSend,
  onStop,
}: {
  canSend: boolean;
  connected: boolean;
  showKeys: boolean;
  onSend: (priority: 'next' | 'later') => void;
  /** Stop the turn without sending: what is written stays in the box. */
  onStop?: () => void;
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
    // With nothing to send the whole pill dims as one (its menu still opens, to say what each way does).
    <div ref={wrap} className={cn('relative flex shrink-0 transition-opacity', !canSend && 'opacity-50')}>
      {/* Phones show the arrow alone (the box says "Steer Claude…"): the word would squeeze the model's name out of the row. */}
      <button
        type="button"
        disabled={!canSend}
        onClick={() => onSend('next')}
        className={cn(SPLIT, 'w-11 gap-1.5 rounded-l-full disabled:pointer-events-none sm:w-auto sm:pr-2.5 sm:pl-3.5')}
      >
        <span className="relative inline-flex size-4 items-center justify-center">
          <WorkingRing className="-inset-1" />
          <ArrowUp className="size-4" aria-hidden="true" />
        </span>
        <span className="max-sm:sr-only">Steer</span>
      </button>
      <button
        ref={trigger}
        type="button"
        disabled={!connected}
        onClick={() => setOpen((v) => !v)}
        aria-label="More ways to send"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(SPLIT, 'w-9 rounded-r-full border-l border-bg/20 disabled:pointer-events-none')}
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
          {onStop && (
            <>
              <div role="separator" className="mx-2 my-1 h-px bg-line" />
              <SendItem
                label="Stop turn"
                hint="Ends this turn. What you wrote stays in the box."
                disabled={false}
                onClick={() => {
                  setOpen(false);
                  onStop();
                }}
              />
            </>
          )}
          {!canSend && <p className="px-3 pt-1 pb-1.5 text-[12px] text-muted">Write a message first.</p>}
        </div>
      )}
    </div>
  );
}

/** A ring that turns while Claude works: the only working indicator (the session header has none). Still, with reduced motion. */
function WorkingRing({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('pointer-events-none absolute rounded-full border-2 border-bg/25 border-t-bg motion-safe:animate-spin', className)} />;
}

function SendItem({ label, hint, keys, disabled, onClick }: { label: string; hint: string; keys?: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left outline-hidden hover:bg-surface-2 focus:bg-surface-2 disabled:opacity-40"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="block text-[12px] text-muted">{hint}</span>
      </span>
      {keys && <kbd className="mt-0.5 shrink-0 rounded-md border border-line px-1.5 py-0.5 font-sans text-[10.5px] font-semibold text-muted">{keys}</kbd>}
    </button>
  );
}
