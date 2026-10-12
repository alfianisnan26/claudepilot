import { Badge, Button, ConfirmDialog, LoadError, Menu, RowsSkeleton, Section, useToast, type MenuItem } from '@isnanme/ui';
import type { Account, AccountPool, AccountsOverview, Endpoint } from '@portal/contracts';
import { Globe, KeySquare, Layers, Lock, Pencil, Plus, Power, RefreshCw, RotateCcw, Server, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { KeyActions } from '@/features/admin/KeyDialogs';
import { api, errorText } from '@/lib/api';
import { useLive, useLiveConnected } from '@/lib/live';
import { formatDateTime, formatUntil, timeAgo } from '@/lib/format';
import { AddAccountDialog } from './AddAccountDialog';
import { CHECK, HEALTH } from './checks';
import { EditAccountDialog } from './EditAccountDialog';
import { EndpointDialog } from './EndpointDialog';
import { PoolDialog } from './PoolDialog';

/** While keys added in bulk are still being checked, refresh quickly. */
const POLL_MS = 2_000;

export function AccountsPage() {
  const toast = useToast();
  const [data, setData] = useState<AccountsOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const [endpointDialog, setEndpointDialog] = useState<{ endpoint: Endpoint | null } | null>(null);
  const [removingEndpoint, setRemovingEndpoint] = useState<Endpoint | null>(null);
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [pools, setPools] = useState<AccountPool[]>([]);
  const [poolDialog, setPoolDialog] = useState<{ pool: AccountPool | null } | null>(null);
  const [removingPool, setRemovingPool] = useState<AccountPool | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [overview, poolList] = await Promise.all([api.accounts.overview(), api.accounts.pools()]);
      setData(overview);
      setPools(poolList);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);

  // The portal says when accounts, pools or the lock change; poll only while the live socket is down.
  const live = useLiveConnected();
  useLive('accounts', () => void load());
  const pending = !!data?.accounts.some((a) => a.hasSecret && a.enabled && (a.check.result === 'unknown' || a.health.state === 'cooling'));
  useEffect(() => {
    if (live || !pending) return;
    const t = setTimeout(() => void load().catch(() => undefined), POLL_MS);
    return () => clearTimeout(t);
  }, [live, data, pending, load]);

  const replace = (a: Account) => setData((d) => (d ? { ...d, accounts: d.accounts.map((x) => (x.id === a.id ? a : x)) } : d));

  const clearHealth = async (a: Account) => {
    try {
      replace(await api.accounts.clearHealth(a.id));
      toast(`${a.name} is back in rotation`);
    } catch (e) {
      toast(errorText(e, 'Could not change it.'), 'error');
    }
  };

  const check = async (a: Account) => {
    setChecking((s) => new Set(s).add(a.id));
    try {
      const next = await api.accounts.check(a.id);
      replace(next);
      const health = next.health.state === 'ok' ? null : HEALTH[next.health.state];
      toast(`${a.name}: ${health?.label ?? CHECK[next.check.result].label}`, !health && CHECK[next.check.result].working ? undefined : 'error');
    } catch (e) {
      toast(errorText(e, 'Could not check it.'), 'error');
    } finally {
      setChecking((s) => {
        const n = new Set(s);
        n.delete(a.id);
        return n;
      });
    }
  };

  const toggle = async (a: Account) => {
    try {
      replace(await api.accounts.update(a.id, { enabled: !a.enabled }));
      toast(a.enabled ? `${a.name} disabled` : `${a.name} enabled`);
    } catch (e) {
      toast(errorText(e, 'Could not change it.'), 'error');
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.accounts.remove(removing.id);
      toast(`${removing.name} removed`);
      setRemoving(null);
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not remove it.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeEndpoint = async () => {
    if (!removingEndpoint) return;
    setBusy(true);
    try {
      await api.accounts.removeEndpoint(removingEndpoint.id);
      toast(`${removingEndpoint.name} removed`);
      setRemovingEndpoint(null);
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not remove it.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const removePool = async () => {
    if (!removingPool) return;
    setBusy(true);
    try {
      await api.accounts.removePool(removingPool.id);
      toast(`${removingPool.name} removed`);
      setRemovingPool(null);
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not remove it.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const endpointName = (id: string) => {
    const e = data?.endpoints.find((x) => x.id === id);
    return e ? (e.kind === 'anthropic' ? 'Anthropic API' : e.name) : id;
  };
  const locked = data?.locked ?? null;

  return (
    <>
      <PageHeader
        title="Accounts"
        action={
          data &&
          data.accounts.length > 0 && (
            <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)} disabled={!!locked}>
              <span className="hidden sm:inline">Add key</span>
              <span className="sm:hidden">Add</span>
            </Button>
          )
        }
      />

      {failed && <LoadError onRetry={load} />}
      {!data && !failed && <RowsSkeleton rows={3} lines={2} trailing icon="rounded-2xl" />}

      {data && (
        <div className="flex flex-col gap-6">
          {locked && (
            <div role="status" className="flex items-center gap-2.5 rounded-2xl bg-flame-soft py-2.5 pr-2.5 pl-4 text-sm">
              <Lock className="size-4 shrink-0 text-flame" />
              <p className="font-semibold">Keys locked</p>
              <InfoTip label="Why keys are locked">{locked.reason}</InfoTip>
              <span className="flex-1" />
              <KeyActions onDone={() => void load()} />
            </div>
          )}

          <Section
            title={
              <span className="inline-flex items-center gap-1">
                Keys
                <InfoTip label="About keys">
                  Anthropic API keys, or keys for your own gateway. Each is encrypted, checked without being billed, and
                  handed to Claude Code only in the workspaces whose pool includes it.
                </InfoTip>
              </span>
            }
          >
            {data.accounts.length === 0 ? (
              <EmptyLine icon={<KeySquare className="size-4" />} text="No keys yet">
                <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} disabled={!!locked}>
                  Add key
                </Button>
              </EmptyLine>
            ) : (
              <Card>
                <ul className="divide-y divide-line">
                  {data.accounts.map((a) => (
                    <AccountRow
                      key={a.id}
                      account={a}
                      endpointName={endpointName(a.endpointId)}
                      checking={checking.has(a.id)}
                      locked={!!locked}
                      onCheck={() => void check(a)}
                      onClear={() => void clearHealth(a)}
                      onEdit={() => setEditing(a)}
                      onToggle={() => void toggle(a)}
                      onRemove={() => setRemoving(a)}
                    />
                  ))}
                </ul>
              </Card>
            )}
          </Section>

          <Section
            title={
              <span className="inline-flex items-center gap-1">
                Pools
                <InfoTip label="About pools">
                  A pool groups keys in priority order. Assign it to workspaces: they use its first usable key and move
                  to the next when one stops working.
                </InfoTip>
              </span>
            }
            action={
              data.accounts.length > 0 && (
                <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setPoolDialog({ pool: null })}>
                  New
                </Button>
              )
            }
          >
            {pools.length === 0 ? (
              <EmptyLine icon={<Layers className="size-4" />} text={data.accounts.length === 0 ? 'No pools · add a key first' : 'No pools yet'}>
                {data.accounts.length > 0 && (
                  <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setPoolDialog({ pool: null })}>
                    New pool
                  </Button>
                )}
              </EmptyLine>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {pools.map((p) => (
                  <PoolCard
                    key={p.id}
                    pool={p}
                    endpointName={endpointName(p.endpointId)}
                    accounts={data.accounts}
                    onEdit={() => setPoolDialog({ pool: p })}
                    onRemove={() => setRemovingPool(p)}
                  />
                ))}
              </div>
            )}
          </Section>

          <Section
            title={
              <span className="inline-flex items-center gap-1">
                Endpoints
                <InfoTip label="About endpoints">
                  Where keys are used: the Anthropic API, or a custom host for your own gateway. Claude Code talks to it
                  directly; the portal is never in between.
                </InfoTip>
              </span>
            }
            action={
              <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEndpointDialog({ endpoint: null })}>
                Custom
              </Button>
            }
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {data.endpoints.map((e) => (
                <EndpointCard
                  key={e.id}
                  endpoint={e}
                  onEdit={() => setEndpointDialog({ endpoint: e })}
                  onRemove={() => setRemovingEndpoint(e)}
                />
              ))}
            </div>
          </Section>
        </div>
      )}

      <AddAccountDialog
        open={adding}
        endpoints={data?.endpoints ?? []}
        onClose={() => setAdding(false)}
        onAdded={(message) => {
          toast(message);
          void load();
        }}
      />
      <EditAccountDialog
        account={editing}
        onClose={() => setEditing(null)}
        onSaved={(a) => {
          replace(a);
          setEditing(null);
          toast(`${a.name} saved`);
        }}
      />
      <EndpointDialog
        open={!!endpointDialog}
        endpoint={endpointDialog?.endpoint ?? null}
        onClose={() => setEndpointDialog(null)}
        onSaved={(e) => {
          setEndpointDialog(null);
          toast(`${e.name} saved`);
          void load();
        }}
      />
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.name ?? ''}?`}
        description="Deletes the key here. It isn't revoked at the provider."
        confirmLabel="Remove"
        loading={busy}
        onConfirm={() => void remove()}
        onClose={() => !busy && setRemoving(null)}
      />
      <PoolDialog
        open={!!poolDialog}
        pool={poolDialog?.pool ?? null}
        endpoints={data?.endpoints ?? []}
        accounts={data?.accounts ?? []}
        pools={pools}
        onClose={() => setPoolDialog(null)}
        onSaved={(p) => {
          setPoolDialog(null);
          toast(`${p.name} saved`);
          void load();
        }}
      />
      <ConfirmDialog
        open={!!removingPool}
        title={`Remove ${removingPool?.name ?? ''}?`}
        description="Pools assigned to workspaces can't be removed."
        confirmLabel="Remove"
        loading={busy}
        onConfirm={() => void removePool()}
        onClose={() => !busy && setRemovingPool(null)}
      />
      <ConfirmDialog
        open={!!removingEndpoint}
        title={`Remove ${removingEndpoint?.name ?? ''}?`}
        description="Hosts with keys can't be removed."
        confirmLabel="Remove"
        loading={busy}
        onConfirm={() => void removeEndpoint()}
        onClose={() => !busy && setRemovingEndpoint(null)}
      />
    </>
  );
}

function AccountRow({
  account: a,
  endpointName,
  checking,
  locked,
  onCheck,
  onClear,
  onEdit,
  onToggle,
  onRemove,
}: {
  account: Account;
  endpointName: string;
  checking: boolean;
  locked: boolean;
  onCheck: () => void;
  onClear: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const state = CHECK[a.check.result];
  const health = a.health.state === 'ok' ? null : HEALTH[a.health.state];
  const working = state.working && !health;
  const items: MenuItem[] = [
    { label: 'Check now', icon: <RefreshCw className="size-4" />, onSelect: onCheck, disabled: locked || !a.hasSecret || checking },
    ...(health ? [{ label: health.clear, icon: <RotateCcw className="size-4" />, onSelect: onClear, disabled: locked }] : []),
    { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: onEdit },
    { label: a.enabled ? 'Disable' : 'Enable', icon: <Power className="size-4" />, onSelect: onToggle },
    { label: 'Remove', icon: <Trash2 className="size-4" />, onSelect: onRemove, danger: true },
  ];
  const meta = [a.masked, endpointName, a.organizationId && `org ${a.organizationId.replace(/^org-?/, '').slice(0, 8)}`].filter(Boolean).join(' · ');

  // What went wrong, when something did: shown in the badge's ⓘ, not as a paragraph.
  const problem = health ? a.health.detail : !state.working ? a.check.detail : null;

  return (
    <li className={`flex items-center gap-3 px-4 py-3.5 sm:px-5 ${a.enabled ? '' : 'opacity-60'}`}>
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${working ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-soft'}`}
      >
        <KeySquare className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate font-semibold">{a.name}</p>
          <span className="shrink-0" title={a.check.at ? `Checked ${timeAgo(a.check.at)} · ${formatDateTime(a.check.at)}` : undefined}>
            {!a.enabled ? (
              <Badge tone="neutral">Off</Badge>
            ) : a.hasSecret && health && !checking ? (
              <Badge tone={health.tone}>
                {health.label}
                {a.health.until && ` until ${formatUntil(a.health.until)}`}
              </Badge>
            ) : a.hasSecret ? (
              <Badge tone={state.tone}>{checking ? 'Checking…' : state.label}</Badge>
            ) : (
              <Badge tone="warning">Re-enter key</Badge>
            )}
          </span>
          {problem && <InfoTip label={`What's wrong with ${a.name}`}>{problem}</InfoTip>}
        </div>
        <p className="mt-0.5 truncate font-mono text-[12.5px] text-muted">{meta}</p>
      </div>
      <Menu label={`Actions for ${a.name}`} items={items} />
    </li>
  );
}

