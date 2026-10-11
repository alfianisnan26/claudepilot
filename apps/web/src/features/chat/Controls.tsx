import { Button, cn, Dialog, Spinner, SwitchRow } from '@isnanme/ui';
import type { ChatModelOption, ChatPermissionMode, ChatSession } from '@portal/contracts';
import {
  Check,
  ChevronDown,
  FilePen,
  Hand,
  ListChecks,
  ShieldAlert,
  ShieldOff,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { errorText } from '@/lib/api';
import { chatApi } from './api';
import { formatTokens } from './shared';
import type { ChatControlArgs, ChatControlOp } from './useChatSocket';

type Control = (op: ChatControlOp, args?: ChatControlArgs) => Promise<void>;
type Picker = 'model' | 'mode';

/** Opens the mode picker from elsewhere: on phones, Mode lives in the session's ⋯ menu. */
export interface ControlsHandle {
  openMode: () => void;
}

/** Every mode a session can report, so the chip always reads right; only `OFFERED_MODES` can be picked here. */
const MODES: Record<ChatPermissionMode, { label: string; hint: string; icon: LucideIcon; danger?: boolean }> = {
  default: { label: 'Ask', hint: 'Asks before edits and commands.', icon: Hand },
  acceptEdits: { label: 'Auto-accept edits', hint: 'Edits files without asking; asks before commands.', icon: FilePen },
  plan: { label: 'Plan', hint: 'Reads and plans; changes nothing until you approve.', icon: ListChecks },
  dontAsk: { label: 'Don’t ask', hint: 'Runs only pre-approved actions and denies the rest.', icon: ShieldOff },
  bypassPermissions: { label: 'Bypass', hint: 'Runs everything without asking.', icon: ShieldAlert, danger: true },
};
/** A mode's name and icon, for the ⋯ menu's Mode item. */
export const modeDetails = (mode: ChatPermissionMode) => MODES[mode] ?? MODES.default;

/** Bypass needs its own opt-in and confirmation, so it's never offered here. */
const OFFERED_MODES: ChatPermissionMode[] = ['default', 'acceptEdits', 'plan'];

/** Effort levels when the model's own list isn't known (yet). */
const EFFORT_FALLBACK = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const effortLabel = (e: string) => EFFORT_LABEL[e] ?? e.charAt(0).toUpperCase() + e.slice(1);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i;
const LEGACY_MODEL_ID = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/i;

/** "claude-opus-4-5-20251101" reads "Opus 4.5" until the session's model list names it; other ids stay as they are. */
function prettyModel(id: string): string {
  const m = MODEL_ID.exec(id);
  if (m) return `${cap(m[1]!)} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M)' : ''}`;
  const l = LEGACY_MODEL_ID.exec(id);
  if (l) return `${cap(l[3]!)} ${l[1]}${l[2] ? `.${l[2]}` : ''}`;
  return /^(default|opus|sonnet|haiku|fable)$/i.test(id) ? cap(id) : id;
}

/**
 * The option matching the model in effect: its own value first, then the one picked here if it
 * resolves to it, then any that resolves to it (an alias over `default`, which names nothing).
 */
function matchModel(models: ChatModelOption[] | null, applied: string | null, picked: string | null): ChatModelOption | null {
  if (!models || !applied) return null;
  return (
    models.find((m) => m.value === applied) ??
    models.find((m) => m.value === picked && m.resolvedModel === applied) ??
    models.find((m) => m.resolvedModel === applied && m.value !== 'default') ??
    models.find((m) => m.resolvedModel === applied) ??
    null
  );
}

/**
 * The session's controls, one quiet line above the composer: "Opus 5.5 · Medium" (with ⚡ while
 * Ultracode is on) opens one Model and effort sheet (chat PRD §12.4); the permission mode follows from
 * 640 px (on phones it's in the ⋯ menu, and shows here only when it isn't Ask); how full the context
 * window is sits at the end. Pickers send the change and wait for its ack, showing the error in place,
 * and the line always shows what the session reports as applied, never what was asked for.
 */
export function Controls({
  sessionId,
  session,
  connected,
  control,
  suspended,
  className,
  ref,
}: {
  sessionId: string;
  session: ChatSession;
  connected: boolean;
  control: Control;
  /** Another prompt has the screen (the folder needs trust before a change can apply): pickers stay closed. */
  suspended?: boolean;
  className?: string;
  ref?: Ref<ControlsHandle>;
}) {
  const [open, setOpen] = useState<Picker | null>(null);
  if (suspended && open !== null) setOpen(null);
  useImperativeHandle(ref, () => ({ openMode: () => setOpen('mode') }), []);
  const [models, setModels] = useState<ChatModelOption[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setOpen(null);
    setModels(null);
    setModelsError(null);
    setPicked(null);
  }, [sessionId]);

  // The model list (with each model's effort levels) is fetched each time the sheet opens; what was
  // loaded stays on screen while it refreshes.
  const needModels = open === 'model';
  useEffect(() => {
    if (!needModels) return;
    let current = true;
    setModelsError(null);
    chatApi.models(sessionId).then(
      (list) => current && setModels(list),
      (e: unknown) => current && setModelsError(errorText(e, 'Could not load the models.')),
    );
    return () => {
      current = false;
    };
  }, [needModels, sessionId, reload]);

  const current = matchModel(models, session.model, picked);
  // The model in effect, by name: steady whether or not the list has loaded (an alias such as
  // "Default (recommended)" names a choice, not the model running).
  const modelName = session.model ? prettyModel(session.model) : current?.displayName || 'Model';
  const mode = MODES[session.mode] ?? MODES.default;
  const ModeIcon = mode.icon;
  const effort = session.effort !== null ? effortLabel(session.effort) : null;
  const close = () => setOpen(null);
  // A change that lands after its picker was closed (or another opened) leaves the screen alone.
  const done = (picker: Picker) => setOpen((o) => (o === picker ? null : o));

  return (
    <>
      <div role="group" aria-label="Session settings" className={cn('flex min-w-0 items-center gap-0.5', className)}>
        <Quiet
          onClick={() => setOpen('model')}
          ariaLabel={`Model and effort: ${modelName}${effort ? `, ${effort}` : ''}${session.ultracode ? ', Ultracode on' : ''}`}
          title={session.model ?? undefined}
        >
          <span className="truncate">{modelName}</span>
          {effort && <span className="shrink-0 text-muted">· {effort}</span>}
          {session.ultracode && <Zap className="size-3 shrink-0 text-gold" aria-hidden="true" />}
        </Quiet>
        <Quiet
          onClick={() => setOpen('mode')}
          ariaLabel={`Permission mode: ${mode.label}`}
          tone={mode.danger ? 'danger' : session.mode !== 'default' ? 'gold' : undefined}
          hideOnPhone={session.mode === 'default'}
          className="shrink-0"
        >
          <ModeIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{mode.label}</span>
        </Quiet>
        <span className="min-w-1 flex-1" />
        {session.context && <ContextMeter context={session.context} />}
      </div>

      <Dialog open={open === 'model'} onClose={close} size="sm" title="Model and effort" description="Applies from Claude’s next request.">
        <ModelEffortSheet
          session={session}
          models={models}
          error={modelsError}
          onRetry={() => setReload((n) => n + 1)}
          current={current}
          levels={current?.effortLevels.length ? current.effortLevels : EFFORT_FALLBACK}
          connected={connected}
          onModel={async (value) => {
            setPicked(value);
            await control('model', { model: value });
          }}
          onEffort={(value) => control('effort', { effort: value })}
          onUltracode={(ultracode) => control('ultracode', { ultracode })}
        />
      </Dialog>

      <Dialog open={open === 'mode'} onClose={close} size="sm" title="Permission mode" description="What Claude may do without asking you.">
        <ModePicker
          mode={session.mode}
          connected={connected}
          onPick={async (next) => {
            await control('mode', { mode: next });
            done('mode');
          }}
        />
      </Dialog>
    </>
  );
}

