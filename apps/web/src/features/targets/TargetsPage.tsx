import { Button, EmptyState, LoadError, RowsSkeleton, useToast } from '@isnanme/ui';
import type { ConnectScannedView, ConnectSettings, ConnectTargetRow, ConnectTargetView } from '@portal/contracts';
import { ChevronRight, Container, Eye, EyeOff, Plus, Server, Settings, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { ApiError, errorText } from '@/lib/api';
import { useLive, useLiveConnected } from '@/lib/live';
import { connectApi } from './api';
import { AddTargetDialog, type WizardMode } from './AddTargetDialog';
import { Dot } from './Dot';
import { PortalSettingsDialog } from './SettingsSheet';
import { TargetSheet } from './TargetSheet';
import { dotOf, isEnrolled, rowLine } from './view';

const POLL_MS = 10_000;

const KindIcon = ({ kind }: { kind: string }) => {
  const Icon = kind === 'host' ? SquareTerminal : kind === 'container' ? Container : Server;
  return <Icon className="size-5" aria-hidden="true" />;
};

/** The Targets page: scanned and enrolled targets in one list, the Add wizard, the detail sheet and the portal's Connect settings. */
export function TargetsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<ConnectTargetRow[] | null>(null);
  const [settings, setSettings] = useState<ConnectSettings | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardMode | null>(null);
  const [gear, setGear] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await connectApi.list();
      setRows(next);
      setFailed(null);
      setDenied(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setDenied(true);
      else setFailed(errorText(e, 'Could not load targets.'));
    }
  }, []);

  useEffect(() => {
    void load();
    connectApi.settings().then(setSettings, () => undefined);
  }, [load]);

  const live = useLiveConnected();
  useLive('connect', () => void load());
  useEffect(() => {
    if (live) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [live, load]);

  const visible = useMemo(() => rows?.filter((r) => isEnrolled(r) || !r.hidden) ?? [], [rows]);
  const hidden = useMemo(() => (rows?.filter((r) => !isEnrolled(r) && r.hidden) ?? []) as ConnectScannedView[], [rows]);
  const open = rows?.find((r): r is ConnectTargetView => isEnrolled(r) && r.id === openId) ?? null;

  const hide = async (r: ConnectScannedView, hiddenNow: boolean) => {
    try {
      await connectApi.hideScanned(r.id, { hidden: hiddenNow });
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not change it.'), 'error');
    }
  };

  const add = (
    <div className="flex items-center gap-2">
      <Button variant="ghost" aria-label="Settings" className="!px-3" icon={<Settings className="size-5" />} onClick={() => setGear(true)} disabled={!settings || denied} />
      <Button aria-label="Add target" icon={<Plus className="size-4" />} onClick={() => setWizard({ type: 'new' })} disabled={denied || !rows}>
        <span className="hidden sm:inline">Add</span>
      </Button>
    </div>
  );

  return (
    <>
      <PageHeader title="Targets" description="Where workspaces run: this portal’s own Docker and Kubernetes, and machines that connect to it." action={add} />

      {failed && !rows && <LoadError onRetry={load} message={failed} />}
      {denied && <EmptyState icon={<Server className="size-6" />} title="No access">Targets are managed by an administrator.</EmptyState>}
      {!rows && !failed && !denied && <RowsSkeleton rows={3} lines={1} trailing icon="rounded-2xl" label="Loading targets" />}

      {rows && visible.length === 0 && hidden.length === 0 && (
        <EmptyState icon={<Server className="size-6" />} title="No targets" action={<Button icon={<Plus className="size-4" />} onClick={() => setWizard({ type: 'new' })}>Add</Button>} />
      )}

      {rows && (visible.length > 0 || hidden.length > 0) && (
        <div className="flex flex-col gap-3">
          {failed && <LoadError onRetry={load} message={failed} />}
          {visible.length > 0 && (
            <Card>
              <ul className="divide-y divide-line">
                {visible.map((r) => (
                  <Row key={`${r.source}:${r.id}`} r={r} onOpen={() => setOpenId(r.id)} onHide={(s) => void hide(s, true)} />
                ))}
              </ul>
            </Card>
          )}
          {hidden.length > 0 && (
            <div className="flex flex-col gap-2">
              <Button variant="ghost" size="sm" className="self-start" icon={showHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />} aria-expanded={showHidden} onClick={() => setShowHidden((s) => !s)}>
                {showHidden ? 'Hide the hidden' : `Hidden · ${hidden.length}`}
              </Button>
              {showHidden && (
                <Card>
                  <ul className="divide-y divide-line">
                    {hidden.map((r) => (
                      <li key={r.id} className="flex min-h-14 min-w-0 items-center gap-3 px-4 py-2 sm:px-5">
                        <span className="min-w-0 flex-1 truncate text-sm text-muted" title={r.label}>
                          {r.label}
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => void hide(r, false)}>
                          Unhide
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          )}
        </div>
      )}

      <TargetSheet
        target={open}
        onClose={() => setOpenId(null)}
        onChanged={() => void load()}
        onCommand={(t, upgrade) => setWizard({ type: 'command', target: t, upgrade })}
        denied={null}
      />
      <AddTargetDialog open={!!wizard} mode={wizard ?? { type: 'new' }} rows={rows ?? []} settings={settings} onClose={() => setWizard(null)} onChanged={() => void load()} />
      <PortalSettingsDialog open={gear} rows={rows ?? []} settings={settings} onClose={() => setGear(false)} onSaved={setSettings} />
    </>
  );
}

function Row({ r, onOpen, onHide }: { r: ConnectTargetRow; onOpen: () => void; onHide: (r: ConnectScannedView) => void }) {
  const line = rowLine(r);
  const body = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-soft">
        <KindIcon kind={r.kind} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <Dot kind={dotOf(r)} />
          <p className="min-w-0 truncate font-semibold" title={r.label}>
            {r.label}
          </p>
        </div>
        <p className="mt-0.5 truncate text-[13px] text-muted" title={isEnrolled(r) ? (r.problem ?? line) : line}>
          {line}
        </p>
      </div>
    </>
  );
  if (!isEnrolled(r))
    return (
      <li className="flex min-h-[72px] min-w-0 items-center gap-3 px-4 py-3 sm:px-5">
        {body}
        {!r.available && (
          <Button variant="ghost" size="sm" className="min-h-11" aria-label={`Hide ${r.label}`} onClick={() => onHide(r)}>
            Hide
          </Button>
        )}
      </li>
    );
  return (
    <li>
      <button type="button" onClick={onOpen} aria-label={`${r.label}, ${line}`} className="press flex min-h-[72px] w-full min-w-0 items-center gap-3 px-4 py-3 text-left sm:px-5">
        {body}
        <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />
      </button>
    </li>
  );
}
