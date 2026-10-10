import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  LoadError,
  Menu,
  RowsSkeleton,
  Section,
  useToast,
  type MenuItem,
} from '@isnanme/ui';
import type { Account, AccountsOverview, Endpoint } from '@portal/contracts';
import { Globe, KeySquare, Lock, Pencil, Plus, Power, RefreshCw, Server, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { api, errorText } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { AddAccountDialog } from './AddAccountDialog';
import { CHECK } from './checks';
import { EditAccountDialog } from './EditAccountDialog';
import { EndpointDialog } from './EndpointDialog';

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
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setData(await api.accounts.overview());
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const pending = !!data?.accounts.some((a) => a.hasSecret && a.enabled && a.check.result === 'unknown');
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => void load().catch(() => undefined), POLL_MS);
    return () => clearTimeout(t);
  }, [data, pending, load]);

  const replace = (a: Account) => setData((d) => (d ? { ...d, accounts: d.accounts.map((x) => (x.id === a.id ? a : x)) } : d));

  const check = async (a: Account) => {
    setChecking((s) => new Set(s).add(a.id));
    try {
      const next = await api.accounts.check(a.id);
      replace(next);
      toast(`${a.name}: ${CHECK[next.check.result].label}`, CHECK[next.check.result].working ? undefined : 'error');
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

  const endpointName = (id: string) => {
    const e = data?.endpoints.find((x) => x.id === id);
    return e ? (e.kind === 'anthropic' ? 'Anthropic API' : e.name) : id;
  };
  const locked = data?.locked ?? null;

  return (
    <>
      <PageHeader
        title="Accounts"
        description="API keys for Claude Code in your workspaces: the Anthropic API or your own gateways."
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
        <div className="flex flex-col gap-8">
          {locked && (
            <div role="status" className="flex items-start gap-3 rounded-2xl bg-flame-soft px-4 py-3 text-sm">
              <Lock className="mt-0.5 size-4 shrink-0 text-flame" />
              <p className="text-ink-soft">
                <span className="font-semibold text-ink">Keys are locked.</span> {locked.reason}{' '}
                <Link to="/admin/access" className="font-semibold text-ink underline underline-offset-2">
                  Storage status
                </Link>
              </p>
            </div>
          )}

          <Section title="Keys">
            {data.accounts.length === 0 ? (
              <EmptyState
                icon={<KeySquare className="size-6" />}
                title="No keys yet"
                action={
                  <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)} disabled={!!locked}>
                    Add key
                  </Button>
                }
              >
                Add an Anthropic API key (or a key for your own gateway). It's encrypted, checked, and later
                handed to Claude Code in the workspaces you choose.
              </EmptyState>
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
            title="Endpoints"
            description="Where keys are used. Claude Code talks to the endpoint directly; the portal is never in between."
            action={
              <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEndpointDialog({ endpoint: null })}>
                Custom host
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
        description="The encrypted key is deleted from the portal. This doesn't revoke it at Anthropic or your gateway; do that there if the key is compromised."
        confirmLabel="Remove"
        loading={busy}
        onConfirm={() => void remove()}
        onClose={() => !busy && setRemoving(null)}
      />
      <ConfirmDialog
        open={!!removingEndpoint}
        title={`Remove ${removingEndpoint?.name ?? ''}?`}
        description="The host is removed from the portal. Hosts with keys can't be removed; remove their keys first."
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
  onEdit,
  onToggle,
  onRemove,
}: {
  account: Account;
  endpointName: string;
  checking: boolean;
  locked: boolean;
  onCheck: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const state = CHECK[a.check.result];
  const items: MenuItem[] = [
    { label: 'Check now', icon: <RefreshCw className="size-4" />, onSelect: onCheck, disabled: locked || !a.hasSecret || checking },
    { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: onEdit },
    { label: a.enabled ? 'Disable' : 'Enable', icon: <Power className="size-4" />, onSelect: onToggle },
    { label: 'Remove', icon: <Trash2 className="size-4" />, onSelect: onRemove, danger: true },
  ];
  const meta = [a.masked, endpointName, a.organizationId && `org ${a.organizationId.replace(/^org-?/, '').slice(0, 8)}`].filter(Boolean).join(' · ');

  return (
    <li className={`flex items-start gap-3 p-4 sm:items-center sm:px-5 ${a.enabled ? '' : 'opacity-60'}`}>
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${state.working ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-soft'}`}
      >
        <KeySquare className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate font-semibold">{a.name}</p>
          {!a.enabled && <Badge tone="neutral">Disabled</Badge>}
          {a.hasSecret ? (
            <Badge tone={state.tone}>
              {checking ? 'Checking…' : state.label}
              {!checking && state.tag && <span className="font-mono text-[10.5px] opacity-70">{state.tag}</span>}
            </Badge>
          ) : (
            <Badge tone="warning">Re-enter key</Badge>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-[12.5px] text-muted">{meta}</p>
        {a.check.detail && !state.working && <p className="mt-1 line-clamp-2 text-[13px] text-ink-soft">{a.check.detail}</p>}
        {a.check.at && (
          <p className="mt-0.5 text-[12px] text-muted" title={formatDateTime(a.check.at)}>
            Checked {timeAgo(a.check.at)}
          </p>
        )}
      </div>
      <Menu label={`Actions for ${a.name}`} items={items} />
    </li>
  );
}

function EndpointCard({ endpoint: e, onEdit, onRemove }: { endpoint: Endpoint; onEdit: () => void; onRemove: () => void }) {
  const builtIn = e.kind === 'anthropic';
  const models = Object.entries(e.modelNames).filter(([, v]) => v);
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-soft">
        {builtIn ? <Globe className="size-4" /> : <Server className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold">{builtIn ? 'Anthropic API' : e.name}</p>
          {builtIn && <Badge tone="neutral">Built in</Badge>}
        </div>
        <p className="truncate font-mono text-[12px] text-muted">{e.baseUrl}</p>
        <p className="mt-0.5 text-[12px] text-muted">
          {e.accounts === 1 ? '1 key' : `${e.accounts} keys`}
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
