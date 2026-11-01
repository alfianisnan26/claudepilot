import type { AdminOrg, AdminOrgDetail, AdminOrgObject, OrgId } from '@portal/contracts';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './api';
import { TabBar } from '../components/TabBar';
import { WindowedList } from '../components/WindowedList';
import { ago, ORG_TAB_LABEL, ORG_TABS, slugOf, type OrgTab } from './model';
import { btnDanger, btnPlain, btnPrimary, chip, Confirm, CONSOLE_STICKY, DetailPanel, Empty, field, Field, InfoTip, MasterDetail, Section, Sheet, useList, type Run } from './ui';

/*
 * Orgs: every organization (names, owners, member counts, state; never content), New org with the owner picked from the accounts, and per
 * org (beside the list on a desktop, a sheet on a phone) its tabs: Overview (state, Suspend/Resume, Recover owner, Delete only when it owns
 * nothing), Members, Objects, Invitations, Sign-in (SSO and domains, where built), Break-glass (start with a reason, end). Every write is a
 * step-up action with a platform audit row.
 */

const OBJECT_LABEL: Record<AdminOrgObject['kind'], string> = {
  workspace: 'Workspace',
  ticket_bucket: 'Bucket',
  vault: 'Vault',
  pool: 'Set',
  account: 'Claude account',
  endpoint: 'Endpoint',
};

