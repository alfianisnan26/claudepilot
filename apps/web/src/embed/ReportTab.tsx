import {
  REPORTER_LIMITS,
  TICKET_PRIORITY_LABEL,
  TICKET_TYPE_LABEL,
  type ReporterCaptureInput,
  type ReporterDuplicateCandidate,
  type ReporterFileMode,
  type ReporterReportTarget,
  type ReporterReviewComment,
  type ReporterTicket,
  type TicketPriority,
  type TicketType,
} from '@portal/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { SEVERITIES, countBySeverity, cropBox, pathnameOf } from '@/features/reporter/shared';
import type { ReporterClient } from './api';
import { usePanel, type Capture } from './context';
import { Icon } from './icons';
import { proposedSummary, sentText, ticketsFor } from './model';
import { AuthImg, Btn, Chip, Field, IconBtn, Notice, Seg, inputClass } from './ui';

const TYPES: TicketType[] = ['bug', 'feature', 'task', 'question'];
const PRIORITIES: TicketPriority[] = ['urgent', 'high', 'normal', 'low'];

const captureInput = (c: Capture, note: string | null): ReporterCaptureInput => ({ captureId: c.captureId, pageUrl: c.evidence.page.url, anchor: c.evidence.anchor, note });

/** Uploads a capture's screenshot and evidence; returns what failed (the ticket or comment exists either way). */
async function uploadCapture(attach: (captureId: string, kind: 'screenshot' | 'evidence', blob: Blob) => Promise<unknown>, c: Capture): Promise<string[]> {
  const failed: string[] = [];
  try {
    await attach(c.captureId, 'screenshot', c.screenshot);
  } catch {
    failed.push('screenshot');
  }
  const json = new Blob([JSON.stringify(c.evidence)], { type: 'application/json' });
  if (json.size > REPORTER_LIMITS.evidenceBytes) failed.push('evidence (too large)');
  else
    try {
      await attach(c.captureId, 'evidence', json);
    } catch {
      failed.push('evidence');
    }
  return failed;
}

export function ReportTab() {
  const p = usePanel();
  const [view, setView] = useState<'home' | 'review' | 'submit'>('home');
  const [alone, setAlone] = useState(false);
  useEffect(() => setAlone(false), [p.capture]);

  if (p.pending && !p.capture)
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <div className="skeleton size-12 rounded-full" aria-busy="true" />
        <p className="text-[14px] text-muted">Capturing…</p>
      </div>
    );
  if (p.capture) return p.review && !alone ? <CommentForm capture={p.capture} onAlone={() => setAlone(true)} /> : <QuickForm capture={p.capture} />;
  if (view === 'submit' && p.review) return <SubmitForm onBack={() => setView('review')} onDone={() => setView('home')} />;
  if (view === 'review' && p.review) return <ReviewView onBack={() => setView('home')} onFinish={() => setView('submit')} />;
  return <Home onOpenReview={() => setView('review')} />;
}

function CaptureButtons() {
  const { coarse, requestCapture, pending } = usePanel();
  const [precise, setPrecise] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Btn icon={coarse ? 'camera' : 'scan'} tone="primary" disabled={!!pending} onClick={() => requestCapture('full', precise)}>
          {coarse ? 'Snap' : 'Full page'}
        </Btn>
        <Btn icon="crop" tone="primary" disabled={!!pending} onClick={() => requestCapture('crop', precise)}>
          Crop
        </Btn>
      </div>
      {!coarse && (
        <label className="flex min-h-11 items-center gap-2 text-[13px] text-ink-soft">
          <input type="checkbox" checked={precise} onChange={(e) => setPrecise(e.target.checked)} className="size-5 accent-[var(--color-accent)]" />
          Precise (asks to share the tab)
        </label>
      )}
    </div>
  );
}