/** One of the line's controls: text with a small chevron, no frame; the tone marks a mode worth noticing. */
function Quiet({
  onClick,
  ariaLabel,
  title,
  tone,
  hideOnPhone,
  className,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  title?: string;
  tone?: 'gold' | 'danger';
  /** Below 640 px it's in the ⋯ menu instead. (One display class: the kit's `cn` doesn't merge conflicting ones.) */
  hideOnPhone?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label={ariaLabel}
      title={title}
      className={cn(
        'press h-7 min-w-0 items-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold whitespace-nowrap transition-colors tap:h-8',
        hideOnPhone ? 'hidden sm:inline-flex' : 'inline-flex',
        tone === 'danger'
          ? 'text-danger hover:bg-danger-soft'
          : tone === 'gold'
            ? 'text-gold hover:bg-gold-soft'
            : 'text-ink-soft hover:bg-surface-2 hover:text-ink',
        className,
      )}
    >
      {children}
      <ChevronDown className="size-3 shrink-0 opacity-50" aria-hidden="true" />
    </button>
  );
}

/** The meter's ring: radius in a 14-unit box, and its length. */
const RING_R = 5.25;
const RING_LENGTH = 2 * Math.PI * RING_R;

/**
 * How full the context window was after the last turn (Claude Code's own usage report): a ring and a
 * percentage, gold from 80 % and red from 95 %. The token counts show on hover, keyboard focus or tap.
 */
