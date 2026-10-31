import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { composerHeight, composerKey, keyboardInset } from './chatModel';
import { Icon } from './icons';

/**
 * The panel's one composer (ticket replies and the chat): a single line that grows to five, the send button inside the field, Enter sends
 * and Shift+Enter breaks the line on desktop (touch: the button sends), pinned to the bottom and lifted over the phone keyboard.
 */
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  label,
  busy = false,
  disabled = false,
  coarse,
  maxLength = 4000,
  autoFocus = false,
  extra,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  coarse: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  /** A control left of the field (attach the current shot). */
  extra?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const can = !disabled && !busy && value.trim().length > 0;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${composerHeight(el.scrollHeight)}px`;
  }, [value]);
  const inset = useKeyboardInset();
  return (
    <div className="shrink-0 border-t border-line bg-bg px-2 pt-2" style={{ paddingBottom: `max(0.5rem, env(safe-area-inset-bottom), ${inset}px)` }}>
      <div className="flex items-end gap-1">
        {extra}
        <div className={`relative flex min-w-0 flex-1 items-end rounded-[22px] border bg-surface ${disabled ? 'border-line' : 'border-line-strong focus-within:border-accent'}`}>
          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            autoFocus={autoFocus}
            maxLength={maxLength}
            aria-label={label}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              const act = composerKey(e.nativeEvent, coarse);
              if (act === 'send') {
                e.preventDefault();
                if (can) onSend();
              }
            }}
            className="block max-h-[124px] min-h-11 w-full resize-none overflow-y-auto bg-transparent py-3 pr-12 pl-4 text-[15px] leading-5 text-ink placeholder:text-muted focus:outline-hidden disabled:opacity-60"
          />
          <button
            type="button"
            aria-label="Send"
            title="Send"
            disabled={!can}
            onClick={onSend}
            className={`absolute right-0 bottom-0 inline-flex size-11 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden ${can ? 'text-accent' : 'text-muted opacity-50'}`}
          >
            <span className={`inline-flex size-8 items-center justify-center rounded-full ${can ? 'bg-primary text-primary-ink' : 'bg-surface-2'}`}>
              {busy ? <span aria-live="polite" className="text-[12px]">…</span> : <Icon name="arrowUp" className="size-[18px]" />}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** The phone keyboard's height over the layout viewport (iOS shrinks only the visual viewport), 0 elsewhere. */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const update = () => setInset(keyboardInset(window.innerHeight, vv));
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}
