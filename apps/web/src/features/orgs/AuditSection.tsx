import { Badge, Button, ConfirmDialog, useToast } from '@isnanme/ui';
import type { BreakGlassEntry, Org, OrgBreakGlassView, OrgTranscriptView, PlatformAuditEntry } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { BoundedBody } from '@/components/BoundedBody';
import { Card } from '@/components/Card';
import { api } from '@/lib/api';
import { AUDIT_FILTERS, auditActorText, auditKindText, canSeeOwnerAudit, orgErrorText } from './rules';
import { Alert, SectionTitle, selectField, SubTitle, when } from './settingsUi';

const PAGE = 50;

/**
 * Audit (owners and admins): the org's audit rows, newest first, filtered by kind (the server's `?kind=` prefix), 50 at a time. Owners also
 * see who read members' sessions (transcript views) and the instance owner's break-glass entries, and end an open one early.
 */
export function AuditSection({ org, names }: { org: Org; names: ReadonlyMap<string, string> }) {
  const [kind, setKind] = useState('');
  const [rows, setRows] = useState<PlatformAuditEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: number) => {
      setError(null);
      try {
        const page = await api.orgs.audit(org.id, { kind, before });
        setRows((prev) => (before && prev ? [...prev, ...page] : page));
        setMore(page.length === PAGE);
      } catch (e) {
        setRows((prev) => prev ?? []);
        setError(orgErrorText(e, 'Couldn’t load the audit.'));
      }
    },
    [org.id, kind],
  );
  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  return (
    <section aria-labelledby="org-audit" data-org-audit="">
      <SectionTitle id="org-audit" about="Who changed what in this organization. Names and ids only, never content.">
        Audit
      </SectionTitle>
      <Alert text={error} />
      <label className="mb-3 flex flex-col gap-1.5 sm:max-w-xs">
        <span className="text-sm font-semibold text-ink-soft">Show</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={selectField} data-org-audit-filter="">
          {AUDIT_FILTERS.map((f) => (
            <option key={f.kind} value={f.kind}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <Card>
        {rows === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : rows.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">Nothing yet.</p>
        ) : (
          <BoundedBody><ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} data-org-audit-row={r.id} className="flex flex-col gap-0.5 px-4 py-2.5 sm:px-5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium [overflow-wrap:anywhere]">{auditKindText(r.kind)}</span>
                  {r.severity !== 'info' && <Badge tone={r.severity === 'high' ? 'danger' : 'warning'}>{r.severity === 'high' ? 'High' : 'Medium'}</Badge>}
                </span>
                <span className="text-[12.5px] [overflow-wrap:anywhere] text-muted">
                  {when(r.at)} · {auditActorText(r, names)}
                  {r.subject && !r.subject.startsWith('org:') && ` · ${r.subject}`}
                </span>
              </li>
            ))}
          </ul></BoundedBody>
        )}
      </Card>
      {more && rows && (
        <Button variant="secondary" className="mt-3" onClick={() => load(rows[rows.length - 1]!.id)}>
          More
        </Button>
      )}
      {canSeeOwnerAudit(org.myRole) && (
        <>
          <TranscriptViews org={org} names={names} />
          <BreakGlass org={org} names={names} />
        </>
      )}
    </section>
  );
}

function TranscriptViews({ org, names }: { org: Org; names: ReadonlyMap<string, string> }) {
  const [rows, setRows] = useState<OrgTranscriptView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.orgs.transcriptViews(org.id).then(setRows, (e) => {
      setRows([]);
      setError(orgErrorText(e, 'Couldn’t load them.'));
    });
  }, [org.id]);
  const name = (id: string) => names.get(id) ?? id;
  return (
    <div data-org-transcript-views="">
      <SubTitle label="About session reads" about="Each time an owner or admin read a member’s session in one of the organization’s workspaces. The member sees their own rows too.">
        Session reads
      </SubTitle>
      <Alert text={error} />
      <Card>
        {rows === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : rows.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">None.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={`${r.at}-${r.viewer}-${r.sessionId}`} className="flex flex-col gap-0.5 px-4 py-2.5 sm:px-5">
                <span className="font-medium [overflow-wrap:anywhere]">
                  {name(r.viewer)} read {name(r.member)}’s session
                </span>
                <span className="text-[12.5px] [overflow-wrap:anywhere] text-muted">
                  {when(r.at)}
                  {r.workspaceId && ` · ${r.workspaceId}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function BreakGlass({ org, names }: { org: Org; names: ReadonlyMap<string, string> }) {
  const toast = useToast();
  const [view, setView] = useState<OrgBreakGlassView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState<BreakGlassEntry | null>(null);
  const load = useCallback(async () => {
    try {
      setView(await api.orgs.breakGlass(org.id));
    } catch (e) {
      setView({ entries: [], access: [] });
      setError(orgErrorText(e, 'Couldn’t load them.'));
    }
  }, [org.id]);
  useEffect(() => void load(), [load]);

  const end = async () => {
    const e = ending;
    setEnding(null);
    if (!e) return;
    setError(null);
    try {
      await api.orgs.endBreakGlass(org.id, e.id);
      toast('Ended');
      await load();
    } catch (err) {
      setError(orgErrorText(err, 'Couldn’t end it.'));
    }
  };
  const state = (e: BreakGlassEntry) => (e.open ? 'Open' : e.endKind === 'ended' ? 'Ended' : e.endKind === 'replaced' ? 'Replaced' : 'Expired');

  return (
    <div data-org-break-glass="">
      <SubTitle label="About break-glass" about="The portal’s owner opened this organization’s content for an hour, with a reason. Every change made under it is listed. End one early here.">
        Break-glass
      </SubTitle>
      <Alert text={error} />
      <Card>
        {view === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : view.entries.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">None.</p>
        ) : (
          <ul className="divide-y divide-line">
            {view.entries.map((e) => {
              const acts = view.access.filter((a) => a.entryId === e.id).length;
              return (
                <li key={e.id} data-org-break-glass-entry={e.id} className="flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 sm:px-5">
                  <span className="min-w-0 flex-1 basis-48">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium [overflow-wrap:anywhere]">{names.get(e.adminUserId) ?? e.adminUserId}</span>
                      <Badge tone={e.open ? 'danger' : 'neutral'}>{state(e)}</Badge>
                    </span>
                    <span className="block text-sm [overflow-wrap:anywhere]">{e.reason}</span>
                    <span className="block text-[12.5px] [overflow-wrap:anywhere] text-muted">
                      {when(e.startedAt)} · {acts} {acts === 1 ? 'change' : 'changes'}
                    </span>
                  </span>
                  {e.open && (
                    <Button variant="danger" onClick={() => setEnding(e)} data-org-break-glass-end="">
                      End
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={!!ending}
        title="End break-glass?"
        description="The access ends now. A new one needs a new reason."
        confirmLabel="End"
        onConfirm={() => void end()}
        onClose={() => setEnding(null)}
      />
    </div>
  );
}