function ContextMeter({ context }: { context: NonNullable<ChatSession['context']> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const { usedTokens: used, windowTokens: size } = context;
  const pct = size ? Math.min(100, Math.round((used / size) * 100)) : null;
  const tone = pct === null ? null : pct >= 95 ? 'danger' : pct >= 80 ? 'gold' : null;

  // Opened by a tap: closes on a tap elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        aria-label={pct === null ? `Context: ${formatTokens(used)} tokens` : `Context ${pct}% full`}
        aria-describedby={tipId}
        className={cn(
          'peer press inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-semibold whitespace-nowrap tabular-nums transition-colors tap:h-8',
          tone === 'danger' ? 'text-danger hover:bg-danger-soft' : tone === 'gold' ? 'text-gold hover:bg-gold-soft' : 'text-muted hover:bg-surface-2 hover:text-ink',
        )}
      >
        {pct !== null && (
          <svg viewBox="0 0 14 14" className="size-3.5 shrink-0 -rotate-90" aria-hidden="true">
            <circle cx="7" cy="7" r={RING_R} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
            <circle
              cx="7"
              cy="7"
              r={RING_R}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={RING_LENGTH}
              strokeDashoffset={RING_LENGTH * (1 - pct / 100)}
            />
          </svg>
        )}
        <span>
          <span className="hidden sm:inline">Context </span>
          {pct === null ? formatTokens(used) : `${pct}%`}
        </span>
      </button>
      <span
        id={tipId}
        role="tooltip"
        className={cn(
          'pointer-events-none absolute right-0 bottom-full z-20 mb-2 rounded-xl bg-primary px-3 py-2 text-[12px] font-medium whitespace-nowrap text-primary-ink tabular-nums opacity-0 shadow-lift transition-opacity peer-hover:opacity-100 peer-focus-visible:opacity-100',
          open && 'opacity-100',
        )}
      >
        {size ? `${used.toLocaleString()} of ${size.toLocaleString()} tokens` : `${used.toLocaleString()} tokens used`}
      </span>
    </div>
  );
}

/**
 * Runs one change at a time: the row it came from spins, a failure (the ack's error) shows under
 * the list, and nothing else can be picked meanwhile.
 */
function useApply() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, apply: () => Promise<void>) => {
    if (pending !== null) return;
    setPending(key);
    setError(null);
    try {
      await apply();
    } catch (e) {
      setError(errorText(e, 'That didn’t go through.'));
    } finally {
      setPending(null);
    }
  };
  return { pending, error, run };
}

/**
 * Model and effort in one sheet (chat PRD §12.4): the session's models, then effort as chips (the
 * model's own levels), then Ultracode where the model has it. Each pick applies at once and the sheet
 * stays open, so a model and its effort can be set together; one change runs at a time.
 */