function Home({ onOpenReview }: { onOpenReview: () => void }) {
  const { review, client, build, sdkVersion, setReview, notify } = usePanel();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const r = await client.startReview({ build: build ?? { version: null, commit: null, branch: null, environment: null, builtAt: null, repo: null }, sdkVersion });
      setReview(r);
      notify('Review started: each shot is now a comment.', 'ok');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4 p-3">
      <CaptureButtons />
      {review ? (
        <button type="button" onClick={onOpenReview} className="flex items-center gap-3 rounded-2xl border border-dashed border-line-strong p-3 text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
          <Icon name="messageSquare" className="size-5 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold">{review.title || 'Draft review'}</span>
            <span className="block text-[12.5px] text-muted">
              {review.comments.length} {review.comments.length === 1 ? 'comment' : 'comments'} · draft, only you see it
            </span>
          </span>
          <Icon name="chevronRight" className="size-5 text-muted" />
        </button>
      ) : (
        <Btn icon="messageSquare" busy={busy} onClick={() => void start()}>
          Start review
        </Btn>
      )}
    </div>
  );
}

function Preview({ capture }: { capture: Capture }) {
  const [big, setBig] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const box = size ? cropBox(size, capture.evidence.anchor, capture.evidence.state?.scroll ?? null) : null;
  return (
    <button type="button" onClick={() => setBig(!big)} aria-label={big ? 'Smaller' : 'View big'} className="relative block w-full overflow-hidden rounded-xl border border-line bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
      <img
        src={capture.previewUrl}
        alt="Screenshot"
        onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        className={`w-full object-contain object-top ${big ? '' : 'max-h-40'}`}
      />
      {box && big && (
        <span aria-hidden="true" className="absolute rounded-sm border-2 border-danger" style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }} />
      )}
    </button>
  );
}

function ChecksChip({ capture }: { capture: Capture }) {
  const c = capture.evidence.checks;
  if (!c.ran) return <p className="text-[12.5px] text-muted">UI checks did not run{c.error ? `: ${c.error}` : ''}.</p>;
  const n = countBySeverity(c.findings);
  if (!c.findings.length) return <p className="text-[12.5px] text-accent">UI checks: nothing found.</p>;
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-[12px]" title={c.findings.slice(0, 8).map((f) => f.message).join('\n')}>
      <span className="text-muted">Checks</span>
      {SEVERITIES.filter((s) => n[s] > 0).map((s) => (
        <span key={s} className={`rounded-full px-2 py-0.5 font-semibold ${s === 'critical' || s === 'serious' ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-ink-soft'}`}>
          {n[s]} {s}
        </span>
      ))}
    </p>
  );
}

/** "Looks like KONF-12": similar open tickets before filing; Add to it puts this shot on that ticket. */
function Duplicates({ capture, onAdded }: { capture: Capture; onAdded: (key: string) => void }) {
  const { client, notify, refresh } = usePanel();
  const [list, setList] = useState<ReporterDuplicateCandidate[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client
      .duplicates({ path: capture.evidence.anchor.path, anchor: capture.evidence.anchor, errorSignatures: capture.evidence.errorSignatures })
      .then((c) => live && setList(c.slice(0, REPORTER_LIMITS.duplicateCandidates)), () => undefined);
    return () => {
      live = false;
    };
  }, [client, capture]);
  if (dismissed || !list.length) return null;
  const add = async (key: string) => {
    setBusy(key);
    try {
      await client.addCaptures(key, { captures: [captureInput(capture, null)] });
      const failed = await uploadCapture((id, kind, blob) => client.attach(key, id, kind, blob), capture);
      notify(failed.length ? `Added to ${key}; upload failed: ${failed.join(', ')}.` : `Added to ${key}.`, failed.length ? 'error' : 'ok');
      refresh();
      onAdded(key);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const REASON = { 'same-area': 'same area', 'same-element': 'same element', 'same-error': 'same error' } as const;
  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-gold bg-gold-soft p-2.5">
      <h3 className="px-1 text-[13px] font-bold">Looks like {list[0]!.key}</h3>
      {list.map((d) => (
        <div key={d.key} className="flex items-start gap-2 rounded-xl bg-surface p-2">
          <AuthImg client={client} src={d.thumbnailUrl} alt="" className="size-12 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-muted tabular-nums">
              {d.key} · {d.reasons.map((r) => REASON[r]).join(', ')}
            </p>
            <p className="line-clamp-2 text-[13.5px] font-semibold break-words">{d.summary}</p>
          </div>
          <Btn busy={busy === d.key} disabled={!!busy} onClick={() => void add(d.key)} className="shrink-0">
            Add to it
          </Btn>
        </div>
      ))}
      <Btn tone="ghost" onClick={() => setDismissed(true)}>
        Still new
      </Btn>
    </section>
  );
}

