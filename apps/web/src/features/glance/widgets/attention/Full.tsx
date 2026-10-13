import { Button, buttonClass, useToast } from '@isnanme/ui';
import type { GlanceApproval, GlanceCiRun, GlanceDeploy, GlanceTicket } from '@portal/contracts';
import { Check, Rocket, ShieldQuestion, Ticket, Workflow } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ApprovalBlock } from '@/features/chat/ApprovalBlock';
import { approvalControls } from '@/features/chat/approvalReview';
import { ClaudeSwatch } from '@/lib/usage';
import { GlanceList, GlanceRow } from '../../ui';
import type { GlanceFullProps } from '../../types';
import { respondTo } from '../shared/chatCall';
import { compactCount, shortAgo } from '../shared/format';
import { claudeKey } from '../shared/readings';
import { GlanceFailed, GlanceLine, GlanceSkeleton, StaleNote } from '../shared/states';
import { useEngaged, useSettling, useSteadyRows } from '../shared/steady';
import { reloadGlance, useGlance } from '../shared/store';
import { useNow } from '../shared/useNow';
import { approvalMode, approvalNote, approvalTitle, ciMeta, ciRunHref, ciTitle, deployMeta, deployTitle, PRIORITY_WORD, sessionHref, ticketHref } from './model';

/** How long an answered row keeps saying so before the snapshot is trusted again (the portal normally drops it within a second). */
const ANSWERED_MS = 8_000;

type Answer = 'allow' | 'deny';

const NO_APPROVALS: GlanceApproval[] = [];
const NO_TICKETS: GlanceTicket[] = [];
const NO_RUNS: GlanceCiRun[] = [];
const NO_DEPLOYS: GlanceDeploy[] = [];
const approvalKey = (a: GlanceApproval) => a.requestId;
const ticketKey = (t: GlanceTicket) => t.id;
const runKey = (r: GlanceCiRun) => r.id;
const deployKey = (d: GlanceDeploy) => d.id;

/**
 * Needs attention: the requests waiting on you with what each asks (the whole text, in a block that scrolls) and Allow or Deny right
 * here, the tickets assigned to a person, and the failed CI runs that still stand. Each item opens its source.
 *
 * The lists stay exactly as they are while the pointer is over them or focus is in them (QA A9): a request answered elsewhere stays in
 * its place, dimmed and inert, and a new one waits, until you let go (a popover that is anchored by its bottom edge would otherwise move
 * every row when one is added). The buttons that answer are also off for a moment after the list changes, so a press aimed at a row
 * that has just moved cannot allow another request.
 */