function ModelEffortSheet({
  session,
  models,
  error,
  onRetry,
  current,
  levels,
  connected,
  onModel,
  onEffort,
  onUltracode,
}: {
  session: ChatSession;
  models: ChatModelOption[] | null;
  error: string | null;
  onRetry: () => void;
  current: ChatModelOption | null;
  levels: string[];
  connected: boolean;
  onModel: (value: string) => Promise<void>;
  onEffort: (value: string) => Promise<void>;
  onUltracode: (on: boolean) => Promise<void>;
}) {
  const apply = useApply();
  const ultracodeBusy = apply.pending === 'ultracode';
  const effortBusy = apply.pending?.startsWith('effort:') ?? false;
  // Resolves true once Claude Code applied it, so the slider can let go of the level it shows.
  const pickEffort = async (level: string) => {
    let ok = false;
    await apply.run(`effort:${level}`, async () => {
      await onEffort(level);
      ok = true;
    });
    return ok;
  };
  return (
    <div className="flex flex-col gap-4">
      {!models ? (
        error ? (
          <div className="flex flex-col items-start gap-3">
            <ErrorNote>{error}</ErrorNote>
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="flex items-center gap-2 py-2 text-[13px] text-muted" aria-busy="true">
            <Spinner className="size-4" /> Loading models…
          </p>
        )
      ) : (
        <div className="flex flex-col gap-2">
          {session.model && !current && (
            <p className="text-[13px] text-muted">
              In use: <span className="font-mono text-ink-soft">{session.model}</span>
            </p>
          )}
          {models.length === 0 ? (
            <p className="text-[13px] text-muted">This session has no other models to switch to.</p>
          ) : (
            <OptionList
              label="Model"
              dense
              current={current?.value ?? null}
              pending={apply.pending}
              disabled={!connected}
              onPick={(value) => void apply.run(value, () => onModel(value))}
              options={models.map((m) => ({
                value: m.value,
                label: m.displayName || m.value,
                hint: m.description || (m.resolvedModel && m.resolvedModel !== m.displayName ? m.resolvedModel : undefined),
              }))}
            />
          )}
        </div>
      )}
      {session.effort !== null && levels.length > 1 && (
        <div className="border-t border-line pt-3">
          <EffortSlider
            levels={levels}
            value={session.effort}
            busy={effortBusy}
            disabled={!connected || (apply.pending !== null && !effortBusy)}
            onPick={pickEffort}
          />
        </div>
      )}
      {(session.ultracodeAvailable || session.ultracode) && (
        <div className="border-t border-line pt-1">
          <SwitchRow
            label="Ultracode"
            description={
              ultracodeBusy ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner className="size-3" /> Applying…
                </span>
              ) : (
                'Plans multi-agent workflows for big tasks. Uses many more tokens.'
              )
            }
            icon={<Zap className="size-4" />}
            checked={session.ultracode}
            disabled={!connected || apply.pending !== null}
            onChange={(on) => void apply.run('ultracode', () => onUltracode(on))}
          />
        </div>
      )}
      <Footnotes error={apply.error} connected={connected} />
    </div>
  );
}

/** The slider's thumb, in px: tick labels sit under where its center can stop. */
const THUMB = 20;

/**
 * Effort as a slider over the model's own levels (chat PRD §12.4): one step per level, the level's name
 * above the track and every level's name under its stop (a tap picks it). A drag applies once, on
 * release; arrow keys apply after a short pause, so one change sends one request. The shown level stays
 * on the pick until Claude Code reports it applied, or the change failed.
 */
function EffortSlider({
  levels,
  value,
  busy,
  disabled,
  onPick,
}: {
  levels: string[];
  value: string;
  busy: boolean;
  disabled: boolean;
  onPick: (level: string) => Promise<boolean>;
}) {
  const labelId = useId();
  const applied = Math.max(0, levels.indexOf(value));
  const [draft, setDraft] = useState<number | null>(null);
  const latest = useRef<number | null>(null);
  const dragging = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Applied as picked: the slider follows the session again.
  useEffect(() => {
    if (draft !== null && applied === draft && !busy) setDraft(null);
  }, [applied, draft, busy]);

  const shown = draft ?? applied;
  const last = levels.length - 1;
  const pct = (shown / last) * 100;

  const choose = (i: number) => {
    latest.current = i;
    setDraft(i);
  };
  const commit = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const i = latest.current;
      if (i === null) return;
      if (i === applied) return setDraft(null);
      void onPick(levels[i]!).then((ok) => !ok && setDraft(null));
    }, delay);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span id={labelId} className="text-[13px] font-semibold text-ink">
          Effort
        </span>
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink" aria-hidden="true">
          {busy && <Spinner className="size-3" />}
          {effortLabel(levels[shown]!)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={last}
        step={1}
        value={shown}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-valuetext={effortLabel(levels[shown]!)}
        onChange={(e) => {
          choose(Number(e.target.value));
          if (!dragging.current) commit(400);
        }}
        onPointerDown={() => (dragging.current = true)}
        onPointerUp={() => {
          dragging.current = false;
          commit(0);
        }}
        onPointerCancel={() => {
          dragging.current = false;
          commit(0);
        }}
        style={{ background: `linear-gradient(to right, var(--color-primary) ${pct}%, var(--color-line) ${pct}%)` }}
        className={cn(
          'h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none disabled:cursor-not-allowed disabled:opacity-50',
          'focus-visible:ring-4 focus-visible:ring-[var(--ring)]',
          '[&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-surface [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-card',
          '[&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-surface [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-card',
        )}
      />
      {/* Under each stop: the thumb's center runs from half a thumb in to half a thumb short of the end.
          The end labels line up with the thumb's outer edge there instead, so none hangs past the track. */}
      <div className="relative h-5" aria-hidden="true">
        {levels.map((level, i) => (
          <button
            key={level}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onClick={() => {
              choose(i);
              commit(0);
            }}
            style={i === 0 ? { left: 0 } : i === last ? { right: 0 } : { left: `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${i / last})` }}
            className={cn(
              'absolute top-0 text-[11.5px] whitespace-nowrap transition-colors disabled:cursor-not-allowed',
              i > 0 && i < last && '-translate-x-1/2',
              i === shown ? 'font-semibold text-ink' : 'text-muted hover:text-ink',
            )}
          >
            {effortLabel(level)}
          </button>
        ))}
      </div>
      <p className="text-[12.5px] text-muted">How hard Claude thinks. More is slower and uses more tokens.</p>
    </div>
  );
}

