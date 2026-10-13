import { Dialog, Button, Select, Spinner } from '@isnanme/ui';
import { workspaceDisplayName, type AccountPool, type Workspace } from '@portal/contracts';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';

const NONE = '';

/**
 * Change a workspace's account pool. Assigning one to a workspace that may have its own sign-in needs
 * an explicit override (Account Pool PRD §13); the preflight lists, by name only, what it overrides.
 */
export function AssignPoolDialog({
  workspace,
  pools,
  onClose,
  onDone,
}: {
  workspace: Workspace | null;
  pools: AccountPool[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const current = workspace?.account && workspace.account.state !== 'removing' ? workspace.account.poolId : NONE;
  const [poolId, setPoolId] = useState(NONE);
  const [findings, setFindings] = useState<string[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workspace) return;
    setPoolId(current);
    setError(null);
    setFindings(undefined);
    let cancelled = false;
    api.accounts
      .preflight(workspace.id)
      .then((r) => !cancelled && setFindings(r.findings))
      .catch(() => !cancelled && setFindings(null));
    return () => void (cancelled = true);
  }, [workspace, current]);

  const overriding = !!workspace && current === NONE && poolId !== NONE;
  const removing = current !== NONE && poolId === NONE;

  const save = async () => {
    if (!workspace) return;
    setSaving(true);
    setError(null);
    try {
      await api.accounts.assign(workspace.id, { poolId: poolId || null, confirmOverride: overriding });
      onDone(poolId ? `${workspaceDisplayName(workspace)} now uses ${pools.find((p) => p.id === poolId)?.name ?? 'the pool'}` : `${workspaceDisplayName(workspace)} goes back to its own sign-in`);
    } catch (e) {
      setError(errorText(e, 'Could not change the pool.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!workspace}
      onClose={() => !saving && onClose()}
      size="sm"
      title="Account pool"
      description={workspace ? `Which keys Claude Code in ${workspaceDisplayName(workspace)} uses.` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant={overriding ? 'danger' : 'primary'} loading={saving} disabled={poolId === current} onClick={() => void save()}>
            {overriding ? 'Assign and override sign-in' : removing ? 'Remove pool' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label="Pool"
          value={poolId}
          onChange={setPoolId}
          options={[{ value: NONE, label: 'None (its own sign-in)' }, ...pools.map((p) => ({ value: p.id, label: p.name }))]}
        />

        {overriding && (
          <div className="flex items-start gap-3 rounded-2xl bg-flame-soft px-4 py-3 text-[13px]">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-flame" />
            <div className="min-w-0 text-ink-soft">
              <p>
                This workspace may have its own sign-in. From its next request, Claude Code will use the pool’s key instead,
                usage will be billed to the pool’s account, and Remote Control and voice dictation will be off.
              </p>
              {findings === undefined && (
                <p className="mt-2 flex items-center gap-2 text-muted">
                  <Spinner className="size-3" /> Checking what it would override…
                </p>
              )}
              {findings === null && <p className="mt-2 text-muted">Not checked: the workspace isn’t running.</p>}
              {findings && findings.length > 0 && (
                <ul className="mt-2 list-disc pl-4">
                  {findings.map((f) => (
                    <li key={f} className="font-mono text-[12px]">
                      {f}
                    </li>
                  ))}
                </ul>
              )}
              {findings && findings.length === 0 && <p className="mt-2 text-muted">No other credentials found in its settings.</p>}
            </div>
          </div>
        )}

        {removing && (
          <p className="text-[13px] text-ink-soft">
            The pool’s files are removed in two safe steps. Running Claude Code sessions should be restarted to pick up the
            workspace’s own sign-in.
          </p>
        )}

        {error && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
