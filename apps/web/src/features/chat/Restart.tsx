import { Button, ConfirmDialog, Dialog, SwitchRow, useMediaQuery, useToast } from '@isnanme/ui';
import type { ChatSession, ChatTask } from '@portal/contracts';
import { ChevronUp, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { Popover } from '@/components/Popover';
import { errorText } from '@/lib/api';
import { chatApi } from './api';
import { isBusy, restartHint, stopsNow, type HintView } from './restartHint';

/** The clock, once a minute: "Restart now" after a long turn appears without a reload. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Restart (chat PRD, Restart; T-102): Claude Code starts again on the same conversation, so what was delivered since it started loads. The
 * hint and the menu open one sheet (a popover on a laptop) with what changed and the actions for the state: at a boundary, Restart now in
 * one tap (running agents named first); while a turn runs, Restart after this turn (queued, the portal does it at the boundary) or Restart
 * now behind a confirmation that says what stops; Cancel a queued one; hide until the next change; apply changes at the turn's end by itself.
 */
export function useRestart(session: ChatSession | null | undefined, tasks: ChatTask[]) {
  const toast = useToast();
  const now = useMinute();
  const roomy = useMediaQuery('(min-width: 640px)');
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<'mcp' | 'manual' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = tasks.filter((t) => t.status === 'running');
  const names = running.map((t) => t.description || t.subagentType || 'Agent');
  const hint = restartHint(session, now);
  const why = open ?? 'mcp';

  const call = async (what: () => Promise<unknown>, failed: string) => {
    setBusy(true);
    try {
      await what();
      return true;
    } catch (e) {
      toast(errorText(e, failed), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const close = useCallback(() => setOpen(null), []);
  const stops = session ? stopsNow(session, names, !!hint?.dropsBypass) : [];
  const runNow = async () => {
    if (!session) return;
    const ok = await call(() => chatApi.restart(session.id, why, isBusy(session) ? { interrupt: true } : {}), 'Couldn’t restart it.');
    setConfirming(false);
    if (ok) setOpen(null);
  };
  const actions = {
    /** Restart now: one tap when nothing would be lost, else the confirmation says what stops. */
    now: () => (stops.length ? setConfirming(true) : void runNow()),
    queue: async () => session && (await call(() => chatApi.restart(session.id, why, { when: 'turn_end' }), 'Couldn’t queue the restart.')) && setOpen(null),
    cancel: async () => session && (await call(() => chatApi.cancelRestart(session.id), 'Couldn’t cancel it.')),
    hide: async () => session && (await call(() => chatApi.restartHint(session.id, { hidden: true }), 'Couldn’t hide it.')) && setOpen(null),
    auto: (on: boolean) => session && void call(() => chatApi.restartHint(session.id, { autoApply: on }), 'Couldn’t change the setting.'),
  };

  const body = session && (
    <RestartPanel session={session} hint={hint} busy={busy || !!session.restarting} agents={names} actions={actions} manual={open === 'manual'} />
  );
  const element = (
    <>
      {roomy ? (
        <Popover anchor={anchor} open={open !== null && !!session} onClose={close} label="Restart">
          {body}
        </Popover>
      ) : (
        <Dialog open={open !== null && !!session} onClose={close} title={hint && hint.state !== 'restarting' && hint.changes.length ? 'Tools changed' : 'Restart'} size="sm">
          {body}
        </Dialog>
      )}
      <ConfirmDialog
        open={confirming}
        title="Restart now?"
        description={[...stops, 'The conversation stays.'].join(' ')}
        confirmLabel="Restart now"
        loading={busy}
        onConfirm={() => void runNow()}
        onClose={() => !busy && setConfirming(false)}
      />
    </>
  );
  return {
    /** Opens the sheet (the menu's Restart, the chip). */
    start: (w: 'mcp' | 'manual') => session && session.state !== 'ended' && !session.switching && setOpen(w),
    element,
    busy: busy || !!session?.restarting,
    hint,
    anchor,
    actions,
  };
}

/** The sheet's body: what changed, what happens now in one line, and the actions for the state (never a disabled one without its reason). */
function RestartPanel({
  session,
  hint,
  busy,
  agents,
  actions,
  manual,
}: {
  session: ChatSession;
  hint: HintView | null;
  busy: boolean;
  agents: string[];
  actions: ReturnType<typeof useRestart>['actions'];
  manual: boolean;
}) {
  const state = hint?.state ?? (session.restarting ? 'restarting' : isBusy(session) ? 'busy' : 'idle');
  const minutes = session.busySince ? Math.max(1, Math.round((Date.now() - Date.parse(session.busySince)) / 60_000)) : null;
  const status: Record<typeof state, string> = {
    idle: agents.length ? 'Agents are running: Restart now stops them.' : 'Nothing is running: a restart now loses nothing.',
    busy: session.state === 'waiting' ? 'An approval is waiting.' : session.tasksOnly ? 'Agents are running.' : 'A turn is running.',
    queued: 'Restarts by itself once the turn and its agents finish.',
    auto: hint?.long && minutes ? `Restarts by itself after this turn (running ${minutes} min).` : 'Restarts by itself after this turn.',
    held: 'A restart can’t keep Bypass now, so it won’t restart by itself.',
    restarting: 'Restarting…',
  };
  const later = state === 'busy';
  const nowTone = state === 'idle' || (state === 'auto' && hint?.long) || state === 'held' ? 'primary' : 'secondary';
  return (
    <div className="flex flex-col gap-3">
      {hint && hint.changes.length > 0 && (
        <div>
          <div className="flex items-center gap-1 text-[12px] font-semibold tracking-wide text-muted uppercase">
            Changed
            <InfoTip label="About tools changed">
              Claude Code reads its MCP servers, settings and portal tools once, when it starts. A restart loads what changed; the conversation stays.
            </InfoTip>
          </div>
          <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="What changed">
            {hint.changes.map((c) => (
              <li key={c} className="rounded-full bg-surface-2 px-2.5 py-1 text-[13px] text-ink">
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p role="status" className="text-[13.5px] text-ink-soft">
        {status[state]}
      </p>
      {state !== 'restarting' && (
        <div className="flex flex-col gap-2">
          {later && (
            <>
              <Button variant="primary" icon={<RotateCw className="size-4" />} loading={busy} onClick={() => void actions.queue()}>
                Restart after this turn
              </Button>
              <p className="-mt-1 text-[12px] text-muted">Waits for running agents too; nothing is stopped.</p>
            </>
          )}
          {state === 'queued' && (
            <Button variant="primary" loading={busy} onClick={() => void actions.cancel()}>
              Cancel restart
            </Button>
          )}
          <Button variant={nowTone} icon={<RotateCw className="size-4" />} loading={busy} onClick={actions.now}>
            Restart now
          </Button>
          {state === 'auto' && (
            <Button variant="ghost" loading={busy} onClick={() => void actions.cancel()}>
              Not this time
            </Button>
          )}
        </div>
      )}
      <SwitchRow
        label="Apply at turn end"
        description="Restart by itself when a turn ends after tools change."
        checked={!!session.autoApply}
        onChange={actions.auto}
        disabled={busy}
      />
      {hint && hint.changes.length > 0 && !manual && state !== 'queued' && (
        <Button variant="ghost" onClick={() => void actions.hide()} disabled={busy}>
          Hide until the next change
        </Button>
      )}
    </div>
  );
}

/** The hint (T-102): one line that says what is going on, a tap opens the sheet; Cancel for a queued restart, Restart now after a long automatic wait. */
export function RestartChip({
  hint,
  anchor,
  onOpen,
  onCancel,
  onNow,
}: {
  hint: HintView | null;
  anchor: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  onCancel: () => void;
  onNow: () => void;
}) {
  if (!hint) return null;
  return (
    <div data-restart-chip="" className="glass-card flex max-w-full min-w-0 items-center gap-1 self-center rounded-full p-1 text-[13px] text-ink-soft">
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        onClick={onOpen}
        className="press flex min-h-9 min-w-0 items-center gap-2 rounded-full pr-2 pl-2.5 font-semibold tap:min-h-11"
      >
        <RotateCw className={`size-4 shrink-0 ${hint.state === 'restarting' ? 'animate-spin' : ''}`} aria-hidden="true" />
        <span role="status" className="min-w-0 break-words [overflow-wrap:anywhere]">
          {hint.line}
        </span>
        <ChevronUp className="size-4 shrink-0 text-muted" aria-hidden="true" />
      </button>
      {hint.inline === 'cancel' && (
        <Button size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      )}
      {hint.inline === 'now' && (
        <Button size="sm" variant="primary" icon={<RotateCw className="size-4" />} onClick={onNow}>
          Restart now
        </Button>
      )}
    </div>
  );
}