function ModePicker({ mode, connected, onPick }: { mode: ChatPermissionMode; connected: boolean; onPick: (mode: ChatPermissionMode) => Promise<void> }) {
  const apply = useApply();
  const offered = OFFERED_MODES.includes(mode);
  return (
    <div className="flex flex-col gap-3">
      {!offered && (
        <p className="text-[13px] text-muted">
          Now: <span className={cn('font-semibold', MODES[mode]?.danger ? 'text-danger' : 'text-ink-soft')}>{MODES[mode]?.label ?? mode}</span>. Pick a
          mode to change it.
        </p>
      )}
      <OptionList
        label="Permission mode"
        current={offered ? mode : null}
        pending={apply.pending}
        disabled={!connected}
        onPick={(next) => void apply.run(next, () => onPick(next as ChatPermissionMode))}
        options={OFFERED_MODES.map((m) => {
          const { label, hint, icon: Icon } = MODES[m];
          return { value: m, label, hint, icon: <Icon className="size-4" /> };
        })}
      />
      <Footnotes error={apply.error} connected={connected} />
    </div>
  );
}

function Footnotes({ error, connected }: { error: string | null; connected: boolean }) {
  return (
    <>
      {!connected && (
        <p className="text-[13px] text-muted" aria-live="polite">
          Reconnecting… changes can be made once the session is back.
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">
      {children}
    </p>
  );
}

interface Option {
  value: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
}

/**
 * One choice per row, the current one ticked. A pick changes the session, so arrow keys only move
 * focus (Home/End too) and Enter or Space picks; every row is a Tab stop too, which keeps the kit
 * Dialog's focus trap whole. The current row takes focus when the picker opens.
 */
function OptionList({
  label,
  options,
  current,
  pending,
  disabled,
  dense,
  onPick,
}: {
  label: string;
  options: Option[];
  current: string | null;
  pending: string | null;
  disabled?: boolean;
  /** Tighter rows, hints at most two lines (the full hint on hover): long lists like the models. */
  dense?: boolean;
  onPick: (value: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const focusFirst = options.some((o) => o.value === current) ? current : options[0]?.value;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []);
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? (i + 1) % rows.length
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? (i - 1 + rows.length) % rows.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? rows.length - 1
              : null;
    if (next === null || rows.length === 0) return;
    e.preventDefault();
    rows[next]?.focus();
  };

  return (
    <div ref={ref} role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="-mx-2 flex flex-col gap-0.5">
      {options.map((o) => {
        const on = o.value === current;
        const busy = o.value === pending;
        const blocked = disabled || (pending !== null && !busy);
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={blocked || busy || undefined}
            aria-busy={busy || undefined}
            data-autofocus={o.value === focusFirst ? '' : undefined}
            onClick={() => !on && !blocked && !busy && onPick(o.value)}
            title={dense ? o.hint : undefined}
            className={cn(
              'flex min-h-11 w-full items-start gap-3 rounded-2xl px-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ink/40',
              dense ? 'py-2' : 'py-2.5',
              on ? 'bg-surface-2' : 'hover:bg-surface-2/70',
              blocked && 'cursor-not-allowed opacity-50',
            )}
          >
            {o.icon && <span className="mt-0.5 shrink-0 text-ink-soft">{o.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className={cn('block font-semibold text-ink', dense ? 'text-[14px]' : 'text-[15px]')}>{o.label}</span>
              {o.hint && (
                <span className={cn('mt-0.5 block break-words text-muted', dense ? 'line-clamp-2 text-[12px] leading-snug' : 'text-[13px]')}>{o.hint}</span>
              )}
            </span>
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
              {busy ? <Spinner className="size-4" /> : on ? <Check className="size-[18px] text-accent" aria-hidden="true" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
