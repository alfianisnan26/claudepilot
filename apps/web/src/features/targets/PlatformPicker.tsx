import { chipClass } from '@isnanme/ui';
import type { ConnectPlatform } from '@portal/contracts';
import { useRef } from 'react';
import type { platformChoices } from './wizard';

/**
 * Linux / macOS / Windows as one choice. A system the matrix doesn't offer yet is disabled (its note is the button's title and sits in
 * the InfoTip beside the control); a Preview one says so in its label. Arrow keys move between the ones that can be chosen.
 */
export function PlatformPicker({
  value,
  choices,
  onChange,
  labelledBy,
  invalid,
}: {
  value: ConnectPlatform;
  choices: ReturnType<typeof platformChoices>;
  onChange: (p: ConnectPlatform) => void;
  labelledBy: string;
  invalid?: boolean;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (dir: 1 | -1) => {
    const enabled = choices.filter((c) => !c.disabled);
    const i = enabled.findIndex((c) => c.value === value);
    const next = enabled[(i + dir + enabled.length) % enabled.length];
    if (next) {
      onChange(next.value);
      group.current?.querySelector<HTMLButtonElement>(`[data-p="${next.value}"]`)?.focus();
    }
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-invalid={invalid || undefined}
      className="flex flex-wrap gap-2"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') (e.preventDefault(), move(1));
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') (e.preventDefault(), move(-1));
      }}
    >
      {choices.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          data-p={c.value}
          aria-checked={value === c.value}
          disabled={c.disabled}
          tabIndex={value === c.value ? 0 : -1}
          title={c.note}
          onClick={() => onChange(c.value)}
          className={`${chipClass(value === c.value)} min-h-11 disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
