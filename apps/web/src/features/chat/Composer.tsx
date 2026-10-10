import { Button, useMediaQuery } from '@isnanme/ui';
import { ArrowUp } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * The message box. A textarea that grows with its content and a Send button. On a mouse-and-keyboard
 * screen Enter sends and Shift+Enter makes a newline; on a touch screen Enter makes a newline (so the
 * on-screen keyboard's return key doesn't fire off half-written messages) and Send is the way to send.
 * Cmd/Ctrl+Enter always sends. While a turn is running, sending steers it (priority `next`).
 */
export function Composer({
  onSend,
  connected,
  working,
}: {
  onSend: (text: string, opts?: { priority?: 'next' | 'later' }) => void;
  connected: boolean;
  working: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const touch = useMediaQuery('(hover: none) and (pointer: coarse)');

  // Grow to fit the text, up to a cap, then scroll inside.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const canSend = connected && text.trim().length > 0;

  const submit = () => {
    const value = text.trim();
    if (!value || !connected) return;
    onSend(value, working ? { priority: 'next' } : undefined);
    setText('');
    // Keep the caret in the box so a desktop user can keep typing.
    if (!touch) requestAnimationFrame(() => ref.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      submit();
    } else if (!touch && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Message"
          placeholder={working ? 'Steer the current turn…' : 'Message Claude…'}
          className="max-h-[200px] min-h-[2.75rem] flex-1 resize-none rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-base text-ink outline-none transition-[border-color,box-shadow] placeholder:text-muted/70 hover:border-line-strong focus:border-ink/40 focus:ring-4 focus:ring-[var(--ring)]"
        />
        <Button size="icon" aria-label="Send message" disabled={!canSend} onClick={submit} className="mb-0.5">
          <ArrowUp className="size-[18px]" />
        </Button>
      </div>
      {!connected && (
        <p className="px-1 text-[12px] text-muted" aria-live="polite">
          Reconnecting…
        </p>
      )}
    </div>
  );
}
