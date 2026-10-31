import {
  REPORTER_LIMITS,
  TICKET_PRIORITY_LABEL,
  TICKET_TYPE_LABEL,
  type ReporterCaptureInput,
  type ReporterCaptureMode,
  type ReporterDuplicateCandidate,
  type ReporterFileMode,
  type ReporterReportTarget,
  type ReporterReviewComment,
  type ReporterTicket,
  type TicketPriority,
  type TicketType,
} from '@portal/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { SEVERITIES, countBySeverity, shotCaption } from '@/features/reporter/shared';
import type { ReporterClient } from './api';
import { usePanel, type Capture } from './context';
import { Icon, type IconName } from './icons';
import { afterFiled, elementLabel, reportProblem, sendButton, suggestTitle } from './formModel';
import { pickTarget, proposedSummary, sentText, ticketsFor } from './model';
import { Viewer } from './Viewer';
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
  const [filed, setFiled] = useState<string | null>(null);
  useEffect(() => setAlone(false), [p.capture?.captureId]);
  useEffect(() => {
    if (p.capture) setFiled(null);
  }, [p.capture]);

  if (p.pending && !p.capture)
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <div className="skeleton size-12 rounded-full" aria-busy="true" />
        <p className="text-[14px] text-muted">Capturing…</p>
      </div>
    );
  if (p.capture) return p.review && !alone ? <CommentForm capture={p.capture} onAlone={() => setAlone(true)} /> : <QuickForm onFiled={setFiled} />;
  if (view === 'submit' && p.review) return <SubmitForm onBack={() => setView('review')} onDone={() => setView('home')} />;
  if (view === 'review' && p.review) return <ReviewView onBack={() => setView('home')} onFinish={() => setView('submit')} />;
  return (
    <>
      {filed && <Filed ticketKey={filed} onDone={() => setFiled(null)} />}
      <Home onOpenReview={() => setView('review')} />
    </>
  );
}

/** After filing to the queue: the key (copy), View, Report another. No full-screen confirmation; the callout is on the page already. */
export function Filed({ ticketKey, onDone }: { ticketKey: string; onDone: () => void }) {
  const { select, setTab, notify } = usePanel();
  return (
    <div role="status" className="m-3 mb-0 flex flex-wrap items-center gap-1 rounded-2xl bg-accent-soft py-1 pr-1 pl-3">
      <Icon name="check" className="size-4 text-accent" />
      <span className="min-w-0 flex-1 text-[14px] font-semibold whitespace-nowrap">
        Filed <span className="whitespace-nowrap tabular-nums">{ticketKey}</span>
      </span>
      <IconBtn
        icon="copy"
        label={`Copy ${ticketKey}`}
        onClick={() =>
          void navigator.clipboard?.writeText(ticketKey).then(
            () => notify('Copied', 'ok'),
            () => notify('Copy is blocked here.', 'error'),
          )
        }
      />
      <Btn
        tone="ghost"
        onClick={() => {
          select(ticketKey);
          setTab('tickets');
          onDone();
        }}
      >
        View
      </Btn>
      <Btn tone="ghost" onClick={onDone}>
        Report another
      </Btn>
    </div>
  );
}

/**
 * Screen (what is on screen, the default) | Whole page (desktop only) | Crop: one compact group, each starts that capture. `append` adds
 * the shot to the report being written (the strip's "+").
 */
