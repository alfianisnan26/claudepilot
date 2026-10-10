import { cn } from '@isnanme/ui';
import { CODE_LENGTH, normalizeCode } from '@portal/contracts';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';

const HALF = CODE_LENGTH / 2;

/**
 * The server code as one box per character, `XXXX-XXXX` with a fixed dash. One real input sits
 * on top (invisible), so typing, paste ("abcd-efgh" works), autofill and screen readers just work;
 * the boxes only draw it. `onComplete` fires when the last character goes in.
 */
export const ServerCodeInput = forwardRef<
  { focus: () => void },
  {
    value: string;
    onChange: (v: string) => void;
    onComplete?: (v: string) => void;
    error?: boolean;
    disabled?: boolean;
    autoFocus?: boolean;
    describedBy?: string;
  }
>(function ServerCodeInput({ value, onChange, onComplete, error, disabled, autoFocus, describedBy }, ref) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  const chars = value.padEnd(CODE_LENGTH, ' ').slice(0, CODE_LENGTH).split('');
  const active = Math.min(value.length, CODE_LENGTH - 1);

  const box = (i: number) => (
    <span
      key={i}
      className={cn(
        'relative flex aspect-[4/5] items-center justify-center rounded-xl border-2 bg-surface font-mono text-[22px] font-bold uppercase transition-colors sm:rounded-2xl sm:text-[28px]',
        error ? 'border-danger/70' : focused && i === active ? 'border-ink' : chars[i]!.trim() ? 'border-muted/50' : 'border-line',
        disabled && 'opacity-50',
      )}
    >
      {chars[i]!.trim()}
      {/* The caret, in the box that takes the next character. */}
      {focused && !disabled && i === active && !chars[i]!.trim() && (
        <span className="absolute h-[1.1em] w-0.5 animate-pulse rounded-full bg-ink" />
      )}
    </span>
  );

  return (
    <div className="relative w-full" onClick={() => input.current?.focus()}>
      <input
        ref={input}
        aria-label="Server code"
        aria-invalid={error || undefined}
        aria-describedby={describedBy}
        inputMode="text"
        autoComplete="one-time-code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        autoFocus={autoFocus}
        disabled={disabled}
        value={value}
        onFocus={(e) => {
          setFocused(true);
          // Keep the caret at the end: the boxes always fill left to right.
          const end = e.target.value.length;
          e.target.setSelectionRange(end, end);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const v = normalizeCode(e.target.value)
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, CODE_LENGTH);
          onChange(v);
          if (v.length === CODE_LENGTH && v !== value) onComplete?.(v);
        }}
        className="absolute inset-0 z-10 h-full w-full cursor-text opacity-0 disabled:cursor-not-allowed"
      />
      <div aria-hidden="true" className="flex items-center gap-1.5 sm:gap-2">
        <div className="grid flex-1 gap-1.5 sm:gap-2" style={{ gridTemplateColumns: `repeat(${HALF}, minmax(0, 1fr))` }}>
          {chars.slice(0, HALF).map((_, i) => box(i))}
        </div>
        <span className="w-3 shrink-0 text-center text-2xl font-bold text-muted sm:w-4">-</span>
        <div className="grid flex-1 gap-1.5 sm:gap-2" style={{ gridTemplateColumns: `repeat(${HALF}, minmax(0, 1fr))` }}>
          {chars.slice(HALF).map((_, i) => box(HALF + i))}
        </div>
      </div>
    </div>
  );
});
