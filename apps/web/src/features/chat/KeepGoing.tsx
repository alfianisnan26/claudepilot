import { SwitchRow, useToast } from '@isnanme/ui';
import type { ChatKeepGoing, ChatSession } from '@portal/contracts';
import { Repeat } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { chatApi } from './api';
import { programInput } from './listOrder';

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
      {kg && on && <ProgramField sessionId={session.id} program={kg.program ?? null} />}
      {kg && (on || kg.nudgesToday > 0 || kg.wakesToday > 0) && (
        <p className="text-[12.5px] [overflow-wrap:anywhere] text-muted">
          {kg.paused ? <span className="text-amber-700 dark:text-amber-400">{pausedWord(kg)} · </span> : null}
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

/**
 * The chat's program (T-259 slice 3): what the pause switch and the chat list's Program filter go by. Saved on Enter or when the field is
 * left; empty is none. 44 px tall, 16 px text (no zoom on an iPhone), the explanation in its InfoTip.
 */
function ProgramField({ sessionId, program }: { sessionId: string; program: string | null }) {
  const toast = useToast();
  const [text, setText] = useState(program ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(program ?? ''), [program]);
  const save = async () => {
    const next = programInput(text);
    if (next === undefined) {
      toast('A program is lowercase letters, digits and hyphens, at most 40.', 'error');
      return setText(program ?? '');
    }
    if (next === program) return setText(program ?? '');
    setBusy(true);
    try {
      await chatApi.setKeepGoing(sessionId, { program: next });
    } catch (e) {
      setText(program ?? '');
      toast(errorText(e, 'Couldn’t change the program.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="flex min-w-0 items-center gap-2 text-[13.5px] text-ink-soft" data-keep-going-program="">
      <span className="inline-flex shrink-0 items-center gap-1">
        Program
        <InfoTip label="About the program">
          The program this chat belongs to, such as event or konfersi. Pausing a program on the Autonomy card holds its chats; the chat list can show one program. Empty: none.
        </InfoTip>
      </span>
      <input
        type="text"
        value={text}
        disabled={busy}
        maxLength={40}
        placeholder="none"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="done"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        }}
        className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-[16px] text-ink placeholder:text-muted focus:border-primary focus:outline-hidden sm:text-[14px]"
      />
    </label>
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
