import { Badge, FormDialog, Segmented, TextField } from '@isnanme/ui';
import { BUMP_MODE_LABEL, BUMP_MODES, BUMP_NOTE_MAX, type BumpMode, type BumpRequest, type BumpTarget } from '@portal/contracts';
import { Bot } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { firstPick, spansWorkspaces, targetLine } from './bump';

/**
 * Bump (tickets PRD FR28): push something into a running session, as its next work or as a question, with an optional one-line note.
 * Shared: a ticket's page and row use it, a CI run's next. The caller says how to load the sessions (`BumpTarget[]`, the preferred one
 * first) and how to bump; this is the picker, the mode, the note and the errors. Sessions that can't take it are shown greyed with why.
 */
export function BumpDialog({
  open,
  onClose,
  subject,
  preferredLabel = 'Assigned',
  modeHelp,
  load,
  onBump,
}: {
  open: boolean;
  onClose: () => void;
  /** What is bumped, under the title: "T-12 · Fix the login redirect". */
  subject: ReactNode;
  /** The mark on the preferred session. */
  preferredLabel?: string;
  /** What each mode does here, for the one ⓘ. */
  modeHelp: Record<BumpMode, string>;
  load: () => Promise<BumpTarget[]>;
  onBump: (req: BumpRequest) => Promise<void>;
}) {
  const [targets, setTargets] = useState<BumpTarget[] | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [mode, setMode] = useState<BumpMode>('prioritise');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const howId = useId();
  // Loaded each time it opens; the caller's function needn't be stable.
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    if (!open) return;
    setTargets(null);
    setSessionId('');
    setMode('prioritise');
    setNote('');
    setError(null);
    let current = true;
    loader.current().then(
      (list) => {
        if (!current) return;
        setTargets(list);
        setSessionId(firstPick(list));
      },
      (e) => current && (setTargets([]), setError(errorText(e, 'Couldn’t load the sessions.'))),
    );
    return () => {
      current = false;
    };
  }, [open]);

  const submit = async () => {
    if (!sessionId) return setError('Pick a session.');
    setSaving(true);
    setError(null);
    try {
      await onBump({ sessionId, mode, ...(note.trim() ? { note: note.trim() } : {}) });
    } catch (e) {
      setError(errorText(e, 'Couldn’t bump it.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog open={open} onClose={onClose} size="sm" title="Bump" description={subject} onSubmit={submit} submitLabel="Bump" submitDisabled={!sessionId} saving={saving} error={error} dirty={!!note.trim()}>
      <div className="flex flex-col gap-4">
        <SessionPicker targets={targets} value={sessionId} onChange={setSessionId} preferredLabel={preferredLabel} />
        <div className="flex flex-col gap-1.5">
          <p id={howId} className="flex items-center gap-1 text-sm font-semibold">
            How
            <InfoTip label="About the two ways">
              <span className="block">
                <b>{BUMP_MODE_LABEL.prioritise}:</b> {modeHelp.prioritise}
              </span>
              <span className="mt-1 block">
                <b>{BUMP_MODE_LABEL.ask}:</b> {modeHelp.ask}
              </span>
            </InfoTip>
          </p>
          <Segmented<BumpMode> label="How" labelledBy={howId} value={mode} onChange={setMode} options={BUMP_MODES.map((m) => ({ value: m, label: BUMP_MODE_LABEL[m] }))} />
        </div>
        <TextField label="Note" optional autoComplete="off" maxLength={BUMP_NOTE_MAX} placeholder={mode === 'ask' ? 'Your question' : 'Anything it should know'} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </FormDialog>
  );
}

/**
 * The live sessions as a radio list: title, then its state (or why it can't take a bump); the preferred one first with a mark. Each row is
 * a 44 px target; the list scrolls inside the dialog when long.
 */
export function SessionPicker({ targets, value, onChange, preferredLabel }: { targets: BumpTarget[] | null; value: string; onChange: (id: string) => void; preferredLabel: string }) {
  const name = useId();
  const labelId = useId();
  const many = targets ? spansWorkspaces(targets) : false;
  return (
    <div className="flex flex-col gap-1.5">
      <p id={labelId} className="text-sm font-semibold">
        Session
      </p>
      {targets === null ? (
        <div className="skeleton h-14 rounded-xl" aria-busy="true" />
      ) : targets.length === 0 ? (
        <p className="rounded-xl border border-line px-3 py-3 text-[13.5px] text-muted">No running session</p>
      ) : (
        <div role="radiogroup" aria-labelledby={labelId} className="flex max-h-64 flex-col overflow-y-auto overscroll-contain rounded-xl border border-line">
          {targets.map((t) => {
            const off = t.refusal !== null;
            const on = value === t.id;
            return (
              <label
                key={t.id}
                className={`flex min-h-11 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 ${off ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-surface-2/60'} ${on ? 'bg-surface-2' : ''}`}
              >
                <input type="radio" name={name} value={t.id} checked={on} disabled={off} onChange={() => onChange(t.id)} className="size-4 shrink-0 accent-primary" />
                <Bot className="size-4 shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold [overflow-wrap:anywhere]">{t.title || 'Untitled'}</span>
                  <span className="block text-[12.5px] text-muted [overflow-wrap:anywhere]">{targetLine(t, many)}</span>
                </span>
                {t.preferred && <Badge>{preferredLabel}</Badge>}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
