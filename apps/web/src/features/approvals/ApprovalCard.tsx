import { Badge, Button } from '@isnanme/ui';
import { APPROVAL_KIND_LABEL, APPROVAL_REASON_MAX, CODE_LENGTH, REAUTH_REQUIRED, type Approval } from '@portal/contracts';
import { ShieldCheck } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { ServerCodeInput } from '@/features/auth/ServerCodeInput';
import { chatApi } from '@/features/chat/api';
import { ApiError, errorText } from '@/lib/api';
import { approvalsApi } from './api';
import { payloadText } from './mask';

const ABOUT =
  'An agent asked the portal to do this for it. Allow runs exactly the payload shown, once, as the portal; Deny tells the agent why. Either way the agent gets a message. It expires by itself if nobody decides.';

const STATUS_TONE = { pending: 'warning', allowed: 'success', denied: 'danger', expired: 'neutral' } as const;
const STATUS_LABEL = { pending: 'Waiting', allowed: 'Allowed', denied: 'Denied', expired: 'Expired' } as const;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

/**
 * One approval request (docs/prd/approvals.md): the exact payload (secrets masked), the tier, the agent's reason (its own words), the expiry,
 * and Allow and Deny. A kind that needs a fresh server code (Bypass) asks for it here, as the Bypass dialog does, then allows.
 */
export function ApprovalCard({ approval, onChange }: { approval: Approval; onChange: (a: Approval) => void }) {
  const a = approval;
  const [step, setStep] = useState<'decide' | 'deny' | 'code'>('decide');
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const codeInput = useRef<{ focus: () => void }>(null);
  const open = a.status === 'pending' && Date.parse(a.expiresAt) > Date.now();

  const allow = async () => {
    setBusy('allow');
    setError(null);
    try {
      onChange(await approvalsApi.allow(a.id));
      setStep('decide');
    } catch (e) {
      if (e instanceof ApiError && e.code === REAUTH_REQUIRED) {
        setStep('code');
        setCode('');
      } else setError(errorText(e, 'Couldn’t allow it.'));
    } finally {
      setBusy(null);
    }
  };

  const check = async (value: string) => {
    if (busy) return;
    if (value.length < CODE_LENGTH) {
      setError(`Enter all ${CODE_LENGTH} characters.`);
      return codeInput.current?.focus();
    }
    setBusy('allow');
    setError(null);
    try {
      await chatApi.reauth(value);
    } catch (e) {
      setBusy(null);
      setCode('');
      setError(errorText(e, 'Couldn’t check the code.'));
      requestAnimationFrame(() => codeInput.current?.focus());
      return;
    }
    setBusy(null);
    await allow();
  };

  const deny = async () => {
    setBusy('deny');
    setError(null);
    try {
      onChange(await approvalsApi.deny(a.id, reason.trim() || undefined));
      setStep('decide');
    } catch (e) {
      setError(errorText(e, 'Couldn’t deny it.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article data-approval-card={a.id} className="flex min-w-0 flex-col gap-4 rounded-3xl border border-line bg-surface p-5 shadow-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ShieldCheck className="size-5 shrink-0 text-muted" aria-hidden="true" />
        <span className="text-[13px] font-semibold text-ink-soft">{APPROVAL_KIND_LABEL[a.kind]}</span>
        <Badge tone="warning">{a.tier}</Badge>
        <Badge tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>
        <InfoTip label="About approvals">{ABOUT}</InfoTip>
      </div>

      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[14px]">
        <dt className="text-muted">From</dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">
          {a.requesterSession ? (
            <Link to={`/admin/sessions/${encodeURIComponent(a.requesterSession)}`} className="hover:underline">
              {a.requesterTitle?.trim() || `Session ${a.requesterSession.slice(0, 8)}`}
            </Link>
          ) : (
            'Portal'
          )}
        </dd>
        <dt className="text-muted">Why</dt>
        <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]" data-approval-reason="">
          {a.reason || '–'}
        </dd>
        <dt className="text-muted">{open ? 'Expires' : 'Asked'}</dt>
        <dd className="tabular-nums">
          <time dateTime={open ? a.expiresAt : a.createdAt}>{when(open ? a.expiresAt : a.createdAt)}</time>
        </dd>
      </dl>

      <div className="min-w-0">
        <p className="mb-1.5 text-[13px] font-semibold text-ink-soft">Runs exactly</p>
        <pre data-approval-payload="" className="max-h-72 min-w-0 overflow-auto whitespace-pre-wrap rounded-2xl bg-ink/[0.05] p-3 font-mono text-[13px] [overflow-wrap:anywhere]">
          {payloadText(a.payload)}
        </pre>
      </div>

      {a.result && (
        <p role="status" className={`rounded-xl px-3.5 py-2.5 text-[14px] [overflow-wrap:anywhere] ${a.result.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
          {a.result.message}
          {a.decidedAt && <span className="ml-1 text-[12.5px] opacity-80">({when(a.decidedAt)})</span>}
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">
          {error}
        </p>
      )}

      {open && step === 'code' && (
        <div className="flex flex-col gap-3">
          <p className="text-[14px] font-semibold">Enter the server code</p>
          <ServerCodeInput ref={codeInput} value={code} onChange={(v) => (setCode(v), setError(null))} onComplete={(v) => void check(v)} error={!!error} disabled={!!busy} autoFocus />
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" className="min-h-12" onClick={() => setStep('decide')} disabled={!!busy}>
              Cancel
            </Button>
            <Button variant="danger" className="min-h-12" onClick={() => void check(code)} loading={busy === 'allow'}>
              Allow
            </Button>
          </div>
        </div>
      )}

      {open && step === 'deny' && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-[14px]">
            <span className="font-semibold">Reason</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, APPROVAL_REASON_MAX))}
              rows={2}
              placeholder="Optional"
              className="min-h-11 w-full rounded-xl border border-line bg-surface px-3 py-2 text-[15px]"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" className="min-h-12" onClick={() => setStep('decide')} disabled={!!busy}>
              Back
            </Button>
            <Button variant="danger" className="min-h-12" data-approval-deny-send="" onClick={() => void deny()} loading={busy === 'deny'}>
              Deny
            </Button>
          </div>
        </div>
      )}

      {open && step === 'decide' && (
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" className="min-h-12" data-approval-deny="" onClick={() => setStep('deny')} disabled={!!busy}>
            Deny
          </Button>
          <Button variant={a.kind === 'session.bypass' ? 'danger' : 'primary'} className="min-h-12" data-approval-allow="" onClick={() => void allow()} loading={busy === 'allow'}>
            Allow
          </Button>
        </div>
      )}
    </article>
  );
}