export function AttentionFull({ close }: GlanceFullProps) {
  const { data, failed, denied, stale, reload } = useGlance();
  const now = useNow();
  const toast = useToast();
  // Requests being answered, and the ones just answered (until the snapshot drops them).
  const [pending, setPending] = useState<ReadonlyMap<string, Answer>>(() => new Map());
  const [answered, setAnswered] = useState<ReadonlyMap<string, Answer>>(() => new Map());
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((x) => window.clearTimeout(x));
  }, []);
  const { engaged, bind } = useEngaged();
  const approvals = useSteadyRows(data?.attention.approvals.items ?? NO_APPROVALS, approvalKey, engaged, true);
  const tickets = useSteadyRows(data?.attention.tickets.items ?? NO_TICKETS, ticketKey, engaged, true);
  const runs = useSteadyRows(data?.attention.ci.items ?? NO_RUNS, runKey, engaged, true);
  const deploys = useSteadyRows(data?.attention.deploys.items ?? NO_DEPLOYS, deployKey, engaged, true);
  const settling = useSettling(approvals.map((r) => r.row.requestId));

  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  const att = data.attention;
  if (!att.approvals.ok && !att.deploys.ok && !att.tickets.ok && !att.ci.ok) return <GlanceFailed reload={reload} message="Could not read what needs attention." />;

  const answer = async (a: GlanceApproval, decision: Answer) => {
    setPending((m) => new Map(m).set(a.requestId, decision));
    try {
      await respondTo(a.sessionId, a.requestId, decision);
      setAnswered((m) => new Map(m).set(a.requestId, decision));
      const t = window.setTimeout(() => {
        timers.current.delete(t);
        setAnswered((m) => {
          if (!m.has(a.requestId)) return m;
          const next = new Map(m);
          next.delete(a.requestId);
          return next;
        });
      }, ANSWERED_MS);
      timers.current.add(t);
    } catch (e) {
      // Often "no longer open": it was answered somewhere else. Ask for the truth either way.
      toast(e instanceof Error ? e.message : 'That did not go through.', 'error');
      void reloadGlance();
    } finally {
      setPending((m) => {
        const next = new Map(m);
        next.delete(a.requestId);
        return next;
      });
    }
  };

  const listed = approvals.length > 0 || deploys.length > 0 || tickets.length > 0 || runs.length > 0;
  return (
    <>
      {stale && <StaleNote reload={reload} />}
      {att.count === 0 && !listed && att.approvals.ok && att.deploys.ok && att.tickets.ok && att.ci.ok && <GlanceLine>Nothing needs you.</GlanceLine>}
      {listed && (
        <div {...bind}>
          <GlanceList label="Needs attention">
            {approvals.map(({ row: a, gone }) => (
              <ApprovalRow
                key={a.requestId}
                a={a}
                now={now}
                close={close}
                busy={pending.get(a.requestId)}
                done={answered.get(a.requestId) ?? (gone ? 'gone' : undefined)}
                settling={settling}
                onAnswer={(d) => answer(a, d)}
              />
            ))}
            {deploys.map(({ row: d, gone }) => (
              <GlanceRow key={d.id} className={`p-0 ${gone ? 'opacity-60' : ''}`}>
                <ItemLink to={ciRunHref(d.id)} close={close} icon={<Rocket className="size-4 text-danger" />}>
                  <span dir="auto" title={deployTitle(d)} className="block truncate text-sm font-medium">
                    {deployTitle(d)}
                  </span>
                  <span dir="auto" className="block truncate text-xs text-muted tabular-nums">
                    {deployMeta(d)} · {shortAgo(d.startedAt, now)}
                  </span>
                </ItemLink>
              </GlanceRow>
            ))}
            {tickets.map(({ row: t, gone }) => (
              <GlanceRow key={t.id} className={`p-0 ${gone ? 'opacity-60' : ''}`}>
                <ItemLink to={ticketHref(t.id)} close={close} icon={<Ticket className="size-4 text-muted" />}>
                  <span dir="auto" title={t.summary} className="block truncate text-sm font-medium">
                    {t.summary}
                  </span>
                  <span className="block truncate text-xs text-muted tabular-nums">
                    <span className="font-mono">{t.id}</span> · <span className={t.priority === 'urgent' ? 'font-semibold text-danger' : undefined}>{PRIORITY_WORD[t.priority]}</span> · {shortAgo(t.updatedAt, now)}
                  </span>
                </ItemLink>
              </GlanceRow>
            ))}
            {runs.map(({ row: r, gone }) => (
              <GlanceRow key={r.id} className={`p-0 ${gone ? 'opacity-60' : ''}`}>
                <ItemLink to={ciRunHref(r.id)} close={close} icon={<Workflow className="size-4 text-danger" />}>
                  <span dir="auto" title={ciTitle(r)} className="block truncate text-sm font-medium">
                    {ciTitle(r)}
                  </span>
                  <span dir="auto" className="block truncate text-xs text-muted tabular-nums">
                    {ciMeta(r)} · {shortAgo(r.finishedAt, now)}
                  </span>
                </ItemLink>
              </GlanceRow>
            ))}
          </GlanceList>
        </div>
      )}
      <More to="/admin/sessions" close={close} n={att.approvals.count - att.approvals.items.length} what="approvals" />
      <More to="/admin/ci" close={close} n={att.deploys.count - att.deploys.items.length} what="deploys" />
      <More to="/admin/tickets?assignee=user" close={close} n={att.tickets.count - att.tickets.items.length} what="tickets" />
      <More to="/admin/ci" close={close} n={att.ci.count - att.ci.items.length} what="failed runs" />
      {(!att.approvals.ok || !att.deploys.ok || !att.tickets.ok || !att.ci.ok) && (
        <p role="status" className="pt-2 text-center text-xs text-muted">
          {[!att.approvals.ok && 'Requests', !att.deploys.ok && 'Deploys', !att.tickets.ok && 'Tickets', !att.ci.ok && 'CI'].filter(Boolean).join(', ')} could not be read.
        </p>
      )}
    </>
  );
}