/** Ticket (the queue) or Session (urgent, straight to a lead); switchable any time before sending. */
function TargetSwitch({ value, onChange }: { value: ReporterReportTarget; onChange: (t: ReporterReportTarget) => void }) {
  const { targets } = usePanel();
  const usable = targets.filter((t) => t.available);
  const reason = !targets.length ? 'No session is set up for direct reports in this bucket.' : !usable.length ? (targets[0]?.reason ?? 'No target session is available now.') : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Seg
        label="Send to"
        value={value.kind}
        onChange={(k) => onChange(k === 'ticket' ? { kind: 'ticket' } : { kind: 'session', sessionId: usable[0]!.sessionId })}
        options={[
          { value: 'ticket', label: 'Ticket' },
          { value: 'session', label: 'Session', disabled: !usable.length, hint: reason },
        ]}
      />
      {reason && value.kind === 'ticket' && <p className="text-[12px] text-muted">{reason}</p>}
      {value.kind === 'session' && (
        <>
          {usable.length > 1 && (
            <select aria-label="Session" value={value.sessionId} onChange={(e) => onChange({ kind: 'session', sessionId: e.target.value })} className={inputClass}>
              {usable.map((t) => (
                <option key={t.sessionId} value={t.sessionId}>
                  {t.label} · {t.status}
                </option>
              ))}
            </select>
          )}
          <p className="text-[12px] text-ink-soft">Urgent: a ticket is filed and the session gets it in its chat right away.</p>
        </>
      )}
    </div>
  );
}

function TypePriority({ type, setType, priority, setPriority, urgent }: { type: TicketType; setType: (t: TicketType) => void; priority: TicketPriority; setPriority: (p: TicketPriority) => void; urgent: boolean }) {
  return (
    <>
      <div role="group" aria-label="Type" className="flex flex-wrap gap-1.5">
        {TYPES.map((t) => (
          <Chip key={t} on={type === t} onClick={() => setType(t)}>
            {TICKET_TYPE_LABEL[t]}
          </Chip>
        ))}
      </div>
      {!urgent && (
        <div role="group" aria-label="Priority" className="flex flex-wrap gap-1.5">
          {PRIORITIES.map((v) => (
            <Chip key={v} on={priority === v} onClick={() => setPriority(v)}>
              {TICKET_PRIORITY_LABEL[v]}
            </Chip>
          ))}
        </div>
      )}
    </>
  );
}

function Sticky({ children }: { children: ReactNode }) {
  return <div className="sticky bottom-0 -mx-3 mt-auto flex gap-2 border-t border-line bg-bg px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">{children}</div>;
}

