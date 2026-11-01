import type { AdminAuditEntry } from '@portal/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TabBar } from '../components/TabBar';
import { WindowedList } from '../components/WindowedList';
import { api } from './api';
import { AUDIT_KINDS, AUDIT_TAB_LABEL, AUDIT_TABS, ago, auditDates, auditTabKind, auditWho, type AuditTab } from './model';
import { chip, Empty, field, Section, useList, type Run } from './ui';

/*
 * Audit: the platform audit, newest first, in tabs (owner, 2026-11-01: the Usage pattern): All, Refused (the sign-ins the console turned away:
 * who tried, how, why, so the owner can allow them later), Org and Security (the console's own sign-ins, step-ups and failures). Each tab
 * keeps the filters by severity, who acted (exactly, or a prefix like `system:`), org and dates; All also by kind (or a prefix). THE windowed
 * list: it fills the pane and scrolls inside on a desktop, the tabs and filters above it; older rows load as the end comes into view.
 */

const PAGE = 50;

export function AuditView({ run }: { run: Run }) {
  const orgs = useList(run, api.orgs);
  const [tab, setTab] = useState<AuditTab>('all');
  const [kindText, setKindText] = useState('');
  const [severity, setSeverity] = useState<'' | 'info' | 'medium' | 'high'>('');
  const [actor, setActor] = useState('');
  const [org, setOrg] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<AdminAuditEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const kind = auditTabKind(tab) ?? kindText.trim();
  // A filter change while a page loads makes that answer stale: it is dropped.
  const seq = useRef(0);
  const load = useCallback(
    (before?: number) => {
      const mine = before ? seq.current : ++seq.current;
      if (before) setLoading(true);
      void run(() =>
        api.audit({ kind: kind || undefined, severity: severity || undefined, actor: actor.trim() || undefined, org: org || undefined, ...auditDates(from, to), before, limit: PAGE }),
      )
        .then((v) => {
          if (!v || mine !== seq.current) return;
          setRows((prev) => (before && prev ? [...prev, ...v.filter((r) => !prev.some((p) => p.id === r.id))] : v));
          setMore(v.length === PAGE);
        })
        .finally(() => before && setLoading(false));
    },
    [run, kind, severity, actor, org, from, to],
  );
  useEffect(() => load(), [load]);

  const filters = (
    <>
      <TabBar
        label="Audit"
        tabs={AUDIT_TABS.map((t) => ({ id: t, label: AUDIT_TAB_LABEL[t] }))}
        active={tab}
        onSelect={(t) => setTab(t as AuditTab)}
        className="-mx-4 mb-3 lg:mx-0"
        innerClassName="px-3 lg:px-0"
      />
      <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-6">
        {tab === 'all' && (
          <>
            <input className={`${field} col-span-2 lg:col-span-1`} placeholder="Kind" aria-label="Kind" list="audit-kinds" value={kindText} onChange={(e) => setKindText(e.target.value)} />
            <datalist id="audit-kinds">
              {AUDIT_KINDS.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </>
        )}
        <select className={field} aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
          <option value="">Any</option>
          <option value="info">info</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
        <select className={field} aria-label="Org" value={org} onChange={(e) => setOrg(e.target.value)}>
          <option value="">Any org</option>
          {orgs.items?.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <input className={`${field} col-span-2 lg:col-span-1`} placeholder="Who" aria-label="Who" value={actor} onChange={(e) => setActor(e.target.value)} />
        <input className={field} type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className={field} type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
    </>
  );

  return (
    <Section
      title="Audit"
      onReload={() => load()}
      tip="What happened on the portal and who did it. Kind takes a prefix (account matches every account row); Who takes a prefix ending in a colon."
    >
      <WindowedList
        label="Audit"
        items={rows ?? []}
        itemKey={(r) => String(r.id)}
        estimate={60}
        gap={0}
        header={filters}
        // On a phone the tabs and filters are too tall to stick: they scroll away with the page (the list is still windowed).
        stickyClassName=""
        hasMore={more}
        loadingMore={loading}
        onLoadMore={() => rows?.length && load(rows.at(-1)!.id)}
        empty={<Empty items={rows} />}
        renderItem={(r, i) => (
          <div className={`flex flex-col gap-0.5 border-x border-b border-line bg-surface px-3 py-2 text-sm ${i === 0 ? 'rounded-t-xl border-t' : ''} ${i === (rows?.length ?? 0) - 1 ? 'rounded-b-xl' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="break-any min-w-0 flex-1 font-medium">{r.kind}</span>
              {r.severity !== 'info' && <span className={`${chip} bg-danger-soft text-danger`}>{r.severity}</span>}
            </div>
            <span className="break-any text-xs text-muted">
              <time dateTime={r.at} title={new Date(r.at).toLocaleString()}>
                {ago(r.at)}
              </time>{' '}
              · {r.actor}
              {r.subject ? ` → ${r.subject}` : ''}
            </span>
            {auditWho(r.kind, r.detail) && <span className="break-any text-xs">{auditWho(r.kind, r.detail)}</span>}
          </div>
        )}
      />
    </Section>
  );
}