export function OrgsView({ run, meId }: { run: Run; meId: string }) {
  const { items, reload } = useList(run, api.orgs);
  const [open, setOpen] = useState<OrgId | null>(null);
  const [adding, setAdding] = useState(false);
  return (
    <Section
      title="Orgs"
      onReload={reload}
      tip="Organizations: their members, what they own and their state. Content stays private unless you open break-glass."
      actions={
        <button type="button" className={btnPrimary} aria-label="New org" title="New org" onClick={() => setAdding(true)}>
          <Plus size={18} aria-hidden />
          <span className="hidden sm:inline">New</span>
        </button>
      }
    >
      {/* Master-detail (ui.tsx): the org opens beside the list on a desktop, as a sheet on a phone; the list is windowed. */}
      <MasterDetail
        list={
          <WindowedList
            label="Orgs"
            items={items ?? []}
            itemKey={(o) => o.id}
            estimate={78}
            gap={6}
            stickyClassName={CONSOLE_STICKY}
            empty={<Empty items={items} />}
            renderItem={(o) => (
              <button
                type="button"
                aria-current={open === o.id ? 'true' : undefined}
                className={`flex min-h-14 w-full flex-col gap-1 rounded-xl border bg-surface px-3 py-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-accent ${open === o.id ? 'border-primary' : 'border-line'}`}
                onClick={() => setOpen(o.id)}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="break-any block text-sm font-medium">{o.name}</span>
                    <span className="break-any block text-xs text-muted">
                      {o.slug} · {o.members} members
                    </span>
                  </span>
                  <OrgChips o={o} />
                </span>
                <span className="break-any text-xs text-muted">{o.owners.length ? o.owners.map((w) => `${w.email ?? w.userId}${w.active ? '' : ' (off)'}`).join(', ') : 'No owners'}</span>
              </button>
            )}
          />
        }
        detail={
          open && (
            <OrgDetail
              key={open}
              id={open}
              run={run}
              onChanged={reload}
              onClose={() => {
                setOpen(null);
                reload();
              }}
            />
          )
        }
      />
      {adding && (
        <NewOrg
          run={run}
          meId={meId}
          onDone={(id) => {
            setAdding(false);
            reload();
            setOpen(id);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </Section>
  );
}

function OrgChips({ o }: { o: AdminOrg }) {
  return (
    <span className="flex shrink-0 flex-wrap justify-end gap-1">
      {o.state !== 'active' && <span className={`${chip} bg-surface-2`}>{o.state}</span>}
      {o.needsOwner && <span className={`${chip} bg-danger-soft text-danger`}>no owner</span>}
    </span>
  );
}

function NewOrg({ run, meId, onDone, onClose }: { run: Run; meId: string; onDone: (id: OrgId) => void; onClose: () => void }) {
  const { items: users } = useList(run, api.users);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerId, setOwnerId] = useState(meId);
  const effectiveSlug = slugTouched ? slug : slugOf(name);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.createOrg({ name: name.trim(), slug: effectiveSlug, ownerId }));
    if (r) onDone(r.id);
  };
  return (
    <Sheet title="New org" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="Name">
          <input className={field} required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Slug">
          <input
            className={field}
            required
            pattern="[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,39}"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
          />
        </Field>
        <Field label="Owner">
          <select className={field} required value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {users
              ?.filter((u) => u.state === 'active')
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
          </select>
        </Field>
        <button type="submit" className={btnPrimary} disabled={!name.trim() || !effectiveSlug}>
          Create
        </button>
      </form>
    </Sheet>
  );
}

type Ask = 'suspend' | 'resume' | 'delete' | 'breakglass' | 'endglass' | 'recover';

function OrgDetail({ id, run, onChanged, onClose }: { id: OrgId; run: Run; onChanged: () => void; onClose: () => void }) {
  const [o, setO] = useState<AdminOrgDetail | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [tab, setTab] = useState<OrgTab>('overview');
  const load = useCallback(() => void run(() => api.org(id)).then((v) => v && setO(v)), [run, id]);
  useEffect(load, [load]);
  if (!o)
    return (
      <DetailPanel title="Org" onClose={onClose}>
        <p className="text-sm text-muted">Loading</p>
      </DetailPanel>
    );
  // The panel stays open beside the list: a change shows in both.
  const done = async (fn: () => Promise<unknown>) => {
    const r = await run(fn);
    if (r !== undefined) (load(), onChanged());
    return r !== undefined;
  };
  const glass = o.breakGlassOpen.length > 0;
  // Usage-style tabs (docs/coord/UI-STANDARD.md §2): one section at a time; Sign-in only where SSO or domains are built.
  const tabs = ORG_TABS.filter((t) => t !== 'signin' || !!o.sso || !!o.domains).map((t) => ({
    id: t,
    label: ORG_TAB_LABEL[t],
    badge: t === 'members' ? o.memberList.length : t === 'objects' ? o.objects.length || undefined : t === 'invitations' ? o.invitations.length || undefined : t === 'breakglass' && glass ? 'on' : undefined,
    badgeTone: t === 'breakglass' ? ('attention' as const) : ('info' as const),
  }));
  return (
    <DetailPanel title={o.name} onClose={onClose}>
      <TabBar label={`${o.name} sections`} tabs={tabs} active={tab} onSelect={(t) => setTab(t as OrgTab)} className="-mx-4 -mt-4 lg:sticky lg:top-0 lg:z-10" innerClassName="px-3" />
      <div role="tabpanel" data-org-tab={tab} className="flex flex-col gap-4">
        {tab === 'overview' && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Slug</dt>
              <dd className="break-any">{o.slug}</dd>
              <dt className="text-muted">State</dt>
              <dd>{o.state}</dd>
              <dt className="text-muted">Made</dt>
              <dd>{ago(o.createdAt)}</dd>
              <dt className="text-muted">Members</dt>
              <dd>{o.memberList.length}</dd>
              <dt className="text-muted">Owns</dt>
              <dd>{o.objects.length}</dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              {o.state === 'active' ? (
                <button type="button" className={btnDanger} onClick={() => setAsk('suspend')}>
                  Suspend
                </button>
              ) : (
                <button type="button" className={btnPlain} onClick={() => setAsk('resume')}>
                  Resume
                </button>
              )}
              {o.needsOwner && (
                <button type="button" className={btnPlain} onClick={() => setAsk('recover')}>
                  Recover owner
                </button>
              )}
              <button type="button" className={btnDanger} disabled={o.objects.length > 0} title={o.objects.length > 0 ? 'Move what it owns out first' : undefined} onClick={() => setAsk('delete')}>
                Delete
              </button>
            </div>
          </>
        )}
        {tab === 'members' && (
          <Group title="Members">
            {o.memberList.map((m) => (
              <li key={m.userId} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="break-any min-w-0 flex-1">{m.email || m.displayName}</span>
                <span className={`${chip} bg-surface-2`}>{m.role}</span>
              </li>
            ))}
          </Group>
        )}
        {tab === 'objects' && (
          <Group title="Owns" tip="Names only. Moving things between orgs is done from the item in the portal.">
            {o.objects.map((x) => (
              <li key={`${x.kind}:${x.id}`} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="break-any min-w-0 flex-1">{x.name}</span>
                <span className="shrink-0 text-xs text-muted">{OBJECT_LABEL[x.kind]}</span>
              </li>
            ))}
          </Group>
        )}
        {tab === 'invitations' && (
          <Group title="Invitations">
            {o.invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="break-any min-w-0 flex-1">{i.email}</span>
                <span className="shrink-0 text-xs text-muted">
                  {i.role} · {i.state}
                </span>
              </li>
            ))}
          </Group>
        )}
        {tab === 'signin' && (
          <>
            {o.sso && (
              <Group title="SSO">
                {o.sso.map((sp) => (
                  <li key={sp.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="break-any min-w-0 flex-1">{sp.name}</span>
                    <span className={`${chip} ${sp.enabled ? 'bg-accent-soft' : 'bg-surface-2'}`}>{sp.enabled ? 'on' : 'off'}</span>
                  </li>
                ))}
              </Group>
            )}
            {o.domains && (
              <Group title="Domains">
                {o.domains.map((d) => (
                  <li key={d.domain} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="break-any min-w-0 flex-1">{d.domain}</span>
                    <span className="shrink-0 text-xs text-muted">{d.verified ? 'verified' : 'pending'}</span>
                  </li>
                ))}
              </Group>
            )}
          </>
        )}
        {tab === 'breakglass' && (
          <>
            <p className="flex items-center gap-1 text-sm">
              {glass ? `Open until ${new Date(o.breakGlassOpen[0]!.expiresAt).toLocaleTimeString()}` : 'Closed'}
              <InfoTip label="About break-glass">One hour of full access to the org’s content in the portal, with a reason. Its owners are told, and every access is audited.</InfoTip>
            </p>
            <div className="flex flex-wrap gap-2">
              {glass ? (
                <button type="button" className={btnPlain} onClick={() => setAsk('endglass')}>
                  End break-glass
                </button>
              ) : (
                <button type="button" className={btnDanger} disabled={o.state !== 'active'} title={o.state !== 'active' ? 'Resume the org first' : undefined} onClick={() => setAsk('breakglass')}>
                  Start break-glass
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {ask === 'suspend' && (
        <Confirm
          title="Suspend"
          body={`Nobody uses ${o.name} until you resume it. Its owners cannot resume it themselves.`}
          action="Suspend"
          danger
          reason={{ label: 'Reason', min: 0 }}
          onConfirm={(reason) => done(() => api.suspendOrg(o.id, reason || undefined))}
          onClose={() => setAsk(null)}
        />
      )}
      {ask === 'resume' && <Confirm title="Resume" body={`${o.name} is usable again.`} action="Resume" onConfirm={() => done(() => api.resumeOrg(o.id))} onClose={() => setAsk(null)} />}
      {ask === 'breakglass' && (
        <Confirm
          title="Break-glass"
          body={`One hour of full access to ${o.name}’s content in the portal. Its owners are told, and every access is audited.`}
          action="Start"
          danger
          reason={{ label: 'Reason', min: 10 }}
          onConfirm={(reason) => done(() => api.startBreakGlass(o.id, reason))}
          onClose={() => setAsk(null)}
        />
      )}
      {ask === 'endglass' && <Confirm title="End break-glass" body="Your access to its content ends now." action="End" onConfirm={() => done(() => api.endBreakGlass(o.id))} onClose={() => setAsk(null)} />}
      {ask === 'delete' && (
        <Confirm
          title="Delete"
          body={`${o.name} disappears now and is purged after 30 days.`}
          action="Delete"
          danger
          reason={{ label: 'Reason', min: 0 }}
          onConfirm={async (reason) => {
            const r = await run(() => api.deleteOrg(o.id, reason || undefined));
            if (r) onClose();
            return !!r;
          }}
          onClose={() => setAsk(null)}
        />
      )}
      {ask === 'recover' && <Recover org={o} run={run} onDone={() => (load(), onChanged())} onClose={() => setAsk(null)} />}
    </DetailPanel>
  );
}

function Group({ title, tip, children }: { title: string; tip?: string; children: ReactNode[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1 text-sm font-semibold">
        {title}
        {tip && <InfoTip label={`About ${title}`}>{tip}</InfoTip>}
      </h3>
      {children.length === 0 ? <p className="text-sm text-muted">None</p> : <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">{children}</ul>}
    </div>
  );
}

function Recover({ org, run, onDone, onClose }: { org: AdminOrgDetail; run: Run; onDone: () => void; onClose: () => void }) {
  const { items } = useList(run, api.users);
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.recoverOwner(org.id, userId, reason));
    if (r) {
      onDone();
      onClose();
    }
  };
  return (
    <Sheet title="Recover owner" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="New owner">
          <select className={field} required value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Pick an account</option>
            {items
              ?.filter((u) => u.state === 'active')
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Reason">
          <textarea className={`${field} min-h-24 py-2`} required minLength={10} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <button type="submit" className={btnPrimary} disabled={!userId || reason.trim().length < 10}>
          Recover
        </button>
      </form>
    </Sheet>
  );
}