/** The quick path: one shot, one ticket. */
function QuickForm({ capture }: { capture: Capture }) {
  const { client, setCapture, refresh, notify, setTab, select, sdkVersion, targets, setReview, build } = usePanel();
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<TicketType>('bug');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [target, setTarget] = useState<ReporterReportTarget>({ kind: 'ticket' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (target.kind === 'session' && !targets.some((t) => t.sessionId === target.sessionId && t.available)) setTarget({ kind: 'ticket' });
  }, [targets, target]);

  const submit = async () => {
    if (!summary.trim()) return setError('Write a short summary.');
    setBusy(true);
    setError(null);
    try {
      const res = await client.createTicket({
        summary: summary.trim(),
        description,
        type,
        priority: target.kind === 'session' ? 'urgent' : priority,
        tags: [],
        captures: [captureInput(capture, null)],
        build: capture.evidence.build,
        sdkVersion: sdkVersion || capture.evidence.sdkVersion,
        target,
      });
      const failed = await uploadCapture((id, kind, blob) => client.attach(res.key, id, kind, blob), capture);
      const msg = sentText([res.key], target, res.sessionDelivery, failed);
      notify(msg.text, msg.tone);
      setCapture(null);
      refresh();
      select(res.key);
      setTab('tickets');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toReview = async () => {
    setBusy(true);
    try {
      const r = await client.startReview({ title: summary.trim() || undefined, build: build ?? capture.evidence.build, sdkVersion: sdkVersion || capture.evidence.sdkVersion });
      setReview(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex min-h-full flex-col gap-3 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-1">
        <IconBtn icon="x" label="Discard shot" onClick={() => setCapture(null)} />
        <h2 className="flex-1 text-[15px] font-bold">Report</h2>
        <Btn tone="ghost" icon="messageSquare" disabled={busy} onClick={() => void toReview()}>
          Review
        </Btn>
      </div>
      <Preview capture={capture} />
      <ChecksChip capture={capture} />
      <Duplicates
        capture={capture}
        onAdded={(key) => {
          setCapture(null);
          select(key);
          setTab('tickets');
        }}
      />
      <Field label="Summary">
        <input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={200} className={inputClass} placeholder="What is wrong here?" />
      </Field>
      <Field label="Details">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={8000} className={`${inputClass} resize-y`} />
      </Field>
      <TypePriority type={type} setType={setType} priority={priority} setPriority={setPriority} urgent={target.kind === 'session'} />
      <TargetSwitch value={target} onChange={setTarget} />
      {error && <Notice tone="error">{error}</Notice>}
      <Sticky>
        <Btn type="submit" tone={target.kind === 'session' ? 'danger' : 'primary'} busy={busy} className="flex-1" icon="send">
          {target.kind === 'session' ? 'Send now' : 'File ticket'}
        </Btn>
      </Sticky>
    </form>
  );
}

/** With a draft review open, a shot becomes a comment (like a line comment on a pull request). */
function CommentForm({ capture, onAlone }: { capture: Capture; onAlone: () => void }) {
  const { client, review, setCapture, reloadReview, notify } = usePanel();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!review) return null;
  const full = review.comments.length >= REPORTER_LIMITS.reviewComments;
  const submit = async () => {
    if (!body.trim()) return setError('Write the comment.');
    setBusy(true);
    setError(null);
    try {
      await client.addComment(review.id, { capture: captureInput(capture, null), body: body.trim() });
      const failed = await uploadCapture((id, kind, blob) => client.reviewAttach(review.id, id, kind, blob), capture);
      if (failed.length) notify(`Comment added; upload failed: ${failed.join(', ')}.`, 'error');
      setCapture(null);
      await reloadReview();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex min-h-full flex-col gap-3 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-1">
        <IconBtn icon="x" label="Discard shot" onClick={() => setCapture(null)} />
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-bold">Comment</h2>
        <Btn tone="ghost" onClick={onAlone}>
          File alone
        </Btn>
      </div>
      <p className="text-[12.5px] text-muted">
        {review.title || 'Draft review'} · {review.comments.length + 1}
      </p>
      <Preview capture={capture} />
      <ChecksChip capture={capture} />
      <Duplicates
        capture={capture}
        onAdded={() => {
          setCapture(null);
        }}
      />
      <Field label="Comment">
        <textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={REPORTER_LIMITS.commentChars} className={`${inputClass} resize-y`} placeholder="What should change here?" />
      </Field>
      {full && <Notice tone="error">This review is full ({REPORTER_LIMITS.reviewComments} comments). Finish it first.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <Sticky>
        <Btn type="submit" tone="primary" busy={busy} disabled={full} className="flex-1" icon="plus">
          Add comment
        </Btn>
      </Sticky>
    </form>
  );
}

function ReviewView({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) {
  const { client, review, setReview, reloadReview, notify, focus, post } = usePanel();
  const [title, setTitle] = useState(review?.title ?? '');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!review) return null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await reloadReview();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    setBusy(true);
    try {
      await client.discardReview(review.id);
      setReview(null);
      post({ type: 'pilot-reporter:tray', count: 0 });
      notify('Review discarded');
      onBack();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const comments = [...review.comments].sort((a, b) => a.index - b.index);

  return (
    <div className="flex min-h-full flex-col gap-3 p-3">
      <div className="flex items-center gap-1">
        <IconBtn icon="chevronLeft" label="Back" onClick={onBack} />
        <h2 className="flex-1 text-[15px] font-bold">Review</h2>
      </div>
      <Field label="Title">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== review.title && void act(() => client.renameReview(review.id, title.trim()))}
          maxLength={200}
          className={inputClass}
          placeholder="Landing page pass"
        />
      </Field>
      <CaptureButtons />
      {comments.length === 0 && <p className="text-[13px] text-muted">No comments yet. Take a shot to add one.</p>}
      <ol className="flex flex-col gap-2">
        {comments.map((c, i) => (
          <CommentRow
            key={c.captureId}
            c={c}
            client={client}
            editing={editing === c.captureId}
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            first={i === 0}
            last={i === comments.length - 1}
            onShow={() => focus(review.id, c.captureId)}
            onEdit={() => {
              setEditing(c.captureId);
              setDraft(c.body);
            }}
            onSave={() =>
              void act(async () => {
                await client.updateComment(review.id, c.captureId, { body: draft.trim() });
                setEditing(null);
              })
            }
            onCancel={() => setEditing(null)}
            onMove={(d) => void act(() => client.updateComment(review.id, c.captureId, { index: c.index + d }))}
            onDelete={() => void act(() => client.deleteComment(review.id, c.captureId))}
          />
        ))}
      </ol>
      {confirm ? (
        <div className="flex flex-col gap-2 rounded-2xl bg-danger-soft p-3">
          <p className="text-[13.5px] font-semibold text-danger">Discard this review and its {comments.length} comments?</p>
          <div className="flex gap-2">
            <Btn tone="danger" busy={busy} onClick={() => void discard()} className="flex-1">
              Discard
            </Btn>
            <Btn onClick={() => setConfirm(false)} className="flex-1">
              Keep
            </Btn>
          </div>
        </div>
      ) : (
        <Sticky>
          <Btn tone="ghost" icon="trash2" onClick={() => setConfirm(true)} aria-label="Discard review" />
          <Btn tone="primary" disabled={!comments.length} onClick={onFinish} className="flex-1">
            Finish review
          </Btn>
        </Sticky>
      )}
    </div>
  );
}

function CommentRow(props: {
  c: ReporterReviewComment;
  client: ReporterClient;
  editing: boolean;
  draft: string;
  setDraft: (v: string) => void;
  busy: boolean;
  first: boolean;
  last: boolean;
  onShow: () => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onMove: (d: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { c, client } = props;
  return (
    <li className="rounded-2xl border border-dashed border-line-strong p-2">
      <div className="flex items-start gap-2">
        <button type="button" onClick={props.onShow} aria-label={`Show comment ${c.index} on the page`} className="shrink-0 rounded-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
          <AuthImg client={client} src={c.screenshotUrl} alt="" className="size-14 rounded-lg" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] break-all text-muted">
            {c.index} · {pathnameOf(c.anchor.path)}
          </p>
          {props.editing ? (
            <textarea value={props.draft} onChange={(e) => props.setDraft(e.target.value)} rows={3} maxLength={REPORTER_LIMITS.commentChars} aria-label="Comment" className={`${inputClass} mt-1 resize-y`} />
          ) : (
            <p className="line-clamp-3 text-[13.5px] break-words whitespace-pre-line">{c.body}</p>
          )}
        </div>
      </div>
      <div className="mt-1 flex justify-end gap-0.5">
        {props.editing ? (
          <>
            <Btn tone="ghost" onClick={props.onCancel}>
              Cancel
            </Btn>
            <Btn tone="primary" busy={props.busy} disabled={!props.draft.trim()} onClick={props.onSave}>
              Save
            </Btn>
          </>
        ) : (
          <>
            <IconBtn icon="arrowUp" label="Move up" disabled={props.first || props.busy} onClick={() => props.onMove(-1)} />
            <IconBtn icon="arrowDown" label="Move down" disabled={props.last || props.busy} onClick={() => props.onMove(1)} />
            <IconBtn icon="pencil" label="Edit" onClick={props.onEdit} />
            <IconBtn icon="trash2" label="Delete" disabled={props.busy} onClick={props.onDelete} />
          </>
        )}
      </div>
    </li>
  );
}

/** Finish review: how the comments become tickets (one, one per page, one per comment) or join an open ticket. */
function SubmitForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { client, review, setReview, refresh, notify, setTab, select, targets, post } = usePanel();
  const [summary, setSummary] = useState(() => (review ? proposedSummary(review) : ''));
  const [description, setDescription] = useState('');
  const [type, setType] = useState<TicketType>('bug');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [tags, setTags] = useState('');
  const [mode, setMode] = useState<ReporterFileMode | 'existing'>('single');
  const [existing, setExisting] = useState('');
  const [open, setOpen] = useState<ReporterTicket[]>([]);
  const [target, setTarget] = useState<ReporterReportTarget>({ kind: 'ticket' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== 'existing' || open.length) return;
    client.tickets({ status: 'open', sort: 'updated', order: 'desc', limit: 50 }).then((l) => setOpen(l.items), () => undefined);
  }, [mode, open.length, client]);
  useEffect(() => {
    if (target.kind === 'session' && !targets.some((t) => t.sessionId === target.sessionId && t.available)) setTarget({ kind: 'ticket' });
  }, [targets, target]);
  if (!review) return null;
  const count = mode === 'existing' ? 0 : ticketsFor(review, mode);

  const submit = async () => {
    if (mode !== 'existing' && !summary.trim()) return setError('Write a short summary.');
    if (mode === 'existing' && !existing) return setError('Pick the ticket to add to.');
    setBusy(true);
    setError(null);
    try {
      const res = await client.submitReview(review.id, {
        summary: summary.trim(),
        description,
        type,
        priority: target.kind === 'session' ? 'urgent' : priority,
        tags: tags
          .split(/[,\s]+/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 10),
        mode: mode === 'existing' ? 'single' : mode,
        ...(mode === 'existing' ? { targetTicketKey: existing } : {}),
        target,
      });
      const keys = res.ticketKeys ?? [];
      const msg = sentText(keys.length ? keys : [existing], target, res.sessionDelivery, []);
      notify(msg.text, msg.tone);
      setReview(null);
      post({ type: 'pilot-reporter:tray', count: 0 });
      refresh();
      onDone();
      if (keys.length === 1) select(keys[0]!);
      setTab('tickets');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex min-h-full flex-col gap-3 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-1">
        <IconBtn icon="chevronLeft" label="Back" onClick={onBack} />
        <h2 className="flex-1 text-[15px] font-bold">Submit</h2>
        <span className="text-[12.5px] text-muted tabular-nums">{review.comments.length} comments</span>
      </div>
      <Field label="Make">
        <select value={mode} onChange={(e) => setMode(e.target.value as ReporterFileMode | 'existing')} className={inputClass}>
          <option value="single">One ticket</option>
          <option value="per-page">One per page ({ticketsFor(review, 'per-page')})</option>
          <option value="per-capture">One per comment ({review.comments.length})</option>
          <option value="existing">Add to an open ticket</option>
        </select>
      </Field>
      {mode === 'existing' ? (
        <Field label="Ticket">
          <select value={existing} onChange={(e) => setExisting(e.target.value)} className={inputClass}>
            <option value="">Pick one</option>
            {open.map((t) => (
              <option key={t.key} value={t.key}>
                {t.key} · {t.summary}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <>
          <Field label="Summary">
            <input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={200} className={inputClass} />
          </Field>
          <Field label="Overall">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={8000} className={`${inputClass} resize-y`} />
          </Field>
          <TypePriority type={type} setType={setType} priority={priority} setPriority={setPriority} urgent={target.kind === 'session'} />
          <Field label="Tags">
            <input value={tags} onChange={(e) => setTags(e.target.value)} className={inputClass} autoCapitalize="none" placeholder="landing, mobile" />
          </Field>
        </>
      )}
      <TargetSwitch value={target} onChange={setTarget} />
      {error && <Notice tone="error">{error}</Notice>}
      <Sticky>
        <Btn type="submit" tone={target.kind === 'session' ? 'danger' : 'primary'} busy={busy} className="flex-1" icon="send">
          {mode === 'existing' ? `Add to ${existing || 'ticket'}` : count === 1 ? (target.kind === 'session' ? 'Send now' : 'Submit') : `Submit ${count} tickets`}
        </Btn>
      </Sticky>
    </form>
  );
}