function EndpointCard({ endpoint: e, onEdit, onRemove }: { endpoint: Endpoint; onEdit: () => void; onRemove: () => void }) {
  const builtIn = e.kind === 'anthropic';
  const models = Object.entries(e.modelNames).filter(([, v]) => v);
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-soft">
        {builtIn ? <Globe className="size-4" /> : <Server className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold">{builtIn ? 'Anthropic API' : e.name}</p>
          {builtIn && <Badge tone="neutral">Built in</Badge>}
        </div>
        <p className="truncate text-[12px] text-muted" title={e.baseUrl}>
          {e.baseUrl.replace(/^https?:\/\//, '')} · {e.accounts === 1 ? '1 key' : `${e.accounts} keys`}
          {models.length > 0 && ` · ${models.length} model name${models.length > 1 ? 's' : ''}`}
          {e.allowPrivateNetwork && ' · private network'}
        </p>
      </div>
      {!builtIn && (
        <Menu
          label={`Actions for ${e.name}`}
          items={[
            { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: onEdit },
            { label: 'Remove', icon: <Trash2 className="size-4" />, onSelect: onRemove, danger: true, disabled: e.accounts > 0 },
          ]}
        />
      )}
    </div>
  );
}

function PoolCard({
  pool: p,
  endpointName,
  accounts,
  onEdit,
  onRemove,
}: {
  pool: AccountPool;
  endpointName: string;
  accounts: Account[];
  onEdit: () => void;
  onRemove: () => void;
}) {
  const members = p.members.map((m) => accounts.find((a) => a.id === m.accountId)).filter((a): a is Account => !!a);
  const working = members.filter((a) => a.enabled && CHECK[a.check.result].working).length;
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Layers className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate text-sm font-semibold">{p.name}</p>
          <span className="shrink-0">
            <Badge tone={working ? 'success' : 'danger'}>
              {working}/{members.length} working
            </Badge>
          </span>
        </div>
        <p
          className="truncate text-[12px] text-muted"
          title={members.length ? members.map((a, i) => `${i + 1}. ${a.name}`).join('\n') : 'No keys'}
        >
          {endpointName} · {p.workspaces === 1 ? '1 workspace' : `${p.workspaces} workspaces`}
        </p>
      </div>
      <Menu
        label={`Actions for ${p.name}`}
        items={[
          { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: onEdit },
          { label: 'Remove', icon: <Trash2 className="size-4" />, onSelect: onRemove, danger: true, disabled: p.workspaces > 0 },
        ]}
      />
    </div>
  );
}

/** An empty list in one line: what's missing, and the button that adds it. */
function EmptyLine({ icon, text, children }: { icon: ReactNode; text: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-dashed border-line py-2.5 pr-2.5 pl-4 text-sm text-muted">
      {icon}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {children}
    </div>
  );
}
