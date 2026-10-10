import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  LoadError,
  Section,
  SwitchRow,
  useToast,
  type BadgeTone,
} from '@isnanme/ui';
import { formatCode, type AdminState, type CodeSource } from '@portal/contracts';
import { Eye, EyeOff, LogIn, LogOut, PenLine, Power, RefreshCw, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { api, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, timeAgo } from '@/lib/format';
import { CustomCodeDialog } from './CustomCodeDialog';
import { StorageSection } from './StorageSection';

const SOURCE: Record<CodeSource, { label: string; tone: BadgeTone }> = {
  env: { label: 'From env', tone: 'neutral' },
  generated: { label: 'Generated', tone: 'success' },
  custom: { label: 'Custom', tone: 'warning' },
};

/** The admin's one page today: the server code, whether sign-in is open, and this session. */
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
        description="Who can sign in to this server, and with which code."
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
        <div className="flex flex-col gap-8">
          <Section title="Server code" description="Share it only with people who should manage this portal.">
            <Card className="p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <p
                  aria-label={revealed ? `Server code ${state.code}` : 'Server code hidden'}
                  className="min-w-0 flex-1 truncate font-mono text-[22px] font-semibold tracking-[0.1em] tabular-nums sm:text-[30px] sm:tracking-[0.14em]"
                >
                  {revealed ? formatCode(state.code) : MASK}
                </p>
                <div className="flex shrink-0 items-center gap-2">
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
              </div>
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
                <Badge tone={SOURCE[state.source].tone}>{SOURCE[state.source].label}</Badge>
                <span title={formatDateTime(state.codeUpdatedAt)}>Set {timeAgo(state.codeUpdatedAt)}</span>
              </p>
              {state.source === 'env' && (
                <p className="mt-3 text-[13px] text-muted">
                  Rotating replaces <code className="font-mono text-ink-soft">PORTAL_SERVER_CODE</code> until the server
                  restarts.
                </p>
              )}
              <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row">
                <Button variant="secondary" icon={<RefreshCw className="size-4" />} onClick={() => setConfirm('rotate')}>
                  Rotate code
                </Button>
                <Button variant="ghost" icon={<PenLine className="size-4" />} onClick={() => setCustomOpen(true)}>
                  Set custom code
                </Button>
              </div>
            </Card>
          </Section>

          <Section title="Sign-in">
            <Card className="px-4 sm:px-5">
              <SwitchRow
                icon={<Power className="size-[18px]" />}
                label="Allow sign-in"
                description={
                  state.enabled
                    ? 'Anyone with the code can sign in.'
                    : 'Nobody can sign in. Signed-in sessions keep working.'
                }
                checked={state.enabled}
                disabled={busy}
                onChange={(on) => (on ? void setEnabled(true) : setConfirm('disable'))}
              />
            </Card>
          </Section>

          <StorageSection />

          <Section title="Session">
            <Card>
              <ul className="divide-y divide-line">
                <li className="flex items-center gap-3 p-4 sm:px-5">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <LogIn className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">This device</p>
                    <p className="text-[13px] text-muted" title={formatDateTime(state.signedInAt)}>
                      Signed in {timeAgo(state.signedInAt)}
                    </p>
                  </div>
                </li>
                <li className="flex items-center gap-3 p-4 sm:px-5">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-soft">
                    <Users className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{others ? othersText : 'No other sessions'}</p>
                    <p className="text-[13px] text-muted">Rotating the code signs them out.</p>
                  </div>
                </li>
              </ul>
            </Card>
            <Button variant="secondary" className="mt-3 w-full sm:w-auto" icon={<LogOut className="size-4" />} onClick={logout}>
              Sign out
            </Button>
          </Section>
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
