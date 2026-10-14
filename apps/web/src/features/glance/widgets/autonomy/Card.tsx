import { Button, useToast } from '@isnanme/ui';
import { KEEPGOING_BOUNDS, KEEPGOING_PROGRAM_RE, type KeepGoingPause } from '@portal/contracts';
import { Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { chatApi } from '@/features/chat/api';
import { errorText } from '@/lib/api';
import { LevelDot } from '../../ui';
import { CardList, CardRow, Stat, Stats } from '../shared/card';
import { shortAgo } from '../shared/format';
import { GlanceFailed, GlanceLine, GlanceSkeleton, StaleNote } from '../shared/states';
import { useNow } from '../shared/useNow';
import { autonomyView } from './model';
import { autonomyStore } from './store';

/** Home's Autonomy: the chats kept going, the ones left down first, each with its state and Keep going's last action; a tap opens the chat. */
export function AutonomyCard() {
  const { data, failed, denied, stale, reload } = autonomyStore.use();
  const now = useNow();
  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  const v = autonomyView(data);
  return (
    <div data-autonomy="">
      {stale && <StaleNote reload={reload} />}
      {v.paused && (
        <p role="status" className="mb-1 flex items-center justify-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
          Paused
          <InfoTip label="Why Keep going is paused">Keep going is switched off for the whole portal (Settings, Keep going): nothing is watched until it is on again.</InfoTip>
        </p>
      )}
      {v.pauses.map((p) => (
        <PauseRow key={p.program ?? '*'} pause={p} now={now} done={reload} />
      ))}
      <Stats>
        <Stat value={v.watched} label="Watched" tone={v.watched ? 'accent' : undefined} />
        <Stat value={v.down} label="Down" tone={v.down ? 'danger' : undefined} />
        <Stat value={v.reported} label="Reported" tone={v.reported ? 'danger' : undefined} />
        <Stat value={v.actions} label="Today" />
      </Stats>
      {v.rows.length === 0 ? (
        <GlanceLine>No chat has Keep going on.</GlanceLine>
      ) : (
        <CardList label="Chats kept going">
          {v.rows.map((r) => {
            const meta = [r.state, r.what].filter(Boolean).join(' · ');
            return (
              <CardRow
                key={r.id}
                to={`/admin/sessions/${encodeURIComponent(r.id)}`}
                label={`${r.title}, ${r.workspace}: ${meta}`}
                lead={<LevelDot level={r.level} />}
                title={r.title}
                meta={<span className="min-w-0 truncate">{meta}</span>}
                trail={r.at ? shortAgo(r.at, now) : undefined}
              />
            );
          })}
        </CardList>
      )}
      <PauseForm done={reload} />
    </div>
  );
}

const HOLDS =
  'A pause holds the chats of a program (the label on a chat’s Keep going; the supervisor’s tracks are orchestrator, konfersi and event), or all of them: no nudge, wake, answer, new chat or report until it is resumed. Their state is still watched. Resume looks at them again at once.';

/** One pause: the program (or All), the reason, since when, and a 44 px Resume. */
function PauseRow({ pause, now, done }: { pause: KeepGoingPause; now: number; done: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const name = pause.program ?? 'All';
  const resume = async () => {
    setBusy(true);
    try {
      await chatApi.setKeepGoingPause({ program: pause.program, paused: false });
      await done();
    } catch (e) {
      toast(errorText(e, 'Couldn’t resume.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" data-autonomy-pause={pause.program ?? '*'} className="mb-1.5 flex min-w-0 items-center gap-2 rounded-xl bg-amber-500/10 py-0.5 pl-3 pr-0.5">
      <Pause className="size-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere]">
        <span className="font-semibold text-amber-700 dark:text-amber-400">Paused · {name}</span>
        <span className="text-muted">
          {' '}
          · {pause.reason} · <time dateTime={pause.since} title={new Date(pause.since).toLocaleString()}>{shortAgo(pause.since, now)}</time>
        </span>
      </p>
      <button
        type="button"
        disabled={busy}
        aria-label={`Resume ${name}`}
        title={`Resume ${name}`}
        data-autonomy-resume=""
        onClick={() => void resume()}
        className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-ink hover:bg-ink/[0.07] disabled:opacity-50"
      >
        <Play className="size-[18px]" aria-hidden="true" />
      </button>
    </div>
  );
}

const inputClass = 'h-11 w-full min-w-0 rounded-xl border border-line bg-transparent px-3 text-base text-ink placeholder:text-muted';

/** Pause a program or all: a 44 px button opens two fields (program, empty for all; the reason) and the confirming Pause. */
function PauseForm({ done }: { done: () => Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [program, setProgram] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const p = program.trim().toLowerCase();
  const valid = (p === '' || KEEPGOING_PROGRAM_RE.test(p)) && reason.trim().length > 0;
  const submit = async () => {
    setBusy(true);
    try {
      await chatApi.setKeepGoingPause({ program: p || null, paused: true, reason: reason.trim() });
      setOpen(false);
      setProgram('');
      setReason('');
      await done();
    } catch (e) {
      toast(errorText(e, 'Couldn’t pause.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <div className="mt-1.5 flex items-center justify-end gap-1">
        <InfoTip label="What a pause holds">{HOLDS}</InfoTip>
        <Button variant="ghost" className="min-h-11 gap-1.5" aria-label="Pause Keep going" data-autonomy-pause-open="" onClick={() => setOpen(true)}>
          <Pause className="size-[18px]" aria-hidden="true" />
          <span className="max-sm:sr-only">Pause</span>
        </Button>
      </div>
    );
  return (
    <form
      data-autonomy-pause-form=""
      className="mt-1.5 flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void submit();
      }}
    >
      <p className="flex items-center gap-1 text-[13px] font-semibold">
        Pause
        <InfoTip label="What a pause holds">{HOLDS}</InfoTip>
      </p>
      <input className={inputClass} value={program} onChange={(e) => setProgram(e.target.value)} placeholder="Program (empty: all)" aria-label="Program" maxLength={40} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" aria-label="Reason" maxLength={KEEPGOING_BOUNDS.pauseReasonMax} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" className="min-h-11" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" className="min-h-11" disabled={!valid || busy} data-autonomy-pause-confirm="">
          {p ? `Pause ${p}` : 'Pause all'}
        </Button>
      </div>
    </form>
  );
}
