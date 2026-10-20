import { Button, Dialog } from '@isnanme/ui';
import { CODE_LENGTH, REAUTH_REQUIRED, type ChatBypassFacts, type ChatSession } from '@portal/contracts';
import { useEffect, useRef, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { ServerCodeInput } from '@/features/auth/ServerCodeInput';
import { ApiError, errorText } from '@/lib/api';
import { chatApi } from './api';

/** What the confirmation says of the workspace: only what the portal knows to be true of it. */
export function bypassClaim(workspace: string, facts: ChatBypassFacts): string {
  const has = [facts.internet ? 'internet access' : null, facts.credentials.length > 0 ? 'delivered credentials' : null].filter(Boolean);
  return `Claude will run every tool without asking in ${workspace}${has.length > 0 ? `, which has ${has.join(' and ')}` : ''}.`;
}

/**
 * Turning on Bypass (chat PRD FR20): the confirmation, with Cancel focused and Turn on enabled only after the tick,
 * then the server code when it wasn't checked lately (the server decides: it answers `REAUTH_REQUIRED`). Mode chip,
 * Bypass, tick, Turn on, then the code: four taps and the code, as the PRD counts it.
 */
export function BypassDialog({
  open,
  onClose,
  sessionId,
  workspace,
  facts,
  onEntered,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  workspace: string;
  facts: ChatBypassFacts;
  onEntered: (session: ChatSession) => void;
}) {
  const [ticked, setTicked] = useState(false);
  const [step, setStep] = useState<'confirm' | 'code'>('confirm');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeInput = useRef<{ focus: () => void }>(null);

  useEffect(() => {
    if (!open) return;
    setTicked(false);
    setStep('confirm');
    setCode('');
    setError(null);
    setBusy(false);
  }, [open]);

  const enter = async () => {
    setBusy(true);
    setError(null);
    try {
      onEntered(await chatApi.enterBypass(sessionId, { acknowledged: true }));
    } catch (e) {
      if (e instanceof ApiError && e.code === REAUTH_REQUIRED) {
        setStep('code');
        setCode('');
      } else setError(errorText(e, 'Couldn’t turn Bypass on.'));
    } finally {
      setBusy(false);
    }
  };

  const check = async (value: string) => {
    if (busy) return;
    if (value.length < CODE_LENGTH) {
      setError(`Enter all ${CODE_LENGTH} characters.`);
      return codeInput.current?.focus();
    }
    setBusy(true);
    setError(null);
    try {
      await chatApi.reauth(value);
    } catch (e) {
      setBusy(false);
      setCode('');
      setError(errorText(e, 'Couldn’t check the code.'));
      requestAnimationFrame(() => codeInput.current?.focus());
      return;
    }
    setBusy(false);
    await enter();
  };

  const confirming = step === 'confirm';
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      size="sm"
      stepKey={step}
      title={
        confirming ? (
          <span className="inline-flex items-center gap-1">
            Turn on Bypass?
            <InfoTip label="About Bypass">Deny rules still apply. Bypass turns off when the agent sleeps, restarts or moves to another Claude.</InfoTip>
          </span>
        ) : (
          'Enter the server code'
        )
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus={confirming ? '' : undefined}>
            Cancel
          </Button>
          {confirming ? (
            <Button variant="danger" onClick={() => void enter()} disabled={!ticked} loading={busy}>
              Turn on
            </Button>
          ) : (
            <Button variant="danger" onClick={() => void check(code)} loading={busy}>
              Turn on
            </Button>
          )}
        </>
      }
    >
      {confirming ? (
        <div className="flex flex-col gap-3">
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl bg-danger-soft px-3.5 py-3 text-[14.5px] text-ink">
            <input
              type="checkbox"
              checked={ticked}
              onChange={(e) => setTicked(e.target.checked)}
              disabled={busy}
              className="mt-0.5 size-5 shrink-0 cursor-pointer accent-[var(--color-danger)]"
            />
            <span className="min-w-0 flex-1">{bypassClaim(workspace, facts)}</span>
          </label>
          {error && <Problem>{error}</Problem>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <ServerCodeInput
            ref={codeInput}
            value={code}
            onChange={(v) => (setCode(v), setError(null))}
            onComplete={(v) => void check(v)}
            error={!!error}
            disabled={busy}
            autoFocus
          />
          {error && <Problem>{error}</Problem>}
        </div>
      )}
    </Dialog>
  );
}

function Problem({ children }: { children: string }) {
  return (
    <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">
      {children}
    </p>
  );
}
