import { Button, buttonClass, CopyButton, Dialog, Spinner, TextField } from '@isnanme/ui';
import type { Workspace, WorkspaceClaude } from '@portal/contracts';
import { ExternalLink, LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';

/**
 * Sign in to Claude from the portal: Claude Code in the workspace prints a claude.com link, the person
 * signs in there and pastes the code it shows. One way in: the page itself offers single sign-on (the
 * CLI's --sso only adds login_method=sso to the same link), so there's no method to pick here. The
 * sign-in is saved in the workspace, not the portal.
 */
export function ClaudeLoginDialog({
  workspace,
  claude,
  onClose,
  onDone,
}: {
  workspace: Workspace | null;
  /** Which of the workspace's Claudes signs in (its own directory and login); Default when absent. */
  claude?: WorkspaceClaude | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const claudeId = claude?.directory ? claude.id : undefined;
  const [url, setUrl] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // Starting takes longer when Claude Code has to be installed first.
  const [slow, setSlow] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const id = workspace?.id;

  // Starts Claude Code's sign-in in the workspace when the dialog opens.
  useEffect(() => {
    if (!id) return;
    let current = true;
    setUrl(null);
    setStartError(null);
    setCode('');
    setError(undefined);
    setSlow(false);
    const slowTimer = setTimeout(() => current && setSlow(true), 6_000);
    api.workspaces
      .claudeLogin(id, {}, claudeId)
      .then(
        (r) => current && setUrl(r.url),
        (e: unknown) => current && setStartError(errorText(e, 'Could not start the sign-in.')),
      )
      .finally(() => clearTimeout(slowTimer));
    return () => {
      current = false;
      clearTimeout(slowTimer);
    };
  }, [id, claudeId]);

  // Closing ends the sign-in waiting in the workspace.
  const close = () => {
    if (busy) return;
    if (id && !startError) void api.workspaces.cancelClaudeLogin(id, claudeId).catch(() => undefined);
    onClose();
  };

  const submit = async () => {
    if (!id || !url) return;
    if (!code.trim()) return setError('Paste the code the sign-in page shows.');
    setBusy(true);
    try {
      await api.workspaces.claudeLoginCode(id, code.trim(), claudeId);
      onDone();
    } catch (e) {
      setError(errorText(e, 'Signing in failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!workspace}
      onClose={close}
      size="sm"
      title={`Sign in · ${claude?.name ?? 'Default'}`}
      description={`Claude ${claude?.name ?? 'Default'} in ${workspace?.name ?? 'this workspace'}. Saved in its own directory there, not in the portal.`}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button icon={<LogIn className="size-4" />} loading={busy} disabled={!url} onClick={() => void submit()}>
            Sign in
          </Button>
        </>
      }
    >
      <div>
        {startError ? (
          <p className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">{startError}</p>
        ) : !url ? (
          <p className="flex items-center gap-2 text-[13px] text-muted" aria-busy="true">
            <Spinner className="size-4" />
            {slow ? 'Still starting. If Claude Code isn’t installed yet, it’s being installed (about half a minute)…' : 'Starting Claude Code’s sign-in…'}
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
              <p className="mb-2 text-sm font-semibold text-ink-soft">
                1. Sign in on claude.com (account or SSO)
              </p>
              <div className="flex items-center gap-2">
                <a href={url} target="_blank" rel="noopener noreferrer" className={buttonClass('secondary', 'md', 'min-w-0 flex-1 gap-2')}>
                  <ExternalLink className="size-4 shrink-0" />
                  Open the sign-in page
                </a>
                <CopyButton value={url} toastMessage="Link copied" />
              </div>
            </div>
            <TextField
              label="2. Paste the code it shows"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="[&_input]:font-mono"
              value={code}
              onChange={(e) => (setCode(e.target.value), setError(undefined))}
              error={error}
            />
          </form>
        )}
      </div>
    </Dialog>
  );
}
