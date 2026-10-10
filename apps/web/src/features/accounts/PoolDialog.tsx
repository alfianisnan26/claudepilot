import { Button, FormDialog, Select, SwitchRow, TextField } from '@isnanme/ui';
import { ANTHROPIC_ENDPOINT_ID, type Account, type AccountPool, type Endpoint, type PoolStrategy } from '@portal/contracts';
import { ArrowDown, ArrowUp, LogIn, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';

/** Create or edit an account pool: endpoint, members in priority order, strategy (PRD FR7). */
export function PoolDialog({
  open,
  pool,
  endpoints,
  accounts,
  pools,
  onClose,
  onSaved,
}: {
  open: boolean;
  pool: AccountPool | null;
  endpoints: Endpoint[];
  accounts: Account[];
  pools: AccountPool[];
  onClose: () => void;
  onSaved: (pool: AccountPool) => void;
}) {
  const [name, setName] = useState('');
  const [endpointId, setEndpointId] = useState(ANTHROPIC_ENDPOINT_ID);
  const [members, setMembers] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<PoolStrategy>('fill-first');
  const [hideLogin, setHideLogin] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(pool?.name ?? '');
    setEndpointId(pool?.endpointId ?? ANTHROPIC_ENDPOINT_ID);
    setMembers(pool?.members.map((m) => m.accountId) ?? []);
    setStrategy(pool?.strategy ?? 'fill-first');
    setHideLogin(pool?.hideLogin ?? false);
    setErrors({});
    setFormError(null);
  }, [open, pool]);

  // Accounts on this endpoint that aren't in another pool (an account belongs to one pool).
  const inOtherPool = useMemo(
    () => new Set(pools.filter((p) => p.id !== pool?.id).flatMap((p) => p.members.map((m) => m.accountId))),
    [pools, pool],
  );
  const candidates = accounts.filter((a) => a.endpointId === endpointId && !members.includes(a.id) && !inOtherPool.has(a.id));
  const byId = (id: string) => accounts.find((a) => a.id === id);
  const move = (i: number, by: number) =>
    setMembers((m) => {
      const next = [...m];
      const [x] = next.splice(i, 1);
      next.splice(i + by, 0, x!);
      return next;
    });

  const submit = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const body = { name, endpointId, members, strategy, hideLogin };
      onSaved(pool ? await api.accounts.updatePool(pool.id, body) : await api.accounts.createPool(body));
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === 'object') setErrors(e.details as Record<string, string>);
      setFormError(e instanceof Error ? e.message : 'Could not save the pool.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={pool ? 'Edit pool' : 'New pool'}
      description="Workspaces assigned to a pool use its first usable account, and move to the next one when that account stops working."
      onSubmit={submit}
      submitLabel="Save"
      saving={saving}
      error={formError}
      dirty={!!name || members.length > 0}
    >
      <div className="flex flex-col gap-4">
        <TextField label="Name" autoComplete="off" value={name} onChange={(e) => (setName(e.target.value), setErrors(({ name: _, ...r }) => r))} error={errors.name} data-autofocus />
        <Select
          label="Endpoint"
          value={endpointId}
          disabled={!!pool && pool.workspaces > 0}
          hint={pool && pool.workspaces > 0 ? 'Unassign its workspaces to change the endpoint.' : 'Every account in a pool uses the same endpoint.'}
          onChange={(v) => (setEndpointId(v), setMembers([]))}
          options={endpoints.map((e) => ({ value: e.id, label: e.kind === 'anthropic' ? 'Anthropic API' : e.name }))}
          error={errors.endpointId}
        />

        <div>
          <p className="mb-2 text-sm font-semibold text-ink-soft">Accounts, in order</p>
          {members.length === 0 ? (
            <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">Add the accounts this pool can use.</p>
          ) : (
            <ol className="flex flex-col divide-y divide-line rounded-xl border border-line">
              {members.map((id, i) => {
                const a = byId(id);
                return (
                  <li key={id} className="flex items-center gap-2 px-3 py-2">
                    <span className="w-5 text-center text-[12px] font-semibold text-muted">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{a?.name ?? 'Removed account'}</p>
                      <p className="truncate font-mono text-[12px] text-muted">{a?.masked}</p>
                    </div>
                    <Button variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="Move down" disabled={i === members.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="Take out of the pool" onClick={() => setMembers((m) => m.filter((x) => x !== id))}>
                      <X className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ol>
          )}
          {errors.members && <p className="mt-1.5 text-[13px] font-medium text-danger">{errors.members}</p>}
          {candidates.length > 0 && (
            <div className="mt-2">
              <Select
                label="Add an account"
                hideLabel
                value=""
                placeholder="+ Add an account"
                onChange={(id) => id && setMembers((m) => [...m, id])}
                options={candidates.map((a) => ({ value: a.id, label: `${a.name} · ${a.masked}` }))}
              />
            </div>
          )}
        </div>

        <Select
          label="Strategy"
          value={strategy}
          onChange={(v) => setStrategy(v as PoolStrategy)}
          options={[
            { value: 'fill-first', label: 'Fill first: everyone on the first usable account' },
            { value: 'spread', label: 'Spread: the account with the fewest workspaces' },
          ]}
        />
        <SwitchRow
          icon={<LogIn className="size-[18px]" />}
          label="Hide /login in assigned workspaces"
          description="Off by default. Users can still sign in with their own account, but the pool's key takes precedence while assigned."
          checked={hideLogin}
          onChange={setHideLogin}
        />
      </div>
    </FormDialog>
  );
}
