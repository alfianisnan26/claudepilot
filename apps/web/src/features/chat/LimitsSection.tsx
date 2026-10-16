import { Button, cn, SwitchRow, useToast } from '@isnanme/ui';
import type { ChatSession } from '@portal/contracts';
import { Minus, Plus, RotateCw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { settingsApi } from '@/features/settings/api';
import { errorText } from '@/lib/api';
import { chatApi } from './api';
import { limitsNote, nextPending, stepWorkers, workersCap, workersView, type SubagentsPending } from './crewLimits';

/** How long the stepper waits after the last tap before it saves: three taps are one change. */
const SAVE_AFTER_MS = 400;

/**
 * The session's limits in Session info (T-294, chat-sessions PRD FR51 "Limits per session"): Workers, how many sessions it may run at once
 * as its workers (None, a number, or Default: the global setting, read from Settings when the sheet opens, which is also the ceiling), and
 * Sub-agents, whether its Claude may start Claude Code sub-agents. Both save through `PATCH CHAT_API.limits`; the line shows what is
 * picked until the session catches up. A sub-agents change the live process needs a restart for says so in one line, with the existing
 * Restart (`onRestart`; absent where it can't restart, its workspace removed).
 */
export function LimitsSection({ session, onRestart }: { session: ChatSession; onRestart?: () => void }) {
  const toast = useToast();
  const labelId = useId();
  // The global cap: undefined until the settings were read (the stepper waits, so a first tap doesn't step from a guess), null if unknown.
  const [cap, setCap] = useState<number | null | undefined>(undefined);
  // What the stepper and the switch show until the session payload has the answer (undefined / null: the session's own).
  const [workers, setWorkers] = useState<number | null | undefined>(undefined);
  const [subagents, setSubagents] = useState<boolean | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [pending, setPending] = useState<SubagentsPending | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsaved = useRef<{ value: number | null } | null>(null);
  const id = useRef(session.id);
  id.current = session.id;

  // The global ceiling, read when the sheet opens; without it the stepper shows the number only.
  useEffect(() => {
    let current = true;
    settingsApi.list().then(
      (view) => current && setCap(workersCap(view)),
      () => current && setCap(null),
    );
    return () => {
      current = false;
    };
  }, []);

  const saveWorkers = (value: number | null) => {
    chatApi.setLimits(id.current, { maxWorkers: value }).catch((e: unknown) => {
      setWorkers(undefined);
      toast(errorText(e, 'Couldn’t change the workers.'), 'error');
    });
  };
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = unsaved.current;
    unsaved.current = null;
    if (next) saveWorkers(next.value);
  };
  // Closing the sheet saves what was picked (flush reads refs only).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => flush(), []);

  // The session caught up (or changed elsewhere): show its own values again, unless a pick is still waiting to be saved.
  const ownWorkers = session.maxWorkers ?? null;
  useEffect(() => {
    if (!unsaved.current) setWorkers(undefined);
  }, [ownWorkers]);
  const ownSub = session.subagents !== false;
  useEffect(() => setSubagents(null), [ownSub]);
  // A restart under way takes the pending change; another session's sheet starts clean.
  useEffect(() => {
    if (session.restarting) setPending(null);
  }, [session.restarting]);
  useEffect(() => setPending(null), [session.id]);

  const shownWorkers = workers !== undefined ? workers : ownWorkers;
  const ready = cap !== undefined;
  const view = workersView(shownWorkers, cap ?? null);
  const canLess = ready && view.canLess;
  const canMore = ready && view.canMore;
  const step = (dir: -1 | 1) => {
    if (!ready) return;
    const next = stepWorkers(shownWorkers, dir, cap);
    if (next === undefined) return;
    setWorkers(next);
    unsaved.current = { value: next };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_AFTER_MS);
  };

  const on = subagents ?? ownSub;
  const toggle = async (next: boolean) => {
    const before = on;
    setSubagents(next);
    setSubBusy(true);
    try {
      const res = await chatApi.setLimits(session.id, { subagents: next });
      setPending((p) => nextPending(p, { before, after: res.session.subagents !== false, restartNeeded: res.restartNeeded }));
    } catch (e) {
      setSubagents(null);
      toast(errorText(e, 'Couldn’t change sub-agents.'), 'error');
    } finally {
      setSubBusy(false);
    }
  };
  const note = limitsNote(pending, session);

  const stepClass = (can: boolean) =>
    cn(
      'press flex size-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ink/40',
      !can && 'cursor-not-allowed opacity-40 hover:bg-surface',
    );
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-3" data-crew-limits="">
      <div className="flex min-h-14 items-center gap-3 py-1">
        <p id={labelId} className="inline-flex min-w-0 flex-1 items-center gap-1 text-[15px] font-semibold text-ink">
          Workers
          <InfoTip label="About workers">
            How many sessions this one may run at once as its workers (started over the portal). Default follows Settings › Sessions, which is
            also the ceiling; None: it may not start any. Applies to its next worker.
          </InfoTip>
        </p>
        <div role="group" aria-labelledby={labelId} className="flex shrink-0 items-center gap-1" data-crew-workers-limit="">
          <button
            type="button"
            aria-label="Fewer workers"
            aria-disabled={!canLess || undefined}
            onClick={() => step(-1)}
            className={stepClass(canLess)}
          >
            <Minus className="size-4" aria-hidden="true" />
          </button>
          <output aria-live="polite" className="w-26 text-center text-[14px] font-semibold text-ink tabular-nums">
            <span aria-hidden="true">{view.text}</span>
            <span className="sr-only">{view.label}</span>
          </output>
          <button
            type="button"
            aria-label="More workers"
            aria-disabled={!canMore || undefined}
            onClick={() => step(1)}
            className={stepClass(canMore)}
          >
            <Plus className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <SwitchRow
        label={
          <span className="inline-flex items-center gap-1">
            Sub-agents
            <InfoTip label="About sub-agents">
              Whether its Claude may start Claude Code sub-agents (the Agent tool). Off, its process starts without them; a change applies at its
              next start, so a running one needs a Restart. A skill that runs in a forked context can still start one.
            </InfoTip>
          </span>
        }
        checked={on}
        onChange={(v) => void toggle(v)}
        disabled={subBusy}
      />
      {session.leadRules && (
        <p data-lead-rules="" className="inline-flex min-h-11 min-w-0 items-center gap-1 text-[15px] font-semibold text-ink">
          Lead rules on
          <InfoTip label="About lead rules">
            A crew lead (T-561, D-63): its file edits are refused outside its status files (docs/dev-sessions/status), its notes
            (docs/dev-sessions/notes) and /tmp, in Bypass too, and a refused edit tells it to dispatch a worker. Bash still works. Settings ›
            Sessions › Lead rules; a change applies at its next start.
          </InfoTip>
        </p>
      )}
      {note && (
        <div role="status" data-crew-limits-note="" className="flex min-w-0 items-center gap-2 text-[13px] text-ink-soft">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{note.line}</span>
          {note.restart && onRestart && (
            <Button size="sm" variant="secondary" className="pointer-coarse:h-11" icon={<RotateCw className="size-4" />} onClick={onRestart}>
              Restart
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
