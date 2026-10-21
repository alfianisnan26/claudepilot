import { Button, TextField } from '@isnanme/ui';
import { normalizeUserCode, type VscodePending } from '@portal/contracts';
import { Check, Monitor, TriangleAlert, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { errorText, api } from '@/lib/api';

/**
 * The VS Code extension's sign-in (docs/prd/vscode-extension.md §4). Review R4: a link with `?code=` looks nothing up by itself. The page
 * shows the code large and the person types its last 4 letters from their own VS Code, so a link someone else sent can't be approved by a
 * click; only then do the client's name and the address it came from show, with a warning when that is not the person's own address.
 */
export function VscodePage() {
  const [params] = useSearchParams();
  const linked = normalizeUserCode(params.get('code') ?? '');
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState<VscodePending | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'approve' | 'deny' | null>(null);

  /** The code to look up: the linked one once its last 4 letters were typed, or the whole code typed by hand. */
  const codeOf = (input: string): string | null => {
    const t = input.toUpperCase().replace(/[\s-]/g, '');
    if (linked) return t.length === 4 && linked.endsWith(t) ? linked : null;
    return normalizeUserCode(input);
  };

  const look = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setPending(null);
    const code = codeOf(typed);
    if (!code) return setError(linked ? 'Type the last 4 letters your VS Code shows.' : 'Eight letters, like BCDF-GHJK.');
    setBusy(true);
    try {
      setPending(await api.vscodePending(code));
    } catch (err) {
      setError(errorText(err, 'Could not check the code.'));
    } finally {
      setBusy(false);
    }
  };

  const answer = async (decision: 'approve' | 'deny') => {
    if (!pending) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.vscodeAnswer(pending.userCode, decision);
      setDone(decision);
    } catch (err) {
      setError(errorText(err, 'Could not answer.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="VS Code"
        description="Sign in the ClaudePilot extension. Approve only a code your own VS Code shows: it gets a token for 30 days that reads your agents, tickets and usage, sends messages and denies requests. Revoke it in Access, MCP tokens, or sign out in VS Code."
      />
      <Card className="mx-auto flex max-w-md flex-col gap-4 p-5">
        {done ? (
          <p className="flex items-center gap-2 font-semibold" data-vscode-done={done} role="status">
            {done === 'approve' ? <Check className="size-5 text-accent" aria-hidden="true" /> : <X className="size-5 text-danger" aria-hidden="true" />}
            {done === 'approve' ? 'Approved. Back to VS Code.' : 'Denied.'}
          </p>
        ) : (
          <>
            {linked && (
              <p className="text-center font-mono text-3xl font-semibold tracking-[0.2em] [overflow-wrap:anywhere]" data-vscode-linked="">
                {`${linked.slice(0, 4)}-${linked.slice(4)}`}
              </p>
            )}
            {!pending && (
              <form onSubmit={(e) => void look(e)} noValidate className="flex flex-col gap-3">
                <TextField
                  label={linked ? 'Last 4 letters' : 'Code'}
                  placeholder={linked ? 'GHJK' : 'BCDF-GHJK'}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={linked ? 4 : 9}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  error={error}
                  data-vscode-code=""
                />
                <Button type="submit" loading={busy} className="min-h-11">
                  Check
                </Button>
              </form>
            )}
            {pending && (
              <div className="flex flex-col gap-3" data-vscode-pending="">
                <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
                  <Monitor className="size-5 shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block font-semibold [overflow-wrap:anywhere]">{pending.client}</span>
                    <span className="block text-sm text-muted">{new Date(pending.createdAt).toLocaleTimeString()}</span>
                  </span>
                </div>
                <p className="text-base [overflow-wrap:anywhere]" data-vscode-from="">
                  From <span className="font-mono font-semibold">{pending.ip ?? 'an unknown address'}</span>
                </p>
                {!pending.sameAddress && (
                  <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger [overflow-wrap:anywhere]" data-vscode-elsewhere="">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    Not your address ({pending.viewerIp ?? 'unknown'}). Deny it unless you started it there.
                  </p>
                )}
                <p className="text-sm text-ink-soft">Approve only a code your own VS Code shows.</p>
                {error && (
                  <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">
                    {error}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button variant="secondary" className="min-h-11 flex-1" onClick={() => void answer('deny')} disabled={busy} data-vscode-deny="">
                    Deny
                  </Button>
                  <Button className="min-h-11 flex-1" onClick={() => void answer('approve')} loading={busy} data-vscode-approve="">
                    Approve
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
