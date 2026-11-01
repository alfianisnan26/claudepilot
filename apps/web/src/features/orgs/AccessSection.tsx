import { Button, ConfirmDialog, Dialog, Segmented, TextField, useToast } from '@isnanme/ui';
import type { AccessCatalogItem, AccessLevel, AccessRequest, ObjectAccess, Org, OrgMember, PersonAccess } from '@portal/contracts';
import { BookOpen, Box, ChevronRight, Ticket, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/Card';
import { api } from '@/lib/api';
import { AccessSheet } from './AccessSheet';
import { ACCESS_TAB_LABEL, accessTabs, LEVEL_LABEL, REQUEST_STATE_LABEL, sortRequests, untilValue, waitingCount, type AccessTab, type UntilKey } from './accessRules';
import { LevelCards, LevelPill, ReasonLine, UntilPicker } from './accessUi';
import { KIND_LABEL, ROLE_LABEL, orgErrorText } from './rules';
import { Alert, SectionTitle } from './settingsUi';

const ICON = { workspace: Box, ticket_bucket: Ticket, vault: BookOpen } as const;

/**
 * Access (docs/prd/access.md §7; replaces Sharing): owners and admins see every object (open one for who has access and why, give or end
 * access), every person (what they reach and why) and the requests inbox (approve with a level and an end, or deny). Members see the org's
 * objects with their own level (ask for more), their own access, and their requests. Guests do not see it. `?tab=access` opens here.
 */
export function AccessSection({ org, members, meId }: { org: Org; members: OrgMember[] | null; meId: string | null }) {
  const tabs = accessTabs(org.myRole);
  const [tab, setTab] = useState<AccessTab>(tabs[0] ?? 'objects');
  const [catalog, setCatalog] = useState<AccessCatalogItem[] | null>(null);
  const [requests, setRequests] = useState<AccessRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AccessCatalogItem | null>(null);
  const [person, setPerson] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await api.orgs.accessCatalog(org.id));
    } catch (e) {
      setCatalog([]);
      setError(orgErrorText(e, 'Couldn’t load the objects.'));
    }
  }, [org.id]);
  const loadRequests = useCallback(async () => {
    try {
      setRequests(await api.orgs.accessRequests(org.id));
    } catch (e) {
      setRequests([]);
      setError(orgErrorText(e, 'Couldn’t load the requests.'));
    }
  }, [org.id]);
  useEffect(() => {
    void loadCatalog();
    void loadRequests();
  }, [loadCatalog, loadRequests]);

  const waiting = requests ? waitingCount(requests) : 0;
  const changed = () => {
    void loadCatalog();
    void loadRequests();
  };

  return (
    <section aria-labelledby="org-access" data-org-access="">
      <SectionTitle
        id="org-access"
        about="Who can reach each of the organization’s things, and why. Give access to everyone, a team or one person, at View, Operate or Manage, with an end if you like. Members ask; owners and admins decide."
      >
        Access
      </SectionTitle>
      <Alert text={error} />
      {tabs.length > 1 && (
        <div className="mb-3">
          <Segmented<AccessTab>
            label="Access view"
            value={tab}
            options={tabs.map((t) => ({ value: t, label: t === 'requests' && waiting ? `${ACCESS_TAB_LABEL[t]} ${waiting}` : ACCESS_TAB_LABEL[t] }))}
            onChange={setTab}
          />
        </div>
      )}
      {tab === 'objects' && <ObjectsList catalog={catalog} onOpen={setOpen} />}
      {tab === 'people' && <PeopleList members={members} onOpen={setPerson} />}
      {tab === 'mine' && meId && <PersonAccessList org={org} userId={meId} onChanged={changed} />}
      {tab === 'requests' && <RequestsList org={org} requests={requests} onChanged={changed} />}
      {open && (
        <AccessSheet org={org} target={open.target} name={open.name} meId={meId} open={!!open} onClose={() => setOpen(null)} onChanged={changed} />
      )}
      <Dialog open={!!person} onClose={() => setPerson(null)} title={members?.find((m) => m.userId === person)?.displayName ?? 'Access'} description="What they reach">
        {person && <PersonAccessList org={org} userId={person} onChanged={changed} bare />}
      </Dialog>
    </section>
  );
}

