import { cn, Spinner } from '@isnanme/ui';
import type { ChatModelOption } from '@portal/contracts';
import { Check } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { cap, familyOf, parseModelId as parseId } from './modelName';

/** What the server accepts as a model value. */
const MODEL_VALUE = /^[\x21-\x7e]{1,200}$/;

/** "Opus 5.5" → "5.5"; null when the name carries no version. */
const versionOf = (m: ChatModelOption): string | null => /(\d+(?:\.\d+)?)\s*$/.exec(m.displayName)?.[1] ?? null;

/**
 * Older versions to offer beside what Claude Code lists (it lists each family's newest). A pick goes
 * through `set_model`, which Claude Code validates: when it can't use one it says so and the session
 * stays as it was. Any other id goes in through the "…" field.
 */
const MORE_VERSIONS: Record<string, string[]> = { opus: ['5', '4.6', '4.5'], sonnet: ['5', '4.6', '4.5'], haiku: ['5', '4.5'] };
const idFor = (family: string, version: string) => `claude-${family}-${version.replace('.', '-')}`;

interface Family {
  key: string;
  label: string;
  hint: string | null;
  /** Oldest first, newest last; each a model this session can switch to. */
  versions: { option: ChatModelOption; version: string | null }[];
}

/**
 * The session's models as families: Default on its own, then one entry per family (Opus, Sonnet, …) in
 * the order Claude Code lists them, each with its versions oldest first, the older ones the portal
 * offers added. Where an alias ("opus") and a pinned id name the same version, the alias stays: it
 * follows the family's newest.
 */
export function groupModels(models: ChatModelOption[]): Family[] {
  const families = new Map<string, Family>();
  for (const m of models) {
    const key = m.value === 'default' ? 'default' : (familyOf(`${m.value} ${m.resolvedModel ?? ''} ${m.displayName}`) ?? m.value);
    let f = families.get(key);
    if (!f) {
      f = { key, label: key === 'default' ? 'Default' : cap(key), hint: m.description ?? null, versions: [] };
      families.set(key, f);
    }
    const version = key === 'default' ? null : versionOf(m);
    if (version && f.versions.some((v) => v.version === version)) continue;
    f.versions.push({ option: m, version });
  }
  for (const f of families.values()) {
    for (const version of f.key === 'default' ? [] : (MORE_VERSIONS[f.key] ?? [])) {
      if (f.versions.some((v) => v.version === version)) continue;
      const value = idFor(f.key, version);
      f.versions.push({ option: { value, displayName: `${f.label} ${version}`, description: null, resolvedModel: value, effortLevels: [] }, version });
    }
    f.versions.sort((a, b) => Number(a.version ?? 0) - Number(b.version ?? 0));
  }
  return [...families.values()];
}

const CHIP = 'press inline-flex h-9 min-w-12 items-center justify-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold tabular-nums transition-colors disabled:opacity-50';

/**
 * One row per family, the session's ticked; its description is the row's tooltip. Picking a family
 * switches to its newest version; the picked family shows its versions as a row of buttons, then "…"
 * for any other model id. Each pick applies at once (`onPick`). `applied` is the model in effect, so
 * a version the list doesn't carry still shows as picked.
 */
export function ModelFamilies({
  models,
  current,
  applied = null,
  pending,
  disabled,
  onPick,
}: {
  models: ChatModelOption[];
  current: ChatModelOption | null;
  applied?: string | null;
  pending: string | null;
  disabled?: boolean;
  onPick: (value: string) => void;
}) {
  const [more, setMore] = useState(false);
  const [custom, setCustom] = useState('');
  const families = groupModels(models);
  const inUse = parseId(applied) ?? parseId(current?.resolvedModel);
  const currentFamily =
    families.find((f) => f.versions.some((v) => v.option.value === current?.value))?.key ?? (inUse && families.some((f) => f.key === inUse.family) ? inUse.family : null);
  const currentVersion = inUse?.version ?? (current ? versionOf(current) : null);
  const customValue = custom.trim();
  return (
    <div role="radiogroup" aria-label="Model" className="-mx-2 flex flex-col gap-1">
      {families.map((f) => {
        const on = f.key === currentFamily;
        const busy = f.versions.some((v) => v.option.value === pending);
        const blocked = disabled || (pending !== null && !busy);
        const newest = f.versions.at(-1)!.option;
        // Default says what it is right now ("Opus 5.5"), the other families keep their description in the tooltip.
        const now = f.key === 'default' ? parseId(newest.resolvedModel) : null;
        return (
          <div key={f.key} className={cn('rounded-2xl transition-colors', on ? 'bg-surface-2' : 'hover:bg-surface-2/60')}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={blocked || undefined}
              data-autofocus={on ? '' : undefined}
              title={f.hint ?? undefined}
              onClick={() => !on && !blocked && onPick(newest.value)}
              className={cn(
                'flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ink/40',
                blocked && 'cursor-not-allowed opacity-50',
              )}
            >
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="text-[16px] font-semibold text-ink">{f.label}</span>
                {now && <span className="truncate text-[13px] text-muted">{`${cap(now.family)} ${now.version}`}</span>}
              </span>
              <span className="flex size-5 shrink-0 items-center justify-center">
                {busy && !on ? <Spinner className="size-4" /> : on ? <Check className="size-[18px] text-accent" aria-hidden="true" /> : null}
              </span>
            </button>
            <AnimatePresence initial={false}>
              {on && f.key !== 'default' && (
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
                      const picked = v.version !== null && v.version === currentVersion;
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
                          className={cn(CHIP, picked ? 'bg-ink text-bg' : 'bg-ink/[0.07] text-ink-soft hover:bg-ink/[0.12]')}
                        >
                          {vBusy && <Spinner className="size-3.5" />}
                          {v.version ?? v.option.displayName}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      aria-label="Other model"
                      title="Other model"
                      aria-expanded={more}
                      disabled={disabled}
                      onClick={() => setMore((m) => !m)}
                      className={cn(CHIP, 'min-w-9 px-3', more ? 'bg-ink/[0.14] text-ink' : 'bg-ink/[0.07] text-ink-soft hover:bg-ink/[0.12]')}
                    >
                      …
                    </button>
                  </div>
                  {more && (
                    <form
                      className="flex gap-1.5 px-3 pb-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!MODEL_VALUE.test(customValue) || blocked) return;
                        onPick(customValue);
                        setCustom('');
                        setMore(false);
                      }}
                    >
                      <input
                        value={custom}
                        onChange={(e) => setCustom(e.target.value)}
                        aria-label="Model id"
                        placeholder="model id"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        className="h-9 min-w-0 flex-1 rounded-full bg-ink/[0.07] px-3.5 font-mono text-[13px] text-ink outline-hidden placeholder:font-sans placeholder:text-muted focus-visible:ring-2 focus-visible:ring-ink/40"
                      />
                      <button type="submit" disabled={!MODEL_VALUE.test(customValue) || blocked} className={cn(CHIP, 'bg-ink text-bg')}>
                        Use
                      </button>
                    </form>
                  )}
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
        <span className="inline-flex items-center gap-1">
          <span id="effort-label" className="text-[15px] font-semibold text-ink">
            Effort
          </span>
          <InfoTip label="About effort">How hard Claude thinks. More is slower and uses more tokens.</InfoTip>
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
    </div>
  );
}
