import { SwitchRow, useToast } from '@isnanme/ui';
import type { ChatKeepGoing, ChatSession } from '@portal/contracts';
import { Repeat } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { chatApi } from './api';

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** "3 nudges · 1 wake": today's counts, from the session payload (the server counts the last 24 hours). */
export function keepGoingCounts(kg: Pick<ChatKeepGoing, 'nudgesToday' | 'wakesToday'>): string {
  const n = `${kg.nudgesToday} ${kg.nudgesToday === 1 ? 'nudge' : 'nudges'}`;
  const w = `${kg.wakesToday} ${kg.wakesToday === 1 ? 'wake' : 'wakes'}`;
  return `${n} · ${w}`;
}

/** Why nothing is done for the chat: a pause of all, of its program (with the reason), or the portal's switch. */
export function pausedWord(kg: Pick<ChatKeepGoing, 'pause'>): string {
  if (!kg.pause) return 'Paused for the portal';
  return `Paused (${kg.pause.program ?? 'all'}): ${kg.pause.reason}`;
}

/**
 * Keep going in Session info (T-259): the switch, today's counts and the last action. The portal watches a chat with it on: an idle one is
 * told to continue, an interrupted one is woken, a question is told to decide; a tool approval, Bypass off or an ending is reported.
 */
export function KeepGoingSection({ session }: { session: ChatSession }) {
  const toast = useToast();
  const kg = session.keepGoing ?? null;
  // What the switch shows until the session payload catches up with the answer.
  const [shown, setShown] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setShown(null), [kg?.enabled]);
  const on = shown ?? !!kg?.enabled;
  const ended = session.state === 'ended';
  const change = async (next: boolean) => {
    setShown(next);
    setBusy(true);
    try {
      await chatApi.setKeepGoing(session.id, { enabled: next });
    } catch (e) {
      setShown(null);
      toast(errorText(e, 'Couldn’t change Keep going.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-keep-going="">
      <SwitchRow
        label={
          <span className="inline-flex items-center gap-1">
            Keep going
            <InfoTip label="About Keep going">
              The portal looks at this chat every minute. Idle for {kg?.nudgeAfterMin ?? 4} minutes: it is told to continue. Interrupted or asleep: it is woken. A question: it is told to decide by
              the written defaults. Ended: it is brought back, in place or as a new chat (in the default mode). A tool approval is never answered and Bypass is never turned on: those, and a chat
              left down, come to you as one notification and one ticket.
            </InfoTip>
          </span>
        }
        checked={on}
        onChange={(v) => void change(v)}
        disabled={busy || (ended && !on)}
      />
      {kg && (on || kg.nudgesToday > 0 || kg.wakesToday > 0) && (
        <p className="text-[12.5px] [overflow-wrap:anywhere] text-muted">
          {kg.paused ? <span className="text-amber-700 dark:text-amber-400">{pausedWord(kg)} · </span> : null}
          {kg.program ? <span className="text-ink-soft">{kg.program} · </span> : null}
          Today: {keepGoingCounts(kg)}
          {kg.last && kg.last.kind !== 'set' && (
            <>
              <br />
              <span className="text-ink-soft">
                {clock(kg.last.at)} · {kg.last.reason}
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** The header's chip while Keep going is on: icon only (text diet), 44 px, opens Session info. */
export function KeepGoingChip({ session, onOpen }: { session: ChatSession | null | undefined; onOpen: () => void }) {
  const kg = session?.keepGoing;
  if (!session || !kg?.enabled || session.state === 'ended') return null;
  const label = `Keep going is on${kg.paused ? (kg.pause ? `, paused (${kg.pause.program ?? 'all'})` : ', paused for the portal') : ''}: ${keepGoingCounts(kg)} today`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      data-keep-going-chip=""
      className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-accent hover:bg-ink/[0.07]"
    >
      <Repeat className={kg.paused ? 'size-[18px] opacity-50' : 'size-[18px]'} aria-hidden="true" />
    </button>
  );
}