function ObjectsList({ catalog, onOpen }: { catalog: AccessCatalogItem[] | null; onOpen: (c: AccessCatalogItem) => void }) {
  return (
    <Card>
      {catalog === null ? (
        <div className="skeleton m-4 h-10 rounded-xl" />
      ) : catalog.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted sm:px-5">Nothing yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {catalog.map((c) => {
            const Icon = ICON[c.target.type];
            return (
              <li key={`${c.target.type}:${c.target.id}`} data-access-object={`${c.target.type}:${c.target.id}`}>
                <button
                  type="button"
                  onClick={() => onOpen(c)}
                  className="press flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-accent sm:px-5"
                >
                  <Icon className="size-[18px] shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium [overflow-wrap:anywhere]">{c.name}</span>
                    <span className="block text-[12.5px] text-muted">
                      {KIND_LABEL[c.target.type]}
                      {c.openRequest ? ' · asked' : ''}
                    </span>
                  </span>
                  <LevelPill level={c.myLevel} />
                  <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function PeopleList({ members, onOpen }: { members: OrgMember[] | null; onOpen: (userId: string) => void }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => (members ?? []).filter((m) => !q.trim() || `${m.displayName} ${m.email}`.toLowerCase().includes(q.trim().toLowerCase())), [members, q]);
  return (
    <div className="flex flex-col gap-3">
      {(members?.length ?? 0) > 8 && <TextField label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or email" />}
      <Card>
        {members === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((m) => (
              <li key={m.userId} data-access-person={m.userId}>
                <button
                  type="button"
                  onClick={() => onOpen(m.userId)}
                  className="press flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-accent sm:px-5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium [overflow-wrap:anywhere]">{m.displayName}</span>
                    <span className="block text-[12.5px] [overflow-wrap:anywhere] text-muted">{ROLE_LABEL[m.role]}</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** What one person reaches and why; a share the viewer may end has an X (one tap, confirmed). */
function PersonAccessList({ org, userId, onChanged, bare }: { org: Org; userId: string; onChanged: () => void; bare?: boolean }) {
  const toast = useToast();
  const [data, setData] = useState<PersonAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState<{ shareId: string; name: string } | null>(null);
  const now = Date.now();
  const load = useCallback(async () => {
    try {
      setData(await api.orgs.personAccess(org.id, userId));
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t load the access.'));
    }
  }, [org.id, userId]);
  useEffect(() => void load(), [load]);

  const end = async () => {
    const e = ending;
    setEnding(null);
    if (!e) return;
    try {
      await api.orgs.revokeShare(org.id, e.shareId);
      toast('Access ended');
      await load();
      onChanged();
    } catch (err) {
      setError(orgErrorText(err, 'Couldn’t end it.'));
    }
  };

  const list =
    data === null ? (
      <div className="skeleton m-4 h-10 rounded-xl" />
    ) : data.items.length === 0 ? (
      <p className="px-4 py-4 text-sm text-muted sm:px-5">No access here.</p>
    ) : (
      <ul data-access-person-items="" className="divide-y divide-line">
        {data.items.map((it) => {
          const Icon = ICON[it.target.type];
          const revocable = it.reasons.filter((r) => r.kind === 'share' && r.revocable);
          return (
            <li key={`${it.target.type}:${it.target.id}`} className={bare ? 'flex min-h-14 items-center gap-3 py-2' : 'flex min-h-14 items-center gap-3 px-4 py-2 sm:px-5'}>
              <Icon className="size-[18px] shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block font-medium [overflow-wrap:anywhere]">{it.name}</span>
                <ReasonLine reasons={it.reasons} now={now} />
              </span>
              <LevelPill level={it.level} />
              {revocable.length > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`End what was shared of ${it.name}`}
                  onClick={() => {
                    const r = revocable[0]!;
                    if (r.kind === 'share') setEnding({ shareId: r.share.id, name: it.name });
                  }}
                >
                  <X className="size-[18px]" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    );

  return (
    <>
      <Alert text={error} />
      {bare ? list : <Card>{list}</Card>}
      <ConfirmDialog
        open={!!ending}
        title="End access?"
        description={ending ? `The share of ${ending.name} ends at once.` : ''}
        confirmLabel="End"
        onConfirm={() => void end()}
        onClose={() => setEnding(null)}
      />
    </>
  );
}

function RequestsList({ org, requests, onChanged }: { org: Org; requests: AccessRequest[] | null; onChanged: () => void }) {
  const toast = useToast();
  const [deciding, setDeciding] = useState<AccessRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo(() => (requests ? sortRequests(requests) : null), [requests]);

  const cancel = async (r: AccessRequest) => {
    try {
      await api.orgs.cancelAccessRequest(org.id, r.id);
      toast('Request cancelled');
      onChanged();
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t cancel it.'));
    }
  };

  return (
    <>
      <Alert text={error} />
      <Card>
        {rows === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : rows.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">No requests.</p>
        ) : (
          <ul data-access-requests="" className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} data-access-request={r.state} className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-5">
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block font-medium [overflow-wrap:anywhere]">
                    {r.requesterName} · {r.name}
                  </span>
                  <span className="block text-[12.5px] [overflow-wrap:anywhere] text-muted">
                    {[`${LEVEL_LABEL[r.level]}`, r.state === 'open' ? null : REQUEST_STATE_LABEL[r.state], r.state === 'approved' && r.grantedLevel ? `gave ${LEVEL_LABEL[r.grantedLevel]}` : null, r.note]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {r.state === 'open' && r.mayDecide && (
                  <Button onClick={() => setDeciding(r)} data-access-decide="">
                    Decide
                  </Button>
                )}
                {r.state === 'open' && !r.mayDecide && (
                  <Button variant="ghost" onClick={() => void cancel(r)}>
                    Cancel
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {deciding && (
        <DecideDialog
          org={org}
          request={deciding}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

/** Approve with a level (at most the decider's own) and an end, or deny; the same level cards and end picker as a grant. */
function DecideDialog({ org, request, onClose, onDone }: { org: Org; request: AccessRequest; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [obj, setObj] = useState<ObjectAccess | null>(null);
  const [level, setLevel] = useState<AccessLevel | null>(request.level);
  const [ack, setAck] = useState(false);
  const [until, setUntil] = useState<UntilKey>('30d');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();
  useEffect(() => {
    api.orgs.objectAccess(org.id, request.target.type, request.target.id).then(
      (o) => {
        setObj(o);
        if (!o.mayGrant.includes(request.level)) setLevel(o.mayGrant.at(-1) ?? null);
        if (o.maxUntil) setUntil('7d');
      },
      (e) => setError(orgErrorText(e, 'Couldn’t load it.')),
    );
  }, [org.id, request]);
  const expiresAt = untilValue(until, date, now, obj?.maxUntil ?? null);
  const needsAck = !!obj && request.target.type === 'workspace' && level !== 'view' && obj.credentials.length > 0;

  const approve = async () => {
    if (!level || expiresAt === 'invalid') return;
    setError(null);
    try {
      await api.orgs.approveAccess(org.id, request.id, { level, expiresAt, note: note.trim() || null, acknowledgeExposure: needsAck ? ack : undefined });
      toast('Access given');
      onDone();
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t approve it.'));
    }
  };
  const deny = async () => {
    setError(null);
    try {
      await api.orgs.denyAccess(org.id, request.id, { note: note.trim() || null });
      toast('Request denied');
      onDone();
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t deny it.'));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${request.requesterName} · ${request.name}`}
      description={`Asked for ${LEVEL_LABEL[request.level]}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => deny()} data-access-deny="">
            Deny
          </Button>
          <Button disabled={!level || expiresAt === 'invalid' || (needsAck && !ack)} onClick={() => approve()} data-access-approve="">
            Approve
          </Button>
        </>
      }
    >
      <div data-access-decide-sheet="" className="flex flex-col gap-4">
        <Alert text={error} />
        {request.note && <p className="rounded-2xl bg-surface-2 px-3 py-2 text-sm [overflow-wrap:anywhere]">“{request.note}”</p>}
        {obj ? (
          <>
            <LevelCards type={request.target.type} mayGrant={obj.mayGrant} subject="user" value={level} onChange={setLevel} credentials={obj.credentials} ack={ack} onAck={setAck} />
            <UntilPicker maxUntil={obj.maxUntil} now={now} until={until} onUntil={setUntil} date={date} onDate={setDate} note={note} onNote={setNote} />
          </>
        ) : (
          <div className="skeleton h-40 rounded-xl" aria-busy="true" />
        )}
      </div>
    </Dialog>
  );
}
