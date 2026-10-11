import { cn, Spinner } from '@isnanme/ui';
import type { ChatModelOption } from '@portal/contracts';
import { Check } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

const FAMILY = /\b(fable|opus|sonnet|haiku)\b/i;

/** "Opus 5.5" → "5.5"; null when the name carries no version. */
const versionOf = (m: ChatModelOption): string | null => /(\d+(?:\.\d+)?)\s*$/.exec(m.displayName)?.[1] ?? null;

interface Family {
  key: string;
  label: string;
  hint: string | null;
  /** Newest first; each a model this session can switch to. */
  versions: { option: ChatModelOption; version: string | null }[];
}

/**
 * The session's models as families: Default on its own, then one entry per family (Opus, Sonnet, …) in
 * the order Claude Code lists them, each with its versions newest first. Where an alias ("opus") and a
 * pinned id name the same version, the alias stays: it follows the family's newest.
 */
export function groupModels(models: ChatModelOption[]): Family[] {
  const families = new Map<string, Family>();
  for (const m of models) {
    const key = m.value === 'default' ? 'default' : (FAMILY.exec(`${m.value} ${m.resolvedModel ?? ''} ${m.displayName}`)?.[1]?.toLowerCase() ?? m.value);
    let f = families.get(key);
    if (!f) {
      const label = key === 'default' ? 'Default' : key.charAt(0).toUpperCase() + key.slice(1);
      f = { key, label, hint: m.description ?? null, versions: [] };
      families.set(key, f);
    }
    const version = key === 'default' ? null : versionOf(m);
    if (version && f.versions.some((v) => v.version === version)) continue;
    f.versions.push({ option: m, version });
  }
  for (const f of families.values()) f.versions.sort((a, b) => Number(b.version ?? 0) - Number(a.version ?? 0));
  return [...families.values()];
}

/**
 * One row per family, the session's ticked. Picking a family switches to its newest version; the
 * picked family shows its versions as a row of buttons. Each pick applies at once (`onPick`).
 */
export function ModelFamilies({
  models,
  current,
  pending,
  disabled,
  onPick,
}: {
  models: ChatModelOption[];
  current: ChatModelOption | null;
  pending: string | null;
  disabled?: boolean;
  onPick: (value: string) => void;
}) {
  const families = groupModels(models);
  const currentFamily = families.find((f) => f.versions.some((v) => v.option.value === current?.value))?.key ?? null;
  return (
    <div role="radiogroup" aria-label="Model" className="-mx-2 flex flex-col gap-1">
      {families.map((f) => {
        const on = f.key === currentFamily;
        const busy = f.versions.some((v) => v.option.value === pending);
        const blocked = disabled || (pending !== null && !busy);
        const newest = f.versions[0]!.option;
        return (
          <div key={f.key} className={cn('rounded-2xl transition-colors', on ? 'bg-surface-2' : 'hover:bg-surface-2/60')}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={blocked || undefined}
              data-autofocus={on ? '' : undefined}
              onClick={() => !on && !blocked && onPick(newest.value)}
              className={cn(
                'flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ink/40',
                blocked && 'cursor-not-allowed opacity-50',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[16px] font-semibold text-ink">{f.label}</span>
                {f.hint && <span className="mt-0.5 block truncate text-[13px] text-muted">{f.hint}</span>}
              </span>
              <span className="flex size-5 shrink-0 items-center justify-center">
                {busy && !on ? <Spinner className="size-4" /> : on ? <Check className="size-[18px] text-accent" aria-hidden="true" /> : null}
              </span>
            </button>
            <AnimatePresence initial={false}>
              {on && f.versions.length > 1 && (
                <motion.div
                  key="versions"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div role="radiogroup" aria-label={`${f.label} version`} className="flex flex-wrap gap-1.5 px-3 pb-3">
                    {f.versions.map((v) => {
                      const picked = v.option.value === current?.value;
                      const vBusy = v.option.value === pending;
                      return (
                        <button
                          key={v.option.value}
                          type="button"
                          role="radio"
                          aria-checked={picked}
                          aria-label={v.option.displayName}
                          title={v.option.resolvedModel ?? v.option.value}
                          disabled={disabled || (pending !== null && !vBusy)}
                          onClick={() => !picked && onPick(v.option.value)}
                          className={cn(
                            'press inline-flex h-9 min-w-12 items-center justify-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold tabular-nums transition-colors disabled:opacity-50',
                            picked ? 'bg-ink text-bg' : 'bg-ink/[0.07] text-ink-soft hover:bg-ink/[0.12]',
                          )}
                        >
                          {vBusy && <Spinner className="size-3.5" />}
                          {v.version ?? v.option.displayName}
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Effort as a slider over the model's own levels, Low to Max, with each level named under its stop
 * (tap a name to jump there). Dragging only moves it; letting go applies the level.
 */
export function EffortSlider({
  levels,
  value,
  label,
  busy,
  disabled,
  onChange,
}: {
  levels: string[];
  value: string;
  label: (level: string) => string;
  busy?: boolean;
  disabled?: boolean;
  onChange: (level: string) => void;
}) {
  const index = Math.max(0, levels.indexOf(value));
  const [at, setAt] = useState(index);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setAt(index);
  }, [index]);
  const commit = (i: number) => {
    dragging.current = false;
    const level = levels[i];
    if (level && level !== value) onChange(level);
  };
  const max = Math.max(1, levels.length - 1);
  const fill = `${(at / max) * 100}%`;
  return (
    <div className={cn('flex flex-col gap-1', disabled && 'opacity-50')}>
      <div className="flex items-baseline justify-between">
        <span id="effort-label" className="text-[15px] font-semibold text-ink">
          Effort
        </span>
        <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-ink-soft" aria-hidden="true">
          {busy && <Spinner className="size-3.5" />}
          {label(levels[at] ?? value)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={at}
        disabled={disabled}
        aria-labelledby="effort-label"
        aria-valuetext={label(levels[at] ?? value)}
        onChange={(e) => {
          dragging.current = true;
          setAt(Number(e.target.value));
        }}
        onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e: KeyboardEvent<HTMLInputElement>) => commit(Number(e.currentTarget.value))}
        onBlur={(e) => dragging.current && commit(Number(e.target.value))}
        style={{ '--fill': fill } as React.CSSProperties}
        className="range"
      />
      <div className="flex justify-between">
        {levels.map((level, i) => (
          <button
            key={level}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onClick={() => {
              setAt(i);
              commit(i);
            }}
            className={cn('px-0.5 text-[12px] transition-colors', i === at ? 'font-semibold text-ink' : 'text-muted hover:text-ink-soft')}
          >
            {label(level)}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[13px] text-muted">How hard Claude thinks. More is slower and uses more tokens.</p>
    </div>
  );
}
