import type { AdminWorkspaceRow } from '@portal/contracts';
import { Play, Square } from 'lucide-react';
import { useState } from 'react';
import { api } from './api';
import { btnPlain, chip, Confirm, Empty, list, Section, useList, type Run } from './ui';

/*
 * Workspaces: every workspace on every target (name, owner, state, image; never its files or sessions) and every target with whether it
 * answers. Start and Stop are the main portal's: the portal decides as it does there, so another person's workspace is refused (an admin
 * holds no right on it, D12) and an org's needs a role in it or an open break-glass entry.
 */

const RUNNING = new Set(['running', 'starting']);

function ownerText(o: AdminWorkspaceRow['owner']): string {
  if (o.kind === 'none') return 'unclaimed';
  if (o.kind === 'platform') return 'portal';
  return `${o.kind} ${o.name ?? o.id ?? ''}`.trim();
}

export function WorkspacesView({ run }: { run: Run }) {
  const { items, reload } = useList(run, api.workspaces);
  const targets = useList(run, api.targets);
  const [ask, setAsk] = useState<{ w: AdminWorkspaceRow; verb: 'start' | 'stop' } | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Workspaces"
        onReload={reload}
        tip="Every workspace on every target. Start and Stop work where you have the right; another person’s workspace stays theirs."
      >
        <Empty items={items} />
        <ul className={list}>
          {items?.map((w) => {
            const up = RUNNING.has(w.status);
            return (
              <li key={w.id} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="break-any block text-sm font-medium">{w.label}</span>
                  <span className="break-any block text-xs text-muted">
                    {w.target} · {ownerText(w.owner)}
                  </span>
                  <span className="break-any block text-xs text-muted">{w.image}</span>
                </span>
                <span className={`${chip} shrink-0 ${up ? 'bg-accent-soft' : 'bg-surface-2'}`}>{w.status}</span>
                <button
                  type="button"
                  className={btnPlain}
                  aria-label={up ? `Stop ${w.label}` : `Start ${w.label}`}
                  title={up ? 'Stop' : 'Start'}
                  disabled={w.status === 'creating' || w.status === 'unreachable' || w.status === 'unavailable'}
                  onClick={() => setAsk({ w, verb: up ? 'stop' : 'start' })}
                >
                  {up ? <Square size={18} aria-hidden /> : <Play size={18} aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title="Targets" onReload={targets.reload} tip="Where workspaces run: Docker, Kubernetes, this machine, and the hosts that dial in through Connect.">
        <Empty items={targets.items} />
        <ul className={list}>
          {targets.items?.map((t) => (
            <li key={t.id} className="flex flex-col gap-0.5 px-3 py-2">
              <span className="flex items-center gap-2">
                <span className="break-any min-w-0 flex-1 text-sm font-medium">{t.label}</span>
                <span className={`${chip} ${t.available ? 'bg-accent-soft' : 'bg-danger-soft text-danger'}`}>{t.available ? 'up' : 'down'}</span>
              </span>
              <span className="break-any text-xs text-muted">
                {t.kind}
                {t.source === 'enrolled' ? ' · Connect' : ''}
                {t.role ? ` · ${t.role}` : ''} · {t.where}
              </span>
              {t.problem && <span className="break-any text-xs text-danger">{t.problem}</span>}
            </li>
          ))}
        </ul>
      </Section>
      {ask && (
        <Confirm
          title={ask.verb === 'start' ? 'Start' : 'Stop'}
          body={`${ask.verb === 'start' ? 'Start' : 'Stop'} ${ask.w.label} on ${ask.w.target}?`}
          action={ask.verb === 'start' ? 'Start' : 'Stop'}
          danger={ask.verb === 'stop'}
          onConfirm={async () => {
            const r = await run(() => (ask.verb === 'start' ? api.startWorkspace(ask.w.id) : api.stopWorkspace(ask.w.id)));
            if (r) reload();
            return !!r;
          }}
          onClose={() => setAsk(null)}
        />
      )}
    </div>
  );
}
