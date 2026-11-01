import { cn, Segmented, DateField, TextArea } from '@isnanme/ui';
import { ACCESS_LEVEL_INFO, ACCESS_LIMITS, type AccessLevel, type AccessObjectType, type AccessReason, type Level } from '@portal/contracts';
import { Eye, Play, ShieldAlert, ShieldCheck } from 'lucide-react';
import { InfoTip } from '@/components/InfoTip';
import { dayString, endText, exposesCredentials, LEVEL_LABEL, levelChoices, maxDate, reasonText, untilChoices, type SubjectKind, type UntilKey } from './accessRules';

/** Shared pieces of the Access screens (docs/prd/access.md): the level cards, the end picker, a level pill, a reason line. */

export const LEVEL_ICON: Record<AccessLevel, typeof Eye> = { view: Eye, operate: Play, manage: ShieldCheck };

export function LevelPill({ level }: { level: Level }) {
  return (
    <span
      data-access-level={level}
      className={cn(
        'inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[12px] font-semibold',
        level === 'manage' ? 'bg-accent/15 text-accent' : level === 'operate' ? 'bg-warning/15 text-warning' : level === 'view' ? 'bg-surface-2 text-ink-soft' : 'bg-surface-2 text-muted',
      )}
    >
      {LEVEL_LABEL[level]}
    </span>
  );
}

/** "Team Ops · ends in 3 d" */
export function ReasonLine({ reasons, now }: { reasons: readonly AccessReason[]; now: number }) {
  const parts = reasons.map((r) => {
    const end = r.kind === 'share' ? endText(r.share.expiresAt, now) : null;
    return end ? `${reasonText(r)} · ${end}` : reasonText(r);
  });
  return <span className="block text-[12.5px] [overflow-wrap:anywhere] text-muted">{parts.join(', ') || 'No access'}</span>;
}

/**
 * The "What level" step: one card per level with its icon, one line, and the full list in an InfoTip. A level above the granter's own (or
 * manage to everyone) is shown disabled. Operating a workspace with credential sets shows the warning and asks for the tick.
 */
export function LevelCards({
  type,
  mayGrant,
  subject,
  value,
  onChange,
  credentials,
  ack,
  onAck,
}: {
  type: AccessObjectType;
  mayGrant: readonly AccessLevel[];
  subject: SubjectKind | null;
  value: AccessLevel | null;
  onChange: (l: AccessLevel) => void;
  credentials: readonly { poolId: string; name: string }[];
  ack: boolean;
  onAck: (v: boolean) => void;
}) {
  const choices = levelChoices(mayGrant, subject);
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Level" className="flex flex-col gap-2">
        {choices.map((c) => {
          const info = ACCESS_LEVEL_INFO[type][c.level];
          const Icon = LEVEL_ICON[c.level];
          const on = value === c.level;
          return (
            <div key={c.level} className="relative">
              <button
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!c.allowed}
                data-access-level-card={c.level}
                onClick={() => onChange(c.level)}
                className={cn(
                  'press flex min-h-16 w-full items-center gap-3 rounded-2xl border px-3 py-2 pr-12 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50',
                  on ? 'border-accent bg-accent/10' : 'border-line bg-surface',
                )}
              >
                <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', on ? 'bg-accent text-white' : 'bg-surface-2 text-ink-soft')}>
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{info.label}</span>
                  <span className="block text-[13px] [overflow-wrap:anywhere] text-muted">{c.allowed ? info.short : c.why}</span>
                </span>
              </button>
              <span className="absolute top-1/2 right-1 -translate-y-1/2">
                <InfoTip label={`What ${info.label.toLowerCase()} allows`}>
                  <ul className="list-disc pl-4">
                    {info.allows.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </InfoTip>
              </span>
            </div>
          );
        })}
      </div>
      {exposesCredentials(type, value, credentials.length) && (
        <label data-access-credentials="" className="flex min-h-12 items-start gap-3 rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <input type="checkbox" className="mt-1 size-5 shrink-0 accent-accent" checked={ack} onChange={(e) => onAck(e.target.checked)} />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <ShieldAlert className="mr-1 inline size-4 align-[-3px] text-warning" aria-hidden />
            They can read its credentials: {credentials.map((c) => c.name).join(', ')}.
          </span>
        </label>
      )}
    </div>
  );
}

/** The "Until" step: No end / 7 days / 30 days / a date, then an optional note. Choices past the granter's own end are left out. */
export function UntilPicker({
  maxUntil,
  now,
  until,
  onUntil,
  date,
  onDate,
  note,
  onNote,
}: {
  maxUntil: string | null;
  now: number;
  until: UntilKey;
  onUntil: (k: UntilKey) => void;
  date: string;
  onDate: (d: string) => void;
  note: string;
  onNote: (n: string) => void;
}) {
  const choices = untilChoices(maxUntil, now).filter((c) => c.allowed);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span id="access-until-label" className="flex items-center gap-1 text-[13px] font-semibold text-muted">
          Until
          {maxUntil && <InfoTip label="Why the end is limited">Your own access ends {new Date(maxUntil).toLocaleDateString()}. What you give ends by then too.</InfoTip>}
        </span>
        <Segmented<UntilKey> label="Until" labelledBy="access-until-label" value={until} options={choices.map((c) => ({ value: c.key, label: c.label }))} onChange={onUntil} />
      </div>
      {until === 'date' && <DateField label="End date" value={date} onChange={onDate} min={dayString(now)} max={maxDate(maxUntil, now)} />}
      <TextArea label="Note" optional rows={2} maxLength={ACCESS_LIMITS.noteMax} value={note} onChange={(e) => onNote(e.target.value)} placeholder="Why" />
    </div>
  );
}
