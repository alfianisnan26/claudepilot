import { Badge, Button, Dialog, Spinner, useToast } from '@isnanme/ui';
import { workspaceDisplayName, type AccountPool, type Workspace, type WorkspaceDeliveryState, type WorkspacePoolAssignment, type WorkspacePools } from '@portal/contracts';
import { KeySquare, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { DELIVERY_LABEL } from '@/features/pools/labels';
import { PoolPickerDialog } from '@/features/pools/PoolPicker';
import { ClaudeCodeSection } from '@/features/claudeversion/ClaudeCodeSection';
import { multiPoolTabs, type MultiPoolTab } from '@/features/pools/registry';
import { LockdownLine } from '@/features/settings/LockdownLine';
import { api } from '@/lib/api';
import { formatDateTime, formatUntil, timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { AssignPoolDialog } from './AssignPoolDialog';

/**
 * Workspace → Configuration (foundation PRD §10): one row per pool type with what the workspace has,
 * the delivery status with its time and reason, and a change control. The account pool row keeps its
 * own dialog (the sign-in override); the other types pick from their pools. The engine reports one
 * delivery status per workspace, so each row with pools shows that one.
 */
export function ConfigurationSheet({
  workspace,
  accountPools,
  onClose,
  onChanged,
}: {
  /** The workspace as the live list has it now. */
  workspace: Workspace | null;
  accountPools: AccountPool[];
  onClose: () => void;
  /** An assignment changed: the list should load again. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<WorkspacePools | null>(null);
  const [failed, setFailed] = useState(false);
  const [changingAccount, setChangingAccount] = useState(false);
  const [picking, setPicking] = useState<MultiPoolTab | null>(null);
  const tabs = multiPoolTabs();
  const id = workspace?.id;

  const load = useCallback(async () => {
    if (!id || multiPoolTabs().length === 0) return;
    try {
      setData(await api.pools.workspace(id));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);
  useEffect(() => {
    setData(null);
    setFailed(false);
    void load();
  }, [load]);
  useLive('pools', () => void load(), !!id);

  // The live list's delivery state is the freshest; the pools call adds when it was last checked.
  const delivery = workspace?.delivery ?? data?.delivery ?? null;
  const assignmentsOf = (t: MultiPoolTab) => data?.types.find((x) => x.type === t.pool.type)?.assignments;
  const account = workspace?.account ?? null;

  return (
    <>
      <Dialog
        open={!!workspace}
        // A dialog opened from here closes on its own first.
        onClose={() => !changingAccount && !picking && onClose()}
        title="Configuration"
        description={workspace ? `What the portal delivers into ${workspaceDisplayName(workspace)}.` : undefined}
      >
        {workspace && (
          <div className="flex flex-col gap-4">
            <DeliveryLine delivery={delivery} checkedAt={data?.delivery?.checkedAt ?? null} />
            <LockdownLine workspaceId={workspace.id} />
            <ClaudeCodeSection workspace={workspace} />
            <ul className="divide-y divide-line rounded-2xl border border-line">
              <Row
                icon={KeySquare}
                label="Account pool"
                status={account ? delivery : null}
                onChange={() => setChangingAccount(true)}
                disabled={workspace.status === 'creating'}
              >
                {!account
                  ? 'None: its own sign-in'
                  : account.state === 'removing'
                    ? `Removing ${account.poolName}…`
                    : account.state === 'waiting'
                      ? `${account.poolName} · ${account.waitingUntil ? `waiting for quota until ${formatUntil(account.waitingUntil)}` : 'waiting for a usable account'}`
                      : `${account.poolName} · ${account.accountName}`}
              </Row>
              {tabs.map((t) => {
                const assignments = assignmentsOf(t);
                // A type the web knows but this portal doesn't serve has no row.
                if (data && !assignments) return null;
                const Detail = t.pool.ConfigurationDetail;
                return (
                  <Row
                    key={t.id}
                    icon={t.pool.icon}
                    label={t.label}
                    status={assignments?.length ? delivery : null}
                    onChange={() => setPicking(t)}
                    disabled={!assignments}
                    extra={assignments && Detail ? <Detail workspace={workspace} assignments={assignments} /> : undefined}
                  >
                    {!assignments ? (
                      failed ? (
                        'Could not load.'
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <Spinner className="size-3" /> Loading…
                        </span>
                      )
                    ) : (
                      <PoolNames assignments={assignments} />
                    )}
                  </Row>
                );
              })}
            </ul>
          </div>
        )}
      </Dialog>
      <AssignPoolDialog
        workspace={changingAccount ? workspace : null}
        pools={accountPools}
        onClose={() => setChangingAccount(false)}
        onDone={(message) => {
          setChangingAccount(false);
          toast(message);
          onChanged();
        }}
      />
      <PoolPickerDialog
        workspace={picking ? workspace : null}
        tab={picking}
        assignments={(picking && assignmentsOf(picking)) || []}
        onClose={() => setPicking(null)}
        onDone={(message, warnings) => {
          setPicking(null);
          toast(warnings.length ? `${message}. ${warnings.join(' ')}` : message);
          void load();
          onChanged();
        }}
      />
    </>
  );
}

/** The workspace's delivery state: status, when it last changed, the Claude Code version, and why. */
function DeliveryLine({ delivery, checkedAt }: { delivery: WorkspaceDeliveryState | null; checkedAt: string | null }) {
  if (!delivery) return <p className="text-[13px] text-muted">Nothing delivered yet.</p>;
  const s = DELIVERY_LABEL[delivery.status] ?? { label: delivery.status, tone: 'neutral' as const };
  const when = delivery.appliedAt ?? checkedAt;
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-surface-2 px-4 py-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
        <Badge tone={s.tone}>
          {s.busy && <Spinner className="size-3" />}
          {s.label}
        </Badge>
        {when && (
          <span title={formatDateTime(when)}>
            {delivery.appliedAt ? 'applied' : 'checked'} {timeAgo(when)}
          </span>
        )}
        {delivery.claudeVersion && <span>· Claude Code {delivery.claudeVersion.replace(/\s*\(Claude Code\)/, '')}</span>}
      </div>
      {delivery.reason && <p className="text-ink-soft">{delivery.reason}</p>}
    </div>
  );
}

function PoolNames({ assignments }: { assignments: WorkspacePoolAssignment[] }) {
  if (assignments.length === 0) return <>None</>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {assignments.map((a) => (
        <span key={a.poolId} className={a.state === 'removing' ? 'text-muted' : undefined}>
          {a.state === 'removing' ? (
            `Removing ${a.poolName}…`
          ) : (
            <>
              {a.poolName}
              {a.revision > 0 && <span className="ml-1 font-mono text-[11.5px] text-muted">r{a.revision}</span>}
              {a.pinnedRevision !== null && <span className="ml-1 text-[11.5px] text-muted">pinned</span>}
              {a.revision === 0 && <span className="ml-1 text-[11.5px] text-muted">nothing deliverable yet</span>}
            </>
          )}
        </span>
      ))}
    </span>
  );
}

function Row({
  icon: Icon,
  label,
  status,
  children,
  extra,
  onChange,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  /** Shown when the row has something delivered. */
  status: WorkspaceDeliveryState | null;
  children: ReactNode;
  extra?: ReactNode;
  onChange: () => void;
  disabled?: boolean;
}) {
  const s = status ? (DELIVERY_LABEL[status.status] ?? { label: status.status, tone: 'neutral' as const }) : null;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-soft">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-sm font-semibold">{label}</p>
          {s && <Badge tone={s.tone}>{s.label}</Badge>}
        </div>
        <div className="mt-0.5 text-[13px] text-ink-soft">{children}</div>
        {extra && <div className="mt-2">{extra}</div>}
      </div>
      <Button variant="ghost" size="sm" onClick={onChange} disabled={disabled}>
        Change
      </Button>
    </li>
  );
}
