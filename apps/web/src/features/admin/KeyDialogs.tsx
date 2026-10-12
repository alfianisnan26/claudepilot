import { Button, CopyButton, Dialog, SwitchRow, useToast } from '@isnanme/ui';
import type { KeySetupResult, SystemStatus } from '@portal/contracts';
import { KeyRound, ShieldPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { SecretField } from '@/components/SecretField';
import { api, ApiError, errorText } from '@/lib/api';
import { useLive } from '@/lib/live';

/**
 * First-time setup, or starting over after losing a key that never protected anything (`reset`): the
 * portal generates the key and shows it once. If PORTAL_SECRET_KEY_FILE is set (and empty) it's saved
 * there; otherwise it lives in memory until the portal restarts.
 */
export function SetUpKeyDialog({
  open,
  mode = 'setup',
  keyFile,
  onClose,
  onDone,
}: {
  open: boolean;
  mode?: 'setup' | 'reset';
  keyFile: string | null;
  onClose: () => void;
  onDone: (status: SystemStatus) => void;
}) {
  const [result, setResult] = useState<KeySetupResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setSaved(false);
    setError(null);
  }, [open]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await (mode === 'reset' ? api.keyReset() : api.keySetup()));
    } catch (e) {
      setError(errorText(e, 'Could not set up encryption.'));
    } finally {
      setBusy(false);
    }
  };

  // Once the key exists, closing without confirming would lose the only copy shown.
  const close = () => {
    if (busy) return;
    if (result) {
      if (!saved) return;
      onDone(result.status);
    } else onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={
        result ? (
          'Save your key'
        ) : (
          <span className="inline-flex items-center gap-1.5">
            {mode === 'reset' ? 'Start over' : 'Set up encryption'}
            <InfoTip label="About the key">
              {mode === 'reset' ? 'Nothing was ever encrypted with the lost key, so nothing is lost. ' : ''}
              The portal creates a random 256-bit key and encrypts stored secrets with it.{' '}
              {keyFile ? (
                <>
                  It’s saved to <code className="font-mono text-ink">{keyFile}</code>, so the portal unlocks itself after restarts.
                </>
              ) : (
                <>
                  No key file is set (<code className="font-mono text-ink">PORTAL_SECRET_KEY_FILE</code>), so the key stays in
                  memory: after each restart you unlock here by pasting it.
                </>
              )}{' '}
              Keep a copy somewhere safe too, such as a password manager.
            </InfoTip>
          </span>
        )
      }
      description={result ? 'Shown once. Without it, stored keys and secrets can’t be read again.' : undefined}
      footer={
        result ? (
          <Button onClick={close} disabled={!saved}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button loading={busy} onClick={() => void create()}>
              Create key
            </Button>
          </>
        )
      }
    >
      {!result ? (
        error ? <p className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">{error}</p> : null
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface-2 px-3.5 py-3">
            <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-ink">{result.key}</code>
            <CopyButton value={result.key} toastMessage="Key copied" />
          </div>
          <p className="text-[13px] text-ink-soft">
            {result.savedTo ? (
              <>
                Saved to <code className="font-mono text-ink">{result.savedTo}</code>.
              </>
            ) : (
              'Kept in memory only: paste it under Storage → Unlock after the portal restarts.'
            )}
          </p>
          <SwitchRow label="I’ve saved the key" checked={saved} onChange={setSaved} />
        </div>
      )}
    </Dialog>
  );
}

/** After a restart without a key file: paste the key the database was set up with. */
export function UnlockDialog({
  open,
  canReset = false,
  onReset,
  onClose,
  onDone,
}: {
  open: boolean;
  /** Nothing is encrypted yet, so a lost key can be replaced (offered as "Start over"). */
  canReset?: boolean;
  onReset?: () => void;
  onClose: () => void;
  onDone: (status: SystemStatus, savedTo: string | null) => void;
}) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) (setKey(''), setError(undefined));
  }, [open]);

  const submit = async () => {
    if (!key.trim()) return setError('Paste the key.');
    setBusy(true);
    try {
      const r = await api.keyUnlock(key);
      onDone(r.status, r.savedTo);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Could not unlock.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      size="sm"
      title="Unlock"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button icon={<KeyRound className="size-4" />} loading={busy} onClick={() => void submit()}>
            Unlock
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SecretField
          label="Secret key"
          value={key}
          onChange={(e) => (setKey(e.target.value), setError(undefined))}
          error={error}
          data-autofocus
        />
        {canReset && onReset && (
          <p className="mt-3 text-[13px] text-muted">
            Lost it?{' '}
            <button type="button" className="font-semibold text-ink underline underline-offset-2" onClick={onReset}>
              Start over with a new key
            </button>
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * Unlock (or Set up encryption) right where a locked portal blocks something, such as the Accounts
 * banner. Renders nothing until it knows which one applies.
 */
export function KeyActions({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [dialog, setDialog] = useState<'setup' | 'reset' | 'unlock' | null>(null);

  useEffect(() => {
    api.system().then(setStatus, () => undefined);
  }, []);
  useLive('system', () => void api.system().then(setStatus, () => undefined));

  if (!status) return null;
  const k = status.secretKey;
  const done = (next: SystemStatus, message: string) => {
    setStatus(next);
    setDialog(null);
    toast(message);
    onDone();
  };

  return (
    <>
      {k.canUnlock && (
        <Button size="sm" icon={<KeyRound className="size-4" />} onClick={() => setDialog('unlock')}>
          Unlock
        </Button>
      )}
      {k.canSetUp && (
        <Button size="sm" icon={<ShieldPlus className="size-4" />} onClick={() => setDialog('setup')}>
          Set up encryption
        </Button>
      )}
      <SetUpKeyDialog
        open={dialog === 'setup' || dialog === 'reset'}
        mode={dialog === 'reset' ? 'reset' : 'setup'}
        keyFile={k.keyFile}
        onClose={() => setDialog(null)}
        onDone={(next) => done(next, 'Encryption set up')}
      />
      <UnlockDialog
        open={dialog === 'unlock'}
        canReset={k.canReset}
        onReset={() => setDialog('reset')}
        onClose={() => setDialog(null)}
        onDone={(next, savedTo) => done(next, savedTo ? 'Unlocked; key saved to the key file' : 'Unlocked')}
      />
    </>
  );
}