/** A row that opens its source: an icon that says what kind it is, two lines. */
function ItemLink({ to, close, icon, children }: { to: string; close: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <Link to={to} onClick={close} className="press -mx-2 flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
      <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </Link>
  );
}

function More({ to, close, n, what }: { to: string; close: () => void; n: number; what: string }) {
  if (n <= 0) return null;
  return (
    <Link to={to} onClick={close} className="press mt-1 flex min-h-11 items-center justify-center rounded-xl text-xs text-muted hover:bg-surface-2 hover:text-ink">
      +{compactCount(n)} more {what}
    </Link>
  );
}

/**
 * One request waiting for an answer: what it asks, whole, in a block that scrolls; where from; and Allow and Deny. Allow only for a tool
 * request whose text is shown whole, and only once the block has been read to its end; otherwise the session opens first and Deny stays,
 * with one line saying why. The session's own approval card keeps the same rule (`approvalControls`). Once answered, or no longer
 * waiting, the row keeps its height and its text and says so where the buttons were, so nothing below it moves.
 */
function ApprovalRow({
  a,
  now,
  close,
  busy,
  done,
  settling,
  onAnswer,
}: {
  a: GlanceApproval;
  now: number;
  close: () => void;
  busy: Answer | undefined;
  done: Answer | 'gone' | undefined;
  settling: boolean;
  onAnswer: (d: Answer) => Promise<void>;
}) {
  // Whether the whole text has been in view: the block reports it (it fits, or the person scrolled to its end).
  const [read, setRead] = useState(false);
  const decide = approvalMode(a) === 'decide';
  const controls = approvalControls(a, read);
  const note = decide ? controls.note : approvalNote(a);
  const over = !!done;
  return (
    <li aria-label={approvalTitle(a)} className={`flex flex-col gap-2 py-3 ${over ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-2.5">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="flex min-w-0 items-baseline gap-1.5 text-sm">
            <span className="shrink-0 font-semibold">{a.title}</span>
            {a.agentName && (
              <span dir="auto" title={a.agentName} className="min-w-0 truncate font-normal text-muted">
                · {a.agentName}
              </span>
            )}
          </p>
          {a.full ? <ApprovalBlock text={a.full} onRead={setRead} /> : a.detail ? <p className="font-mono text-xs whitespace-pre-wrap text-ink-soft wrap-anywhere">{a.detail}</p> : null}
          {note && !over && (
            <p role="status" className="text-xs font-medium text-ink-soft">
              {note}
            </p>
          )}
          <Link to={sessionHref(a.sessionId)} onClick={close} className="flex min-w-0 items-center gap-1.5 text-xs text-muted hover:text-ink">
            {(a.claudeId || a.claudeName) && <ClaudeSwatch claudeId={claudeKey(a)} />}
            <span dir="auto" className="min-w-0 truncate">
              {a.sessionTitle}
            </span>
            <span className="shrink-0 tabular-nums">· {shortAgo(a.createdAt, now)}</span>
          </Link>
        </div>
      </div>
      <div className="flex min-h-8 items-center gap-2 pl-6.5 tap:min-h-11">
        {over ? (
          <span role="status" className="inline-flex items-center gap-2 text-sm text-muted">
            <Check className="size-4 shrink-0 text-accent" aria-hidden="true" />
            {done === 'allow' ? 'Allowed' : done === 'deny' ? 'Denied' : 'No longer waiting'}
          </span>
        ) : (
          <>
            {decide ? (
              <Button size="sm" variant="secondary" loading={busy === 'allow'} disabled={!!busy || !controls.allow || settling} onClick={() => onAnswer('allow')}>
                Allow
              </Button>
            ) : (
              <Link to={sessionHref(a.sessionId)} onClick={close} className={buttonClass('secondary', 'sm')}>
                Open to review
              </Link>
            )}
            <Button size="sm" variant="ghost" loading={busy === 'deny'} disabled={!!busy || settling} onClick={() => onAnswer('deny')}>
              Deny
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
