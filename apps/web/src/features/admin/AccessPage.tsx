import { Badge, Button, ConfirmDialog, CopyButton, LoadError, Switch, useToast, type BadgeTone } from '@isnanme/ui';
import { formatCode, type AdminState, type CodeSource } from '@portal/contracts';
import { Eye, EyeOff, LogOut, PenLine, Power, RefreshCw, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { SettingRow } from '@/components/SettingRow';
import { api, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, timeAgo } from '@/lib/format';
import { CustomCodeDialog } from './CustomCodeDialog';
import { StorageRow } from './StorageSection';

const SOURCE: Record<CodeSource, { label: string; tone: BadgeTone }> = {
  env: { label: 'From env', tone: 'neutral' },
  generated: { label: 'Generated', tone: 'success' },
  custom: { label: 'Custom', tone: 'warning' },
};

/**
 * Who gets in: the server code in a card, then sign-in, storage and sessions as one list. The
 * explanations sit behind ⓘ notes so the page fits one phone screen.
 */
export function AccessPage() {
  const toast = useToast();
  const { logout } = useAuth();
  const [state, setState] = useState<AdminState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [confirm, setConfirm] = useState<'rotate' | 'disable' | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      setState(await api.adminState());
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const rotate = async () => {
    setBusy(true);
    try {
      setState(await api.rotateCode());
      setRevealed(true);
      setConfirm(null);
      toast('New server code generated');
    } catch (e) {
      toast(errorText(e, 'Could not rotate the code.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      setState(await api.setEnabled(enabled));
      setConfirm(null);
      toast(enabled ? 'Sign-in turned on' : 'Sign-in turned off');
    } catch (e) {
      toast(errorText(e, 'Could not change sign-in.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const others = state ? state.sessions - 1 : 0;
  const othersText = others === 1 ? '1 other session' : `${others} other sessions`;

  return (
    <>
      <PageHeader
        title="Access"
        action={
          state && (
            <Badge tone={state.enabled ? 'success' : 'danger'} className="mb-1">
              <span className={`size-1.5 rounded-full ${state.enabled ? 'bg-accent' : 'bg-danger'}`} />
              {state.enabled ? 'Open' : 'Closed'}
            </Badge>
          )
        }
      />

      {loadFailed && <LoadError onRetry={load} />}
      {!state && !loadFailed && (
        <div className="flex flex-col gap-8" aria-busy="true">
          <div className="skeleton h-48 rounded-[24px]" />
          <div className="skeleton h-20 rounded-[24px]" />
          <div className="skeleton h-32 rounded-[24px]" />
        </div>
      )}

      {state && (
        <div className="flex flex-col gap-4">
          <Card className="p-4 sm:p-5">
            <div className="flex items-center gap-1 text-[13px] font-semibold text-muted">
              Server code
              <InfoTip label="About the server code">
                Share it only with people who manage this portal. Rotating signs out every other session.
                {state.source === 'env' && ' A new code replaces PORTAL_SERVER_CODE until the server restarts.'}
                <span className="mt-1.5 block text-muted" title={formatDateTime(state.codeUpdatedAt)}>
                  Set {timeAgo(state.codeUpdatedAt)}.
                </span>
              </InfoTip>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <p
                aria-label={revealed ? `Server code ${state.code}` : 'Server code hidden'}
                className="min-w-0 flex-1 truncate font-mono text-[24px] font-semibold tracking-[0.1em] tabular-nums sm:text-[30px] sm:tracking-[0.14em]"
              >
                {revealed ? formatCode(state.code) : MASK}
              </p>
              <Button
                variant="ghost"
                size="icon"
                aria-label={revealed ? 'Hide code' : 'Show code'}
                aria-pressed={revealed}
                onClick={() => setRevealed((v) => !v)}
              >
                {revealed ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
              </Button>
              <CopyButton value={state.code} toastMessage="Server code copied" />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Badge tone={SOURCE[state.source].tone}>{SOURCE[state.source].label}</Badge>
              <span className="flex-1" />
              <Button variant="secondary" size="sm" icon={<RefreshCw className="size-4" />} onClick={() => setConfirm('rotate')}>
                Rotate
              </Button>
              <Button variant="ghost" size="sm" icon={<PenLine className="size-4" />} aria-label="Set a custom code" onClick={() => setCustomOpen(true)}>
                Custom
              </Button>
            </div>
          </Card>

          <Card>
            <ul className="divide-y divide-line">
              <SettingRow
                icon={<Power className="size-5" />}
                tone={state.enabled ? 'accent' : 'neutral'}
                label="Sign-in"
                sub={state.enabled ? 'Anyone with the code' : 'Off · signed-in sessions keep working'}
                trailing={
                  <Switch
                    label="Allow sign-in"
                    checked={state.enabled}
                    disabled={busy}
                    onChange={(on) => (on ? void setEnabled(true) : setConfirm('disable'))}
                  />
                }
              />
              <StorageRow />
              <SettingRow
                icon={<Users className="size-5" />}
                label="Sessions"
                sub={
                  <span title={`This device signed in ${formatDateTime(state.signedInAt)}`}>
                    {others ? `You + ${others} other${others === 1 ? '' : 's'}` : 'Only you'}
                  </span>
                }
                trailing={
                  <Button variant="secondary" size="sm" icon={<LogOut className="size-4" />} onClick={logout}>
                    Sign out
                  </Button>
                }
              />
            </ul>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'rotate'}
        tone="primary"
        title="Rotate the server code?"
        description={
          others
            ? `A new code is generated and ${othersText} ${others === 1 ? 'is' : 'are'} signed out. You stay signed in.`
            : 'A new code is generated. The current one stops working. You stay signed in.'
        }
        confirmLabel="Rotate"
        loading={busy}
        onConfirm={() => void rotate()}
        onClose={() => !busy && setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'disable'}
        title="Turn off sign-in?"
        description="Nobody can sign in with the code until it's turned back on or the server restarts. You stay signed in."
        confirmLabel="Turn off"
        loading={busy}
        onConfirm={() => void setEnabled(false)}
        onClose={() => !busy && setConfirm(null)}
      />
      <CustomCodeDialog
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        onSave={async (code) => {
          setState(await api.rotateCode({ code }));
          setCustomOpen(false);
          setRevealed(true);
          toast('Server code updated');
        }}
      />
    </>
  );
}

/** Always the same mask, so a hidden code doesn't give away its length. */
const MASK = '••••-••••';