export function CaptureButtons({ append = false, onPicked }: { append?: boolean; onPicked?: () => void }) {
  const { coarse, requestCapture, pending } = usePanel();
  const [precise, setPrecise] = useState(false);
  const go = (mode: ReporterCaptureMode) => {
    requestCapture(mode, precise, append);
    onPicked?.();
  };
  const modes: { mode: ReporterCaptureMode; label: string; icon: IconName }[] = [
    { mode: 'viewport', label: 'Screen', icon: coarse ? 'camera' : 'scan' },
    ...(coarse ? [] : [{ mode: 'full' as const, label: 'Whole page', icon: 'arrowUpDown' as const }]),
    { mode: 'crop', label: 'Crop', icon: 'crop' },
  ];
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label="Capture" className="flex gap-0.5 rounded-xl bg-surface-2 p-0.5">
        {modes.map((m, i) => (
          <button
            key={m.mode}
            type="button"
            disabled={!!pending}
            onClick={() => go(m.mode)}
            className={`inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-[10px] px-2 text-[13.5px] font-semibold focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden disabled:opacity-50 ${i === 0 ? 'bg-primary text-primary-ink' : 'text-ink'}`}
          >
            <Icon name={m.icon} className="size-[18px]" />
            {m.label}
          </button>
        ))}
      </div>
      {!coarse && !append && (
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

/** The report's shots as a strip: tap opens the viewer, × removes one, "+" adds another (Screen or Crop). */
function ShotStrip({ shots, onRemove, canAdd }: { shots: Capture[]; onRemove?: (id: string) => void; canAdd: boolean }) {
  const [view, setView] = useState<Capture | null>(null);
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <ul className="flex items-start gap-2 overflow-x-auto pt-1 pb-1">
        {shots.map((c, i) => (
          <li key={c.captureId} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setView(c)}
              aria-label={`View shot ${i + 1}`}
              className="block size-20 overflow-hidden rounded-xl border border-line bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
            >
              <img src={c.previewUrl} alt="" className="size-full object-cover object-top" />
            </button>
            {onRemove && (
              <button
                type="button"
                aria-label={`Remove shot ${i + 1}`}
                onClick={() => onRemove(c.captureId)}
                className="absolute -top-3 -right-3 inline-flex size-11 items-center justify-center focus-visible:outline-hidden"
              >
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-ink text-bg shadow">
                  <Icon name="x" className="size-3.5" />
                </span>
              </button>
            )}
          </li>
        ))}
        {canAdd && (
          <li className="shrink-0">
            <button
              type="button"
              aria-label="Add a shot"
              aria-expanded={adding}
              onClick={() => setAdding(!adding)}
              className="inline-flex size-20 items-center justify-center rounded-xl border border-dashed border-line-strong text-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
            >
              <Icon name="plus" />
            </button>
          </li>
        )}
      </ul>
      {adding && (
        <div className="mt-1">
          <CaptureButtons append onPicked={() => setAdding(false)} />
        </div>
      )}
      {view && (
        <Viewer
          src={view.previewUrl}
          alt={`Shot ${shots.indexOf(view) + 1}`}
          crop={{ anchor: view.evidence.anchor, scroll: view.evidence.state?.scroll ?? null }}
          onClose={() => setView(null)}
        />
      )}
    </div>
  );
}

function ChecksChip({ capture }: { capture: Capture }) {
  const c = capture.evidence.checks;
  // Only findings earn a line (UX review): "did not run" and "nothing found" say nothing here.
  if (!c.ran) return null;
  const n = countBySeverity(c.findings);
  if (!c.findings.length) return null;
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

/** "Looks like KONF-12 · Add to it": one slim line above the send area, never a blocker. */
function Duplicates({ shots, onAdded }: { shots: Capture[]; onAdded: (key: string) => void }) {
  const { client, notify, refresh } = usePanel();
  const capture = shots[0]!;
  const [list, setList] = useState<ReporterDuplicateCandidate[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    client
      .duplicates({ path: capture.evidence.anchor.path, anchor: capture.evidence.anchor, errorSignatures: capture.evidence.errorSignatures })
      .then((c) => live && setList(c.slice(0, REPORTER_LIMITS.duplicateCandidates)), () => undefined);
    return () => {
      live = false;
    };
  }, [client, capture]);
  const d = list[0];
  if (dismissed || !d) return null;
  const add = async () => {
    setBusy(true);
    try {
      await client.addCaptures(d.key, { captures: shots.map((c) => captureInput(c, null)) });
      const failed: string[] = [];
      for (const c of shots) failed.push(...(await uploadCapture((id, kind, blob) => client.attach(d.key, id, kind, blob), c)));
      notify(failed.length ? `Added to ${d.key}; upload failed: ${failed.join(', ')}.` : `Added to ${d.key}.`, failed.length ? 'error' : 'ok');
      refresh();
      onAdded(d.key);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-11 items-center gap-1 rounded-xl bg-gold-soft pl-3 text-[13px]" title={d.summary}>
      <span className="min-w-0 flex-1 truncate">
        Looks like <span className="font-semibold whitespace-nowrap tabular-nums">{d.key}</span>
        <span className="text-muted"> · {d.summary}</span>
      </span>
      <Btn tone="ghost" busy={busy} onClick={() => void add()} className="shrink-0 text-accent">
        Add to it
      </Btn>
      <IconBtn icon="x" label="Still new" onClick={() => setDismissed(true)} />
    </div>
  );
}

/**
 * Where the report goes, right above the button: Queue (a ticket) | Ask lead now (a session). Session mode names the target with its live
 * state (a picker when there are several) and says a ticket is kept for tracking. The SDK toolbar follows it (pilot-reporter:target).
 */
export function Destination({ value, onChange }: { value: ReporterReportTarget; onChange: (t: ReporterReportTarget) => void }) {
  const { targets } = usePanel();
  const usable = targets.filter((t) => t.available);
  const reason = !targets.length ? 'No lead session is set up for this bucket.' : !usable.length ? (targets[0]?.reason ?? 'No lead session is available now.') : undefined;
  const current = value.kind === 'session' ? targets.find((t) => t.sessionId === value.sessionId) : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Seg
        label="Destination"
        value={value.kind}
        onChange={(k) => onChange(k === 'ticket' ? { kind: 'ticket' } : { kind: 'session', sessionId: usable[0]!.sessionId })}
        options={[
          { value: 'ticket', label: 'Queue' },
          { value: 'session', label: 'Ask lead now', disabled: !usable.length, hint: reason },
        ]}
      />
      {value.kind === 'session' && (
        <div className="flex min-h-11 items-center gap-2 px-1">
          <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${current?.status === 'working' ? 'bg-flame' : current?.status === 'ended' ? 'bg-line-strong' : 'bg-accent'}`} />
          {usable.length > 1 ? (
            <select aria-label="Lead session" value={value.sessionId} onChange={(e) => onChange({ kind: 'session', sessionId: e.target.value })} className={`${inputClass} min-w-0 flex-1`}>
              {usable.map((t) => (
                <option key={t.sessionId} value={t.sessionId}>
                  {t.label} · {t.status}
                </option>
              ))}
            </select>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[13.5px]">
              <span className="font-semibold">{current?.label ?? 'Lead'}</span>
              <span className="text-muted"> · {current?.status ?? 'unknown'}</span>
            </span>
          )}
        </div>
      )}
      {value.kind === 'session' && <p className="px-1 text-[12px] text-muted">A ticket is created for tracking.</p>}
    </div>
  );
}

/** Type and priority as one row of chips (Bug, Normal by default); a direct ask is always urgent, so priority hides then. */
function TypePriority({ type, setType, priority, setPriority, urgent }: { type: TicketType; setType: (t: TicketType) => void; priority: TicketPriority; setPriority: (p: TicketPriority) => void; urgent: boolean }) {
  return (
    <div className="-mx-3 flex items-center gap-1.5 overflow-x-auto px-3 pb-0.5">
      <div role="group" aria-label="Type" className="flex shrink-0 gap-1.5">
        {TYPES.map((t) => (
          <Chip key={t} on={type === t} onClick={() => setType(t)}>
            {TICKET_TYPE_LABEL[t]}
          </Chip>
        ))}
      </div>
      {!urgent && (
        <>
          <span aria-hidden="true" className="mx-0.5 h-6 w-px shrink-0 bg-line" />
          {/* Priority as one compact control (UX review): Normal unless changed. */}
          <label className={`relative inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full border px-3 text-[13px] font-medium ${priority === 'normal' ? 'border-line-strong text-ink' : 'border-primary bg-primary text-primary-ink'}`}>
            <Icon name="flag" className="size-3.5" />
            {TICKET_PRIORITY_LABEL[priority]}
            <Icon name="chevronDown" className="size-3.5 opacity-70" />
            <select aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)} className="absolute -inset-px cursor-pointer opacity-0">
              {PRIORITIES.map((v) => (
                <option key={v} value={v}>
                  {TICKET_PRIORITY_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}

function Sticky({ children }: { children: ReactNode }) {
  return <div className="sticky bottom-0 -mx-3 mt-auto flex flex-col gap-2 border-t border-line bg-bg px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">{children}</div>;
}

/** The quick path: the shots, one ticket (or a direct ask that opens the chat). */
function QuickForm({ onFiled }: { onFiled: (key: string) => void }) {
  const { client, shots, removeShot, setCapture, refresh, notify, setTab, select, sdkVersion, targets, setReview, build, hostTarget, choice, setChoice, coarse, openChat, showContext } = usePanel();
  const capture = shots[0]!;
  const [summary, setSummary] = useState(() => suggestTitle(capture.evidence.page.title, elementLabel(capture.evidence)));
  const [description, setDescription] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [type, setType] = useState<TicketType>('bug');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  // The capture toolbar's choice when it said one, else the person's last choice.
  const [target, setTarget] = useState<ReporterReportTarget>(() => pickTarget(capture.target ?? hostTarget ?? choice, targets));
  useEffect(() => {
    if (capture.target) setTarget(pickTarget(capture.target, targets));
    // A new capture's choice only; the person's own switch afterwards wins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture.captureId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (target.kind === 'session' && targets.length && !targets.some((t) => t.sessionId === target.sessionId && t.available)) setTarget({ kind: 'ticket' });
  }, [targets, target]);
  // An error is about what was sent: editing clears it.
  useEffect(() => setError(null), [summary, description, target]);
  // The SDK's capture toolbar follows this form's switch (and remembers it).
  useEffect(() => setChoice(target), [target, setChoice]);
  const asking = target.kind === 'session';
  const button = sendButton(target, targets);

  const submit = async () => {
    const problem = reportProblem(target, summary, description);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      const res = await client.createTicket({
        summary: summary.trim(),
        description,
        type,
        priority: asking ? 'urgent' : priority,
        tags: [],
        captures: shots.map((c) => captureInput(c, null)),
        build: capture.evidence.build,
        sdkVersion: sdkVersion || capture.evidence.sdkVersion,
        target,
      });
      const failed: string[] = [];
      for (const c of shots) failed.push(...(await uploadCapture((id, kind, blob) => client.attach(res.key, id, kind, blob), c)));
      refresh();
      // A direct ask goes straight into the chat with that session (the delivered message and the reply live); a ticket shows Filed.
      const next = afterFiled(target, res, description, capture.screenshot);
      if (failed.length) notify(`${res.key} filed; upload failed: ${failed.join(', ')}.`, 'error');
      setCapture(null);
      if (next.kind === 'chat') openChat(next.open);
      else onFiled(next.key);
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
      <div className="-mt-1 flex items-center justify-between gap-1">
        <IconBtn icon="x" label="Discard" onClick={() => setCapture(null)} />
        <Btn tone="ghost" icon="messageSquare" disabled={busy} onClick={() => void toReview()} className="text-[13px] text-ink-soft" title="Collect several shots as one review">
          Start review
        </Btn>
      </div>
      <ShotStrip shots={shots} onRemove={shots.length > 1 ? removeShot : undefined} canAdd={shots.length < 6} />
      <input
        autoFocus={!coarse}
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        maxLength={200}
        aria-label="Title"
        placeholder="Title"
        className={`${inputClass} font-semibold`}
      />
      {asking ? (
        <textarea
          autoFocus
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={8000}
          aria-required="true"
          aria-label="Your question"
          placeholder="Your question"
          className={`${inputClass} resize-y`}
        />
      ) : detailsOpen || description ? (
        <textarea autoFocus value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={8000} aria-label="Details" placeholder="Details (optional)" className={`${inputClass} resize-y`} />
      ) : (
        <button type="button" onClick={() => setDetailsOpen(true)} className={`${inputClass} text-left text-muted`}>
          Details (optional)
        </button>
      )}
      <TypePriority type={type} setType={setType} priority={priority} setPriority={setPriority} urgent={asking} />
      <ChecksChip capture={capture} />
      {error && <Notice tone="error">{error}</Notice>}
      <Sticky>
        <Duplicates
          shots={shots}
          onAdded={(key) => {
            setCapture(null);
            select(key);
            setTab('tickets');
          }}
        />
        <Destination value={target} onChange={setTarget} />
        <div className="flex items-center gap-1">
          <Btn type="submit" tone={button.tone === 'urgent' ? 'danger' : 'primary'} busy={busy} className="min-w-0 flex-1" icon="send">
            <span className="truncate">{button.label}</span>
          </Btn>
          <Btn tone="ghost" onClick={() => showContext('carries')} className="shrink-0 text-[13px] text-muted">
            What’s sent
          </Btn>
        </div>
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
      <ShotStrip shots={[capture]} canAdd={false} />
      <textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={REPORTER_LIMITS.commentChars} aria-label="Comment" className={`${inputClass} resize-y`} placeholder="What should change here?" />
      <ChecksChip capture={capture} />
      {full && <Notice tone="error">This review is full ({REPORTER_LIMITS.reviewComments} comments). Finish it first.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <Sticky>
        <Duplicates shots={[capture]} onAdded={() => setCapture(null)} />
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[12.5px] text-muted tabular-nums">{review.comments.length} comments</span>
          <Btn type="submit" tone="primary" busy={busy} disabled={full} className="flex-1" icon="plus">
            Add comment
          </Btn>
        </div>
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
          <div className="flex gap-2">
          <Btn tone="ghost" icon="trash2" onClick={() => setConfirm(true)} aria-label="Discard review" />
          <Btn tone="primary" disabled={!comments.length} onClick={onFinish} className="flex-1">
            {comments.length} {comments.length === 1 ? 'comment' : 'comments'} · Finish review
          </Btn>
          </div>
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
  const [view, setView] = useState(false);
  return (
    <li className="rounded-2xl border border-dashed border-line-strong p-2">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => {
            props.onShow();
            if (c.screenshotUrl) setView(true);
          }}
          aria-label={`View comment ${c.index}`}
          className="shrink-0 rounded-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
        >
          <AuthImg client={client} src={c.screenshotUrl} alt="" className="size-14 rounded-lg" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] break-all text-muted">{shotCaption(c.index, c.anchor.path)}</p>
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
      {view && c.screenshotUrl && <Viewer src={c.screenshotUrl} alt={shotCaption(c.index, c.anchor.path)} crop={{ anchor: c.anchor, scroll: null }} onClose={() => setView(false)} />}
    </li>
  );
}

/** Finish review: how the comments become tickets (one, one per page, one per comment) or join an open ticket. */
function SubmitForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { client, review, setReview, refresh, notify, setTab, select, targets, post, hostTarget, setChoice } = usePanel();
  const [summary, setSummary] = useState(() => (review ? proposedSummary(review) : ''));
  const [description, setDescription] = useState('');
  const [type, setType] = useState<TicketType>('bug');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [tags, setTags] = useState('');
  const [mode, setMode] = useState<ReporterFileMode | 'existing'>('single');
  const [existing, setExisting] = useState('');
  const [open, setOpen] = useState<ReporterTicket[]>([]);
  const [target, setTarget] = useState<ReporterReportTarget>(() => pickTarget(hostTarget, targets));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== 'existing' || open.length) return;
    client.tickets({ status: 'open', sort: 'updated', order: 'desc', limit: 50 }).then((l) => setOpen(l.items), () => undefined);
  }, [mode, open.length, client]);
  useEffect(() => {
    if (target.kind === 'session' && !targets.some((t) => t.sessionId === target.sessionId && t.available)) setTarget({ kind: 'ticket' });
  }, [targets, target]);
  // The SDK's capture toolbar follows this form's switch.
  useEffect(() => setChoice(target), [target, setChoice]);
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
      {error && <Notice tone="error">{error}</Notice>}
      <Sticky>
        <Destination value={target} onChange={setTarget} />
        <Btn type="submit" tone={target.kind === 'session' ? 'danger' : 'primary'} busy={busy} className="flex-1" icon="send">
          {mode === 'existing' ? `Add to ${existing || 'ticket'}` : count === 1 ? (target.kind === 'session' ? 'Send now' : 'Submit') : `Submit ${count} tickets`}
        </Btn>
      </Sticky>
    </form>
  );
}
