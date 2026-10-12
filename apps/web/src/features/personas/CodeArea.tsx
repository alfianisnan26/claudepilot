import { cn } from '@isnanme/ui';
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { PERSONA_LIMITS, approxTokens } from '@portal/contracts';
import { lineCount } from './labels';
import { LabelRow, MONO } from './parts';

/**
 * A text area for text Claude reads (instructions, prompts, style bodies): a code font, growing with its
 * text, and a counter. The note about it sits behind an ⓘ.
 */
export function CodeArea({
  label,
  tip,
  value,
  onChange,
  error,
  disabled,
  rows = 8,
  counter = 'lines',
  maxHeight = 0.7,
  placeholder,
}: {
  label: string;
  tip?: ReactNode;
  value: string;
  onChange: (next: string) => void;
  error?: string;
  disabled?: boolean;
  rows?: number;
  /** `lines`: "48 lines · ~600 tokens", amber past Claude Code's guidance of 200 lines per file (FR2). Off for short fields. */
  counter?: 'lines' | 'none';
  /** The tallest it grows, as a share of the window. */
  maxHeight?: number;
  placeholder?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, Math.round(window.innerHeight * maxHeight))}px`;
  }, [value, maxHeight]);
  const lines = lineCount(value);
  const long = lines > PERSONA_LIMITS.instructionLinesWarn;
  return (
    <div className="flex flex-col gap-1">
      <LabelRow
        label={label}
        htmlFor={id}
        tip={tip}
        right={
          counter === 'lines' && value ? (
            <span className={cn('text-[12px]', long ? 'font-semibold text-amber-700 dark:text-amber-400' : 'text-muted')} title={long ? `Claude Code advises up to ${PERSONA_LIMITS.instructionLinesWarn} lines per file.` : undefined}>
              {lines} lines · ~{approxTokens(value).toLocaleString('en-US')} tokens
            </span>
          ) : undefined
        }
      />
      <textarea
        ref={ref}
        id={id}
        value={value}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="none"
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        style={{ fontFamily: MONO }}
        className={cn(
          'w-full resize-y rounded-xl border bg-surface px-3.5 py-2.5 text-base leading-relaxed text-ink outline-none transition-[border-color,box-shadow] placeholder:text-muted/70 sm:text-[13.5px]',
          'focus:border-ink/40 focus:ring-4 focus:ring-[var(--ring)] disabled:opacity-60',
          error ? 'border-danger/70' : 'border-line hover:border-line-strong',
        )}
      />
      {error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
