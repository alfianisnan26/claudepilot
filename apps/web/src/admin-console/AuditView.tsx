import type { AdminAuditEntry } from '@portal/contracts';
import { ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { AUDIT_KINDS, ago, auditDates, auditWho } from './model';
import { btnPlain, chip, Empty, field, list, Section, useList, type Run } from './ui';

/*
 * Audit: the platform audit, newest first, filtered by kind (or a prefix), severity, who acted (exactly, or a prefix like `system:`), org and
 * dates. "Refused" shows the sign-ins the console turned away (who tried, how, why), so the owner can allow them later.
 */

const PAGE = 50;
const REFUSED = 'admin.signin_refused';

export function AuditView({ run }: { run: Run }) {
  const orgs = useList(run, api.orgs);
  const [kind, setKind] = useState('');
  const [severity, setSeverity] = useState<'' | 'info' | 'medium' | 'high'>('');
  const [actor, setActor] = useState('');
  const [org, setOrg] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<AdminAuditEntry[] | null>(null);
  const load = useCallback(
    (before?: number) =>
      void run(() =>
        api.audit({
          kind: kind.trim() || undefined,
          severity: severity || undefined,
          actor: actor.trim() || undefined,
          org: org || undefined,
          ...auditDates(from, to),
          before,
          limit: PAGE,
        }),
      ).then((v) => v && setRows((prev) => (before && prev ? [...prev, ...v] : v))),
    [run, kind, severity, actor, org, from, to],
  );
  useEffect(() => load(), [load]);
  const refused = kind === REFUSED;
  return (
    <Section
      title="Audit"
      onReload={() => load()}
      tip="What happened on the portal and who did it. Kind takes a prefix (account matches every account row); Who takes a prefix ending in a colon."
      actions={
        <button type="button" className={`${btnPlain} ${refused ? 'bg-danger-soft text-danger' : ''}`} aria-pressed={refused} onClick={() => setKind(refused ? '' : REFUSED)}>
          <ShieldAlert size={18} aria-hidden />
          <span>Refused</span>
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-6">
        <input className={`${field} col-span-2 lg:col-span-1`} placeholder="Kind" aria-label="Kind" list="audit-kinds" value={kind} onChange={(e) => setKind(e.target.value)} />
        <datalist id="audit-kinds">
          {AUDIT_KINDS.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
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
      <Empty items={rows} />
      <ul className={list}>
        {rows?.map((r) => (
          <li key={r.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
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
          </li>
        ))}
      </ul>
      {rows && rows.length > 0 && rows.length % PAGE === 0 && (
        <button type="button" className={btnPlain} onClick={() => load(rows.at(-1)!.id)}>
          More
        </button>
      )}
    </Section>
  );
}
