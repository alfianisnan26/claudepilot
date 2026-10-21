import { Button, TextField } from '@isnanme/ui';
import { normalizeUserCode, type VscodePending } from '@portal/contracts';
import { Check, Monitor, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { errorText, api } from '@/lib/api';

/**
 * The VS Code extension's sign-in (docs/prd/vscode-extension.md §4): the person checks the code their VS Code shows, sees which client asks
 * and from where, and approves or denies it. Nothing is approved by opening the link: the code is filled in, the click is the person's.
 */
export function VscodePage() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [pending, setPending] = useState<VscodePending | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'approve' | 'deny' | null>(null);

  const look = async (typed: string) => {
    setError(undefined);
    setPending(null);
    if (!normalizeUserCode(typed)) return setError('Eight letters, like BCDF-GHJK.');
    setBusy(true);
    try {
      setPending(await api.vscodePending(typed));
    } catch (e) {
      setError(errorText(e, 'Could not check the code.'));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const first = params.get('code');
    if (first) void look(first);
    // Only the code the page was opened with is looked up by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const answer = async (decision: 'approve' | 'deny') => {
    if (!pending) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.vscodeAnswer(pending.userCode, decision);
      setDone(decision);
    } catch (e) {
      setError(errorText(e, 'Could not answer.'));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void look(code);
  };

  return (
    <>
      <PageHeader
        title="VS Code"
        description="Sign in the ClaudePilot extension. Approve only a code your own VS Code shows: it gets a token for 30 days that reads your agents, tickets and usage, sends messages and answers approvals. Revoke it in Access, MCP tokens, or sign out in VS Code."
      />
      <Card className="mx-auto flex max-w-md flex-col gap-4 p-5">
        {done ? (
          <p className="flex items-center gap-2 font-semibold" data-vscode-done={done} role="status">
            {done === 'approve' ? <Check className="size-5 text-accent" aria-hidden="true" /> : <X className="size-5 text-danger" aria-hidden="true" />}
            {done === 'approve' ? 'Approved. Back to VS Code.' : 'Denied.'}
          </p>
        ) : (
          <>
            <form onSubmit={submit} noValidate className="flex flex-col gap-3">
              <TextField
                label="Code"
                placeholder="BCDF-GHJK"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                error={error}
                data-vscode-code=""
              />
              {!pending && (
                <Button type="submit" loading={busy}>
                  Check
                </Button>
              )}
            </form>
            {pending && (
              <div className="flex flex-col gap-3" data-vscode-pending="">
                <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
                  <Monitor className="size-5 shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block font-semibold [overflow-wrap:anywhere]">{pending.client}</span>
                    <span className="block text-sm text-muted [overflow-wrap:anywhere]">
                      {pending.ip ?? 'unknown address'} · {new Date(pending.createdAt).toLocaleTimeString()}
                    </span>
                  </span>
                </div>
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
