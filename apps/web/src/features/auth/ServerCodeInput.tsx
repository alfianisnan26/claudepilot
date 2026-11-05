import { cn } from '@isnanme/ui';
import { CODE_LENGTH } from '@portal/contracts';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { cleanCode, sendsItself } from './codeField';

const HALF = CODE_LENGTH / 2;

/**
 * The server code as one box per character, `XXXX-XXXX` with a fixed dash. One real input sits
 * on top (invisible), so typing, paste ("abcd-efgh" works), autofill and screen readers just work;
 * the boxes only draw it. `onComplete` fires when the last character goes in.
 *
 * PILOT-1185 slice 2: a long code (`long`, from the session answer, or a paste of more than 8) is one plain text field instead, up to
 * LONG_CODE_MAX characters; it never sends itself (a long code typed by hand would go at its 8th character), Enter calls `onComplete`.
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
    long?: boolean;
  }
>(function ServerCodeInput({ value, onChange, onComplete, error, disabled, autoFocus, describedBy, long: longCode = false }, ref) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  /** A long code pasted into the boxes: the field stays long from then on. */
  const [pastedLong, setPastedLong] = useState(false);
  const long = longCode || pastedLong;
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  const change = (raw: string) => {
    const next = cleanCode(raw, long);
    if (next.long && !long) {
      setPastedLong(true);
      requestAnimationFrame(() => input.current?.focus());
    }
    onChange(next.value);
    if (sendsItself(next.value, value, next.long)) onComplete?.(next.value);
  };

  const common = {
    ref: input,
    'aria-label': 'Server code',
    'aria-invalid': error || undefined,
    'aria-describedby': describedBy,
    inputMode: 'text' as const,
    autoCapitalize: 'characters',
    autoCorrect: 'off',
    spellCheck: false,
    enterKeyHint: 'go' as const,
    autoFocus,
    disabled,
    value,
  };

  if (long)
    return (
      <input
        {...common}
        autoComplete="off"
        placeholder="Paste or type the code"
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          // One send: the field's form (the sign-in page) would send it again.
          e.preventDefault();
          onComplete?.(value);
        }}
        className={cn(
          'min-h-14 w-full min-w-0 rounded-xl border-2 bg-surface px-3 font-mono text-[17px] font-semibold uppercase tracking-[0.04em] outline-none transition-colors placeholder:font-sans placeholder:font-normal placeholder:normal-case placeholder:tracking-normal placeholder:text-muted sm:rounded-2xl sm:text-[19px]',
          error ? 'border-danger/70' : 'border-line focus:border-ink',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      />
    );

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
        {...common}
        autoComplete="one-time-code"
        onFocus={(e) => {
          setFocused(true);
          // Keep the caret at the end: the boxes always fill left to right.
          const end = e.target.value.length;
          e.target.setSelectionRange(end, end);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => change(e.target.value)}
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
