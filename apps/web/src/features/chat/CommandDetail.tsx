import { Badge, Button, Spinner } from '@isnanme/ui';
import type { ChatEvent, ChatTask } from '@portal/contracts';
import { ArrowLeft, Square, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { TASK_STATUS, taskMs } from './AgentDetail';
import { exitCode, exitNote } from './agentList';
import { InputBlock } from './CodeBlock';
import { looksLikeCommand } from './commandLabel';
import { formatDuration, timeShort, useNow } from './shared';
import { inputView } from './toolFormat';

/**
 * A background command in full (ticket T-149): its label, status, the whole command in the shared code block (shell colours, wrap, copy),
 * its exit code, time and start. Its output stays in the workspace (Claude Code writes it to a file the portal does not read), so it says
 * unavailable rather than guess. It replaces the list in the Agents panel or sheet; back returns to the list.
 */
export function CommandDetail({
  task: t,
  label,
  call,
  onBack,
  onClose,
  closeLabel,
  titleId,
  onStop,
  stopping,
  stopDisabled,
  failure,
}: {
  task: ChatTask;
  /** The row's label (the call's own description, or one made from its command). */
  label: string;
  /** The call that started it, when the transcript has it: the whole command as the portal kept it. */
  call?: ChatEvent;
  onBack: () => void;
  onClose: () => void;
  closeLabel: string;
  titleId?: string;
  onStop?: () => void;
  stopping: boolean;
  stopDisabled: boolean;
  failure?: string;
}) {
  const running = t.status === 'running';
  const status = TASK_STATUS[t.status] ?? TASK_STATUS.running;
  const now = useNow(running);
  const ms = taskMs(t, now);
  const exit = exitCode(t.summary);
  const note = exitNote(t.summary);
  // The whole command from its call; without it, the task's own name when that is the command (200 characters of it at most).
  const view = call
    ? inputView('Bash', call.toolInput, call.text, !!call.toolInputCut)
    : looksLikeCommand(t.description)
      ? { ...inputView('Bash', undefined, t.description), cut: t.description.endsWith('…') }
      : null;
  const ago = timeShort(t.startedAt, now);

  const facts: [string, ReactNode][] = [
    [
      'Exit code',
      exit !== null ? (
        <span>
          <span className={t.status === 'failed' ? 'font-semibold text-danger tabular-nums' : 'font-medium tabular-nums'}>{exit}</span>
          {note && <span className="text-muted"> · {note}</span>}
        </span>
      ) : (
        <span className="text-muted">{running ? '–' : 'Unavailable'}</span>
      ),
    ],
    ['Time', Number.isFinite(ms) ? <span className="tabular-nums">{formatDuration(ms)}</span> : <span className="text-muted">–</span>],
    ['Started', <span title={new Date(t.startedAt).toLocaleString()}>{ago === 'now' ? 'Just now' : `${ago} ago`}</span>],
    [
      'Output',
      <span className="inline-flex items-center gap-1 text-muted">
        Unavailable
        <InfoTip label="About the output">Claude Code writes a background command’s output to a file in the workspace, and Claude reads it there. The portal doesn’t keep it.</InfoTip>
      </span>,
    ],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line pr-2 pl-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to agents"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink tap:size-11"
        >
          <ArrowLeft className="size-[18px]" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold">
            Command
          </h2>
          <p className="truncate text-[11px] text-muted">{status.label}</p>
        </div>
        {onStop && running && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Square className="size-3.5" />}
            loading={stopping}
            disabled={stopDisabled}
            onClick={onStop}
            aria-label={stopping ? `Stopping ${label}` : `Stop ${label}`}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink tap:size-11"
        >
          <X className="size-[18px]" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-3">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-[14px] leading-snug font-semibold break-words wrap-anywhere">{label}</p>
          <Badge tone={status.tone} className="shrink-0">
            {running && <Spinner className="size-3" />}
            {status.label}
          </Badge>
        </div>
        {failure && !stopping && (
          <p role="alert" className="mt-2 text-[12.5px] font-medium break-words text-danger">
            {failure}
          </p>
        )}
        <div className="mt-3">{view ? <InputBlock view={view} /> : <p className="text-[13px] text-muted">The command isn’t loaded in this view.</p>}</div>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px]">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="min-w-0 break-words text-ink-soft">{v}</dd>
            </div>
          ))}
        </dl>
        {t.summary && exit === null && (
          <div className="mt-3">
            <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">Result</h3>
            <p className="mt-1 text-[13px] break-words whitespace-pre-wrap text-ink-soft wrap-anywhere">{t.summary}</p>
          </div>
        )}
      </div>
    </div>
  );
}
