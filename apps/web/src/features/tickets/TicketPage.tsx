import { Badge, Button, ConfirmDialog, LoadError, Menu, Select, useToast } from '@isnanme/ui';
import {
  BUMP_MODE_LABEL,
  TICKET_LIMITS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUSES,
  TICKET_STATUS_LABEL,
  TICKET_TYPES,
  TICKET_TYPE_LABEL,
  isTicketClosed,
  type TicketDetail,
  type TicketEvent,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
  type TicketBucket,
} from '@portal/contracts';
import { Bot, ChevronLeft, ChevronsUp, Circle, GitBranch, MessageSquare, Play, RotateCcw, Trash2, User, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { usePanel } from '@/components/Workbench';
import { Markdown } from '@/features/chat/Markdown';
import { errorText } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { ticketsApi } from './api';
import { Attachments, fileSize } from './Attachments';
import { ORPHAN_TITLE, SESSION_STATE_LABEL, actorName, bucketOption, fallbackSentence, ticketLabel } from './labels';
import { AssigneeChip, CheckChips, PriorityMark, StatusBadge, TagList, TicketFlags, TypeBadge } from './parts';
import { AssignDialog, CloseDialog, EditTicketDialog, StartSessionDialog, TagsDialog, TicketBumpDialog } from './TicketDialogs';

type Dialog = 'edit' | 'tags' | 'assign' | 'close' | 'start' | 'bump' | 'delete' | null;

/**
 * One ticket (tickets PRD §13): its fields, description, the sessions that worked it and its timeline,
 * with a comment box. Text an agent wrote is marked as such. It follows the live socket. It is the Tickets
 * Workbench's second panel (T-158): in the queue's place on a phone (Back returns), beside it where both fit
 * (Close). Its layout answers to the panel's width, not the window's.
 */
export function TicketPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [failed, setFailed] = useState<'missing' | 'error' | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  // T-1967: the buckets a ticket can move to.
  const [buckets, setBuckets] = useState<TicketBucket[]>([]);
  useEffect(() => {
    ticketsApi.buckets().then(setBuckets, () => undefined);
  }, []);
  // At phone width the select shows the key alone ("CP · ClaudePi" was cut at 390 px); the name stays in the field's tip.
  const [wide, setWide] = useState(() => typeof matchMedia === 'function' && matchMedia('(min-width: 640px)').matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const q = matchMedia('(min-width: 640px)');
    const on = () => setWide(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  // Beside the queue, Close floats at the panel's top right: the header keeps clear of it.
  const { split } = usePanel();

  const load = useCallback(async () => {
    try {
      setDetail(await ticketsApi.get(id));
      setFailed(null);
    } catch (e) {
      setFailed((e as { status?: number }).status === 404 ? 'missing' : 'error');
    }
  }, [id]);
  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);
  useLive('tickets', () => void load());

  const change = async (patch: Parameters<typeof ticketsApi.update>[1], done?: string) => {
    setBusy(true);
    try {
      await ticketsApi.update(id, patch);
      if (done) toast(done);
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t change it.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (failed === 'missing')
    return (
      <>
        <Back />
        <p className="text-sm text-muted">Ticket not found.</p>
      </>
    );
  if (failed && !detail) return <LoadError onRetry={load} />;
  if (!detail)
    return (
      <>
        <Back />
        <div className="skeleton h-40 rounded-[24px]" aria-busy="true" />
      </>
    );

  const t = detail.ticket;
  const closed = isTicketClosed(t.status);
  const done = (kind: string) => async () => {
    setDialog(null);
    toast(kind);
    await load();
  };

  return (
    <>
      <Back />
      <header className={split ? 'mb-5 pr-12' : 'mb-5'}>
        <p className="flex items-center gap-2 text-[13px] font-semibold text-muted">
          <PriorityMark priority={t.priority} />
          <span className="tabular-nums">{ticketLabel(t)}</span>
          {/* T-1098: the stable id stays a permanent alias (trailers, old links). */}
          {t.key && t.key !== t.id && <span className="font-normal tabular-nums">{t.id}</span>}
          <span aria-hidden="true">·</span>
          <span title={formatDateTime(t.createdAt)}>Created {timeAgo(t.createdAt)}</span>
        </p>
        <h1 className="mt-1 text-xl font-bold tracking-tight break-words sm:text-2xl">{t.summary}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <StatusBadge status={t.status} />
          <TypeBadge type={t.type} />
          <TicketFlags ticket={t} />
        </div>
        {t.orphan && (
          <div role="status" className="mt-3 flex items-start gap-2 rounded-2xl bg-danger-soft px-3.5 py-2.5 text-[14px]">
            <span className="min-w-0 flex-1 break-words">
              <span className="font-semibold text-danger">{ORPHAN_TITLE[t.orphan.why]}</span>
              {t.orphan.since && (
                <span className="text-ink-soft" title={formatDateTime(t.orphan.since)}>
                  {' '}
                  · {timeAgo(t.orphan.since)}
                </span>
              )}
            </span>
            <InfoTip label="About an ended agent">
              Nobody works this ticket now. A few minutes after the agent ended, the portal moves it by itself: to the agent that continues the track, else back to the agents’ queue. An agent that comes back keeps it.
            </InfoTip>
          </div>
        )}
        {detail.checks.length > 0 && (
          <div className="mt-2">
            <CheckChips checks={detail.checks} />
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2 tap:[&_[aria-haspopup=menu]]:size-11">
          {!closed && (
            <Button icon={<Play className="size-4" />} onClick={() => setDialog('start')}>
              Start session
            </Button>
          )}
          {!closed && (
            <Button variant="secondary" icon={<ChevronsUp className="size-4" />} onClick={() => setDialog('bump')}>
              {/* Icon only on a phone, so the actions keep to one line at 390 px. */}
              <span className="max-sm:sr-only">Bump</span>
            </Button>
          )}
          {!closed && (
            <Button variant="secondary" onClick={() => setDialog('close')}>
              Close
            </Button>
          )}
          {closed && (
            <Button variant="secondary" icon={<RotateCcw className="size-4" />} loading={busy} onClick={() => void change({ status: 'open' }, 'Reopened')}>
              Reopen
            </Button>
          )}
          <Menu
            label="More"
            items={[
              { label: 'Edit…', onSelect: () => setDialog('edit') },
              { label: 'Delete…', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => setDialog('delete') },
            ]}
          />
        </div>
      </header>

      <div className="flex flex-col gap-4">
        <Card className="p-4 sm:p-5">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-4 @lg:gap-x-6">
            <Select label="Status" value={t.status} disabled={busy} onChange={(v) => void change({ status: v as TicketStatus })} options={TICKET_STATUSES.map((s) => ({ value: s, label: TICKET_STATUS_LABEL[s] }))} />
            <Select label="Priority" value={t.priority} disabled={busy} onChange={(v) => void change({ priority: v as TicketPriority })} options={TICKET_PRIORITIES.map((p) => ({ value: p, label: TICKET_PRIORITY_LABEL[p] }))} />
            <Select label="Type" value={t.type} disabled={busy} onChange={(v) => void change({ type: v as TicketType })} options={TICKET_TYPES.map((x) => ({ value: x, label: TICKET_TYPE_LABEL[x] }))} />
            {/* T-1967: a move takes the next number there; the old key keeps opening this ticket. */}
            {t.bucket && buckets.length > 0 && (
              <Select
                label="Bucket"
                value={t.bucket}
                disabled={busy}
                onChange={(v) => void change({ bucket: v }, `Moved to ${v}`)}
                hint={wide ? undefined : buckets.find((b) => b.key === t.bucket)?.name}
                options={(buckets.some((b) => b.key === t.bucket) ? buckets : [...buckets, { key: t.bucket, name: t.bucket } as TicketBucket]).map((b) => ({ value: b.key, label: bucketOption(b, wide) }))}
              />
            )}
            <Field label="Workspace">
              <p className="flex min-h-11 flex-wrap items-center gap-x-2 text-[14px]">
                {t.workspaceId ?? <span className="text-muted">Shared queue</span>}
                {t.worktree && (
                  <span className="inline-flex items-center gap-1 text-[12.5px] text-muted" title={t.worktree.path}>
                    <GitBranch className="size-3.5" /> {t.worktree.branch}
                  </span>
                )}
              </p>
            </Field>
            <Field label="Assigned to" className="col-span-2 @lg:col-span-1">
              <div className="flex h-11 items-center justify-between gap-2">
                <AssigneeChip ticket={t} />
                <Button size="sm" variant="secondary" onClick={() => setDialog('assign')}>
                  Change
                </Button>
              </div>
            </Field>
            <Field label="Tags" className="col-span-2 @lg:col-span-1">
              <div className="flex min-h-11 items-center justify-between gap-2">
                {t.tags.length ? <TagList tags={t.tags} /> : <span className="text-[13px] text-muted">None</span>}
                <Button size="sm" variant="secondary" onClick={() => setDialog('tags')}>
                  Edit
                </Button>
              </div>
            </Field>
            <Field label="Reported by">
              <p className="min-h-6 text-[14px]">
                {t.reporter.kind === 'ui' ? 'You' : t.reporter.kind === 'system' ? 'The portal' : `${t.reporter.label}${t.reporter.workspaceId ? ` in ${t.reporter.workspaceId}` : ''}`}
              </p>
            </Field>
          </dl>
        </Card>

        <Card className="p-4 sm:p-5">
          <h2 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-muted">
            Description {t.source === 'agent' && <Badge>Written by an agent</Badge>}
          </h2>
          {t.description ? <Markdown text={t.description} className="max-w-measure text-[14.5px] leading-relaxed" /> : <p className="text-sm text-muted">No description.</p>}
          {closed && t.closingSummary && (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="mb-1 text-[13px] font-semibold text-muted">Outcome</h3>
              <Markdown text={t.closingSummary} className="max-w-measure text-[14.5px] leading-relaxed" />
            </div>
          )}
        </Card>

        <Attachments ticketId={t.id} attachments={detail.attachments ?? []} onChanged={load} />

        {detail.sessions.length > 0 && (
          <Card className="p-4 sm:p-5">
            <h2 className="mb-2 text-[13px] font-semibold text-muted">Agents</h2>
            <ul className="divide-y divide-line">
              {detail.sessions.map((s) => (
                <li key={s.id}>
                  <Link to={`/admin/sessions/${s.id}`} className="flex items-center gap-3 rounded-lg py-2.5 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
                    <Bot className="size-4 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{s.title}</span>
                      <span className="block truncate text-[12.5px] text-muted">
                        {s.workspaceId}
                        {s.worktree ? ` · ${s.worktree.branch}` : ''}
                      </span>
                    </span>
                    <Badge tone={s.state === 'ended' ? 'neutral' : s.state === 'waiting' ? 'warning' : 'success'}>{SESSION_STATE_LABEL[s.state]}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Timeline events={detail.events} onChanged={load} ticketId={t.id} />
      </div>

      <EditTicketDialog ticket={dialog === 'edit' ? t : null} onClose={() => setDialog(null)} onSaved={done('Saved')} />
      <TagsDialog ticket={dialog === 'tags' ? t : null} onClose={() => setDialog(null)} onSaved={done('Tags saved')} />
      <AssignDialog ticket={dialog === 'assign' ? t : null} onClose={() => setDialog(null)} onSaved={done('Assigned')} />
      <CloseDialog ticket={dialog === 'close' ? t : null} onClose={() => setDialog(null)} onClosed={done(`${ticketLabel(t)} closed`)} />
      <StartSessionDialog
        ticket={dialog === 'start' ? t : null}
        onClose={() => setDialog(null)}
        onStarted={(r) => {
          setDialog(null);
          toast(`Agent started for ${ticketLabel(t)}`);
          navigate(`/admin/sessions/${r.session.id}`);
        }}
      />
      <TicketBumpDialog
        ticket={dialog === 'bump' ? t : null}
        onClose={() => setDialog(null)}
        onBumped={(r) => {
          setDialog(null);
          toast(`Bumped into ${r.session.title || 'the agent'}`);
          void load();
        }}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        title={`Delete ${ticketLabel(t)}?`}
        description="Removes it and its timeline for good."
        confirmLabel="Delete"
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await ticketsApi.remove(t.id);
            toast(`${ticketLabel(t)} deleted`);
            navigate('/admin/tickets');
          } catch (e) {
            toast(errorText(e, 'Couldn’t delete it.'), 'error');
            setBusy(false);
          }
        }}
        onClose={() => !busy && setDialog(null)}
      />
    </>
  );
}

/**
 * Back to the queue (the address keeps its view and filters). Beside the queue it is a Close at the panel's top right instead, and
 * the panel's top is the ticket's own header.
 */
function Back() {
  const { split } = usePanel();
  const { search } = useLocation();
  const to = { pathname: '/admin/tickets', search };
  if (split)
    return (
      <div className="sticky top-0 z-10 -mb-11 flex justify-end">
        <Link to={to} aria-label="Close panel" title="Close panel" className="press flex size-11 items-center justify-center rounded-full bg-bg text-muted hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
          <X className="size-5" />
        </Link>
      </div>
    );
  return (
    <Link to={to} className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink tap:-mt-3 tap:mb-0 tap:min-h-11">
      <ChevronLeft className="size-4" />
      Tickets
    </Link>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ''}`}>
      <dt className="text-[13px] font-semibold text-ink-soft">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** One entry as a sentence: who did what. Comments are shown in full by the timeline itself. */
function sentence(e: TicketEvent): string {
  const who = actorName(e.actor, e.actorLabel);
  const d = (e.data ?? {}) as Record<string, unknown> & { from?: unknown; to?: unknown };
  const label = (v: unknown, map: Record<string, string>) => (typeof v === 'string' ? (map[v] ?? v) : '');
  const assignee = (v: unknown) => {
    const a = v as { kind?: string; name?: string; sessionId?: string } | null;
    return !a ? 'the agents’ queue' : a.kind === 'user' ? (a.name === 'admin' ? 'you' : (a.name ?? 'a person')) : 'an agent';
  };
  switch (e.kind) {
    case 'created':
      return `${who} created this ticket`;
    case 'status':
      return `${who} moved it from ${label(d.from, TICKET_STATUS_LABEL)} to ${label(d.to, TICKET_STATUS_LABEL)}`;
    case 'closed':
      return `${who} closed it as ${label(d.to, TICKET_STATUS_LABEL)}`;
    case 'reopened':
      return `${who} reopened it`;
    case 'priority':
      return `${who} set the priority to ${label(d.to, TICKET_PRIORITY_LABEL)}`;
    case 'type':
      return `${who} set the type to ${label(d.to, TICKET_TYPE_LABEL)}`;
    case 'summary':
      return `${who} retitled it`;
    case 'description':
      return `${who} edited the description`;
    case 'tags':
      return `${who} set the tags to ${Array.isArray(d.to) && d.to.length ? (d.to as string[]).join(', ') : 'none'}`;
    case 'workspace':
      return `${who} put it in ${typeof d.to === 'string' ? d.to : 'the shared queue'}`;
    case 'assigned':
      if (d.fallback) return fallbackSentence(who, d);
      return d.claimed ? `${who} claimed it` : `${who} assigned it to ${assignee(d.to)}`;
    case 'session_started':
      return `${who} started an agent for it`;
    case 'bumped':
      return `${who} bumped it into ${typeof d.sessionTitle === 'string' && d.sessionTitle ? `“${d.sessionTitle}”` : 'an agent'} (${d.mode === 'prioritise' ? BUMP_MODE_LABEL.prioritise : BUMP_MODE_LABEL.ask})`;
    case 'session_ended':
      return `The agent ended${typeof d.reason === 'string' && d.reason ? `: ${d.reason}` : ''}`;
    case 'attachment':
      return d.removed ? `${who} removed ${typeof d.name === 'string' ? d.name : 'a file'}` : `${who} attached ${typeof d.name === 'string' ? d.name : 'a file'}${typeof d.size === 'number' ? ` (${fileSize(d.size)})` : ''}`;
    case 'ci':
      return `${who}: ${typeof d.name === 'string' ? d.name : 'a check'} ${typeof d.state === 'string' ? d.state : 'changed'}`;
    case 'bucket':
      return `${who} moved it from ${typeof d.from === 'string' ? d.from : 'its bucket'} to ${typeof d.to === 'string' ? d.to : 'another bucket'}${d.merged ? ' (buckets merged)' : ''}`;
    default:
      return `${who} changed it`;
  }
}

function Timeline({ events, ticketId, onChanged }: { events: TicketEvent[]; ticketId: string; onChanged: () => Promise<void> | void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      await ticketsApi.comment(ticketId, { text });
      setText('');
      await onChanged();
    } catch (e) {
      toast(errorText(e, 'Couldn’t add the comment.'), 'error');
    } finally {
      setSending(false);
    }
  };
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-1 text-[13px] font-semibold text-muted">
        Timeline
        <InfoTip label="About the timeline">Agents working this ticket read your comments.</InfoTip>
      </h2>
      <ol className="flex flex-col gap-3">
        {events.map((e) =>
          e.kind === 'comment' ? (
            <li key={e.id} className="flex gap-3">
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-soft">{e.fromAgent ? <Bot className="size-4" /> : e.actor === 'system' ? <Circle className="size-3.5" /> : <User className="size-4" />}</span>
              <div className="min-w-0 flex-1 rounded-2xl border border-line bg-surface px-3.5 py-2.5">
                <p className="mb-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
                  <span className="font-semibold text-ink-soft">{actorName(e.actor, e.actorLabel)}</span>
                  {e.fromAgent && <Badge>Agent</Badge>}
                  <span title={formatDateTime(e.at)}>{timeAgo(e.at)}</span>
                </p>
                <Markdown text={e.body ?? ''} className="max-w-measure text-[14px] leading-relaxed" />
              </div>
            </li>
          ) : (
            <li key={e.id} className="flex items-start gap-3 text-[13px] text-muted">
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center">
                <span className="size-1.5 rounded-full bg-line-strong" />
              </span>
              <p className="min-w-0 flex-1 pt-0.5">
                {sentence(e)} · <span title={formatDateTime(e.at)}>{timeAgo(e.at)}</span>
                {(e.kind === 'closed' || e.kind === 'bumped') && e.body && <span className="mt-1 block rounded-xl bg-surface-2/60 px-3 py-2 [overflow-wrap:anywhere] text-ink-soft">{e.body}</span>}
              </p>
            </li>
          ),
        )}
      </ol>
      <div ref={end} />
      <div className="mt-4 flex flex-col gap-2">
        <textarea
          aria-label="Comment"
          rows={2}
          maxLength={TICKET_LIMITS.comment}
          placeholder="Add a comment"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send();
          }}
          className="w-full resize-y rounded-xl border border-line bg-surface px-3.5 py-2.5 text-base text-ink outline-hidden transition-[border-color,box-shadow] placeholder:text-muted/70 hover:border-line-strong focus:border-ink/40 focus:ring-4 focus:ring-[var(--ring)]"
        />
        <div className="flex justify-end">
          <Button icon={<MessageSquare className="size-4" />} loading={sending} disabled={!text.trim()} onClick={() => void send()}>
            Comment
          </Button>
        </div>
      </div>
    </Card>
  );
}
