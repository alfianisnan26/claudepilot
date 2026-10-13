import { Button, cn, Dialog, Spinner, SwitchRow } from '@isnanme/ui';
import { autoModeAllowed, type ChatBypassState, type ChatModelOption, type ChatPermissionMode, type ChatSession } from '@portal/contracts';
import {
  Check,
  FilePen,
  Hand,
  ListChecks,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { chatApi } from './api';
import { BypassDialog } from './BypassDialog';
import { ContextRing } from './ContextRing';
import { EffortSlider, ModelFamilies } from './ModelPicker';
import type { ChatControlArgs, ChatControlOp } from './useChatSocket';

type Control = (op: ChatControlOp, args?: ChatControlArgs) => Promise<void>;
type Picker = 'model' | 'mode' | 'bypass';

/** Opens the mode picker from elsewhere: on phones, Mode lives in the session's ⋯ menu. */
export interface ControlsHandle {
  openMode: () => void;
}

/** Every mode a session can report, so the chip always reads right; only `OFFERED_MODES` can be picked here. */
const MODES: Record<ChatPermissionMode, { label: string; hint: string; icon: LucideIcon; danger?: boolean }> = {
  plan: { label: 'Plan', hint: 'Reads and plans; changes nothing until you approve.', icon: ListChecks },
  default: { label: 'Manual', hint: 'Asks before edits and commands.', icon: Hand },
  acceptEdits: { label: 'Edit', hint: 'Edits files without asking; asks before commands.', icon: FilePen },
  auto: { label: 'Auto', hint: 'A classifier approves routine actions and blocks risky ones.', icon: ShieldCheck },
  dontAsk: { label: 'Don’t ask', hint: 'Runs only pre-approved actions and denies the rest.', icon: ShieldOff },
  bypassPermissions: { label: 'Bypass', hint: 'Runs everything without asking.', icon: ShieldAlert, danger: true },
};
/** A mode's name and icon, for the ⋯ menu's Mode item. */
export const modeDetails = (mode: ChatPermissionMode) => MODES[mode] ?? MODES.default;

/** The modes one tap changes to. Bypass has its own row below them, only where the policy allows it, and its own confirmation. */
const OFFERED_MODES: ChatPermissionMode[] = ['plan', 'default', 'acceptEdits', 'auto'];
/** The row that makes a session bypass-capable: it restarts it with the flag. */
const RESTART_FOR_BYPASS = 'restart-for-bypass';

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
 * The session's controls, as pills in the composer card's bottom row: "Opus 5.5 Medium" (with ⚡ while
 * Ultracode is on; the effort from 640 px) opens one Model and effort sheet (chat PRD §12.4); the permission
 * mode follows, always there (on phones as its icon alone, a fixed size, so Bypass or any other mode never
 * squeezes the model's name); the context ring sits at the end, by Send. Pickers send the change and wait for its ack, showing the error in place,
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
  const [bypass, setBypass] = useState<ChatBypassState | null>(null);

  useEffect(() => {
    setOpen(null);
    setModels(null);
    setModelsError(null);
    setPicked(null);
    setBypass(null);
  }, [sessionId]);

  // Where Bypass stands (policy, the session's opt-in) is read each time the mode picker opens.
  const needBypass = open === 'mode';
  useEffect(() => {
    if (!needBypass) return;
    let current = true;
    chatApi.bypass(sessionId).then(
      (state) => current && setBypass(state),
      () => current && setBypass(null),
    );
    return () => {
      current = false;
    };
  }, [needBypass, sessionId, session.bypassCapable, session.mode]);

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
      <div role="group" aria-label="Session settings" className={cn('flex min-w-0 items-center gap-1 sm:gap-1.5', className)}>
        <Quiet
          onClick={() => setOpen('model')}
          ariaLabel={`Model and effort: ${modelName}${effort ? `, ${effort}` : ''}${session.ultracode ? ', Ultracode on' : ''}`}
          title={session.model ?? undefined}
        >
          <span className="truncate">{modelName}</span>
          {/* Phones keep the model's name whole: the effort is in the label and the sheet. */}
          {effort && <span className="hidden shrink-0 font-medium text-muted sm:inline">{effort}</span>}
          {session.ultracode && <Zap className="size-3 shrink-0 text-gold" aria-hidden="true" />}
        </Quiet>
        <Quiet
          onClick={() => setOpen('mode')}
          ariaLabel={`Permission mode: ${mode.label}`}
          tone={mode.danger ? 'danger' : session.mode !== 'default' ? 'gold' : undefined}
          iconOnPhone
          className="shrink-0"
        >
          <ModeIcon className="size-4 shrink-0 sm:size-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">{mode.label}</span>
        </Quiet>
        {/* At the row's end, by Send. On phones it makes way for the wider Steer while a turn runs and words are in the box (Composer's data-steer). */}
        <span className="ml-auto flex shrink-0 max-sm:in-data-steer:hidden">
          <ContextRing context={session.context} />
        </span>
      </div>

      <Dialog open={open === 'model'} onClose={close} size="sm" title="Model and effort">
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
          autoAllowed={autoModeAllowed(session)}
          connected={connected}
          bypass={bypass}
          onBypass={() => setOpen('bypass')}
          onAllow={async () => {
            await chatApi.allowBypass(sessionId);
            setBypass(await chatApi.bypass(sessionId));
          }}
          onPick={async (next) => {
            await control('mode', { mode: next });
            done('mode');
          }}
        />
      </Dialog>

      {bypass && (
        <BypassDialog
          open={open === 'bypass'}
          onClose={close}
          sessionId={sessionId}
          workspace={session.workspaceId}
          facts={bypass.facts}
          onEntered={() => done('bypass')}
        />
      )}
    </>
  );
}

