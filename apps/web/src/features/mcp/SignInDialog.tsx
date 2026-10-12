import { Button, buttonClass, CopyButton, Dialog, Spinner, TextField } from '@isnanme/ui';
import type { McpServerAuth, McpSignInStart } from '@portal/contracts';
import { ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { ApiError, errorText } from '@/lib/api';
import { forbiddenReason } from './access';
import { mcpApi } from './api';
import { classifyComplete, safeHref } from './signIn';
import { useEscapeFirst } from './useEscapeFirst';

/** Which server to sign in to: its plugin and key as in `McpServerStatus`, and the name to show. */
export interface SignInTarget {
  plugin: string;
  key: string;
  name: string;
}

/**
 * Sign in to an OAuth server in a workspace (MCP set PRD §13.3). Claude Code there prints the provider's page; the person
 * signs in, the browser is sent to an address on the workspace's own loopback that cannot load on their device, and the
 * address it ended on, which carries the authorization code, is pasted here. The portal hands it to Claude Code once: it
 * is never stored or logged, and this dialog keeps no copy after it is sent. Same shape as the Claude Code sign-in.
 *
 * The caller holds `target` in state while the dialog is open; the last one is kept after it closes so the dialog can
 * animate out, and a new target starts a new sign-in.
 */
export function SignInDialog({
  workspaceId,
  target,
  claudeId,
  onClose,
  onDone,
  onForbidden,
}: {
  workspaceId: string;
  target: SignInTarget | null;
  /** One of the workspace's Claudes; Default when absent. */
  claudeId?: string;
  onClose: () => void;
  onDone: (auth: McpServerAuth, target: SignInTarget) => void;
  /** The portal refused (403): the person may not sign in here. The caller shows its sign-in actions off, with this reason. */
  onForbidden: (reason: string) => void;
}) {
  const [held, setHeld] = useState<{ target: SignInTarget; serial: number } | null>(null);
  if (target && target !== held?.target) setHeld({ target, serial: (held?.serial ?? 0) + 1 });
  if (!held) return null;
  return <SignIn key={held.serial} workspaceId={workspaceId} target={held.target} claudeId={claudeId} open={!!target} onClose={onClose} onDone={onDone} onForbidden={onForbidden} />;
}

function SignIn({
  workspaceId,
  target,
  claudeId,
  open,
  onClose,
  onDone,
  onForbidden,
}: {
  workspaceId: string;
  target: SignInTarget;
  claudeId?: string;
  open: boolean;
  onClose: () => void;
  onDone: (auth: McpServerAuth, target: SignInTarget) => void;
  onForbidden: (reason: string) => void;
}) {
  const [start, setStart] = useState<McpSignInStart | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // The sign-in ended before it was finished (expired, refused by the provider): start again.
  const [ended, setEnded] = useState<string | null>(null);
  // Starting takes longer when Claude Code in the workspace has to wake up.
  const [slow, setSlow] = useState(false);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Refused for lack of rights: starting again would be refused again, so only Close is offered.
  const [forbidden, setForbidden] = useState(false);
  // The id of the sign-in that is waiting in the workspace, so closing or restarting ends it.
  const waiting = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setStart(null);
    setStartError(null);
    setEnded(null);
    setSlow(false);
    setForbidden(false);
    setPasted('');
    setError(undefined);
    const slowTimer = window.setTimeout(() => current && setSlow(true), 6_000);
    // A tick later, so a double mount (React's strict mode) starts one sign-in, not two.
    const timer = window.setTimeout(() => {
      mcpApi.signIn(workspaceId, { plugin: target.plugin, key: target.key }, claudeId).then(
        (r) => {
          if (!current) return void mcpApi.cancelSignIn(workspaceId, r.signInId).catch(() => undefined);
          waiting.current = r.signInId;
          setStart(r);
        },
        (e: unknown) => {
          if (!current) return;
          const refused = forbiddenReason(e);
          if (refused) {
            setForbidden(true);
            onForbidden(refused);
          }
          setStartError(refused ?? errorText(e, 'Could not start the sign-in.'));
        },
      );
    }, 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
      window.clearTimeout(slowTimer);
      const id = waiting.current;
      waiting.current = null;
      if (id) void mcpApi.cancelSignIn(workspaceId, id).catch(() => undefined);
    };
  }, [open, workspaceId, target.plugin, target.key, claudeId, attempt]);

  const close = () => {
    if (!busy) onClose();
  };
  useEscapeFirst(open, close);
  // The address carries a one-time code: when the dialog closes, nothing of it stays in memory.
  useEffect(() => {
    if (!open) setPasted('');
  }, [open]);

  const submit = async () => {
    const value = pasted.trim();
    if (!start || busy || !value) return;
    setBusy(true);
    setError(undefined);
    try {
      const auth = await mcpApi.completeSignIn(workspaceId, start.signInId, value);
      // The address carried a one-time code: keep no copy of it.
      setPasted('');
      waiting.current = null;
      onDone(auth, target);
    } catch (e) {
      const refused = forbiddenReason(e);
      if (refused) {
        waiting.current = null;
        setForbidden(true);
        onForbidden(refused);
        setEnded(refused);
        return;
      }
      const failure = classifyComplete(e instanceof ApiError ? e : { message: errorText(e, 'The sign-in ended. Start again.') });
      if (failure.retry) {
        // Refused, or still being checked: the same sign-in stays open and the address can be pasted again.
        setError(failure.message);
      } else {
        waiting.current = null;
        setEnded(failure.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const href = start ? safeHref(start.url) : null;
  const again = startError || ended;
  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={`Sign in · ${target.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            {again ? 'Close' : 'Cancel'}
          </Button>
          {again ? (
            !forbidden && <Button onClick={() => setAttempt((n) => n + 1)}>{startError ? 'Try again' : 'Start again'}</Button>
          ) : (
            <Button loading={busy} disabled={!start || !pasted.trim()} onClick={() => void submit()}>
              Done
            </Button>
          )}
        </>
      }
    >
      {startError ? (
        <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">
          {startError}
        </p>
      ) : ended ? (
        <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">
          {ended}
        </p>
      ) : !start ? (
        <p className="flex items-center gap-2 text-[13px] text-muted" aria-busy="true">
          <Spinner className="size-4" />
          {slow ? 'Still starting…' : 'Starting…'}
        </p>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div>
            <p className="mb-2 text-sm font-semibold text-ink-soft">1. Open the sign-in page</p>
            {href ? (
              <div className="flex items-center gap-2">
                <a href={href} target="_blank" rel="noopener noreferrer" className={buttonClass('secondary', 'md', 'min-w-0 flex-1 gap-2')}>
                  <ExternalLink className="size-4 shrink-0" />
                  Open the sign-in page
                </a>
                <CopyButton value={href} label="Copy link" toastMessage="Link copied" showLabel={false} />
              </div>
            ) : (
              <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">
                Claude Code gave an address that isn’t a web page.
              </p>
            )}
          </div>
          <TextField
            label="2. Paste the address it ends on"
            value={pasted}
            onChange={(e) => (setPasted(e.target.value), setError(undefined))}
            placeholder={start.callback ? `${start.callback}?code=…` : undefined}
            error={error}
            hint="The page won’t load. Copy its address."
            readOnly={busy}
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-autofocus
            suffix={
              <InfoTip label="About the address">
                After you sign in, your browser is sent to {start.callback ?? 'an address on the workspace'} and shows an error: that is expected, the address only exists inside the workspace. Copy the whole address from the address bar and paste it here. It holds a one-time code that the portal passes to Claude Code and does not keep.
              </InfoTip>
            }
          />
        </form>
      )}
    </Dialog>
  );
}