/** One of the line's controls: text with a small chevron, no frame; the tone marks a mode worth noticing. */
function Quiet({
  onClick,
  ariaLabel,
  title,
  tone,
  iconOnPhone,
  className,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  title?: string;
  tone?: 'gold' | 'danger';
  /** Below 640 px a round icon button of a fixed size, so the row keeps its shape whatever it says. (One width and padding class each: the kit's `cn` doesn't merge conflicting ones.) */
  iconOnPhone?: boolean;
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
        'press inline-flex h-10 min-w-0 items-center gap-1 rounded-full text-[14px] font-semibold whitespace-nowrap transition-colors tap:h-11 sm:text-[13.5px]',
        iconOnPhone ? 'w-10 justify-center tap:w-11 sm:w-auto sm:px-3' : 'px-2 sm:px-3',
        tone === 'danger'
          ? 'bg-danger-soft text-danger'
          : tone === 'gold'
            ? 'bg-gold-soft text-gold'
            : 'bg-ink/[0.07] text-ink hover:bg-ink/[0.12]',
        className,
      )}
    >
      {children}
    </button>
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
 * Model and effort in one sheet (chat PRD §12.4): the session's models as families (versions as
 * buttons under the picked one), then effort as a slider over the model's own levels, then Ultracode
 * where the model has it. Each pick applies at once and the sheet
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
          {models.length === 0 ? (
            <p className="text-[13px] text-muted">This session has no other models to switch to.</p>
          ) : (
            <ModelFamilies
              models={models}
              current={current}
              applied={session.model}
              pending={apply.pending}
              disabled={!connected}
              onPick={(value) => void apply.run(value, () => onModel(value))}
            />
          )}
        </div>
      )}
      {session.effort !== null && levels.length > 0 && (
        <div className="border-t border-line pt-4">
          <EffortSlider
            levels={levels}
            value={session.effort}
            label={effortLabel}
            busy={effortBusy}
            disabled={!connected || (apply.pending !== null && !effortBusy)}
            onChange={(value) => void apply.run(`effort:${value}`, () => onEffort(value))}
          />
        </div>
      )}
      {(session.ultracodeAvailable || session.ultracode) && (
        <div className="border-t border-line pt-1">
          <SwitchRow
            label={
              <span className="inline-flex items-center gap-1">
                Ultracode
                <InfoTip label="About Ultracode">Plans multi-agent workflows for big tasks. Uses many more tokens.</InfoTip>
              </span>
            }
            description={
              ultracodeBusy ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner className="size-3" /> Applying…
                </span>
              ) : undefined
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

function ModePicker({
  mode,
  autoAllowed,
  connected,
  bypass,
  onBypass,
  onAllow,
  onPick,
}: {
  mode: ChatPermissionMode;
  /** Auto is only for a session a person started here (not a trigger's, a ticket's, MCP's or another session's). */
  autoAllowed: boolean;
  connected: boolean;
  /** Where Bypass stands; null until read (or when it can't be). */
  bypass: ChatBypassState | null;
  /** Opens the confirmation. */
  onBypass: () => void;
  /** "Restart to allow Bypass". */
  onAllow: () => Promise<void>;
  onPick: (mode: ChatPermissionMode) => Promise<void>;
}) {
  const apply = useApply();
  const offered = OFFERED_MODES.includes(mode);
  const options: Option[] = OFFERED_MODES.map((m) => {
    const { label, hint, icon: Icon } = MODES[m];
    const blocked = m === 'auto' && !autoAllowed && mode !== 'auto';
    return { value: m, label, hint: blocked ? 'Only for sessions you start here.' : hint, icon: <Icon className="size-4" />, disabled: blocked };
  });
  // Bypass, in the danger colour, only where the policy allows it: its own row once the session can enter it, else the restart that makes it so.
  if (bypass?.allowed && !bypass.active)
    options.push(
      bypass.capable
        ? { value: 'bypassPermissions', label: MODES.bypassPermissions.label, hint: MODES.bypassPermissions.hint, icon: <ShieldAlert className="size-4" />, danger: true }
        : {
            value: RESTART_FOR_BYPASS,
            label: 'Restart to allow Bypass',
            hint: bypass.busy ? 'After this turn ends.' : undefined,
            icon: <ShieldAlert className="size-4" />,
            danger: true,
            disabled: bypass.busy,
          },
    );
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
        onPick={(next) => {
          if (next === 'bypassPermissions') return onBypass();
          if (next === RESTART_FOR_BYPASS) return void apply.run(next, onAllow);
          void apply.run(next, () => onPick(next as ChatPermissionMode));
        }}
        options={options}
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
  /** In the danger colour: what it does can't be undone by a tap. */
  danger?: boolean;
  disabled?: boolean;
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
        const blocked = disabled || o.disabled || (pending !== null && !busy);
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
            {o.icon && <span className={cn('mt-0.5 shrink-0', o.danger ? 'text-danger' : 'text-ink-soft')}>{o.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className={cn('block font-semibold', o.danger ? 'text-danger' : 'text-ink', dense ? 'text-[14px]' : 'text-[15px]')}>{o.label}</span>
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
