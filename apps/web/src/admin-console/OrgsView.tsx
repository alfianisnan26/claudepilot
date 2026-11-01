import type { AdminOrg, AdminOrgDetail, AdminOrgObject, OrgId, OrgMember } from '@portal/contracts';
import { Plus, UserMinus, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './api';
import { AddMemberSheet } from './forms';
import { ago, slugOf } from './model';
import { btnDanger, btnPlain, btnPrimary, chip, Confirm, Empty, field, Field, InfoTip, list, Section, Sheet, useList, type Run } from './ui';

/*
 * Orgs: every organization (names, owners, member counts, state; never content), New org with the owner picked from the accounts, and per
 * org its members and roles, what it owns, pending invitations, its SSO and domains (where built), with Suspend/Resume, Recover owner,
 * Break-glass (start with a reason, end), Delete (only when it owns nothing). Every write is a step-up action with a platform audit row.
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
      <Empty items={items} />
      <ul className={list}>
        {items?.map((o) => (
          <li key={o.id}>
            <button type="button" className="flex min-h-14 w-full flex-col gap-1 px-3 py-2 text-left" onClick={() => setOpen(o.id)}>
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
          </li>
        ))}
      </ul>
      {open && (
        <OrgSheet
          id={open}
          run={run}
          onClose={() => {
            setOpen(null);
            reload();
          }}
        />
      )}
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

type Ask = 'suspend' | 'resume' | 'delete' | 'breakglass' | 'endglass' | 'recover' | 'add' | { remove: OrgMember };

function OrgSheet({ id, run, onClose }: { id: OrgId; run: Run; onClose: () => void }) {
  const [o, setO] = useState<AdminOrgDetail | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const load = useCallback(() => void run(() => api.org(id)).then((v) => v && setO(v)), [run, id]);
  useEffect(load, [load]);
  if (!o)
    return (
      <Sheet title="Org" onClose={onClose}>
        <p className="text-sm text-muted">Loading</p>
      </Sheet>
    );
  const done = async (fn: () => Promise<unknown>) => {
    const r = await run(fn);
    if (r !== undefined) load();
    return r !== undefined;
  };
  const glass = o.breakGlassOpen.length > 0;
  return (
    <Sheet title={o.name} onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Slug</dt>
        <dd className="break-any">{o.slug}</dd>
        <dt className="text-muted">State</dt>
        <dd>{o.state}</dd>
        <dt className="text-muted">Made</dt>
        <dd>{ago(o.createdAt)}</dd>
        {glass && (
          <>
            <dt className="text-muted">Break-glass</dt>
            <dd>until {new Date(o.breakGlassOpen[0]!.expiresAt).toLocaleTimeString()}</dd>
          </>
        )}
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
        {glass ? (
          <button type="button" className={btnPlain} onClick={() => setAsk('endglass')}>
            End break-glass
          </button>
        ) : (
          <button type="button" className={btnPlain} disabled={o.state !== 'active'} onClick={() => setAsk('breakglass')}>
            Break-glass
          </button>
        )}
        <button type="button" className={btnDanger} disabled={o.objects.length > 0} title={o.objects.length > 0 ? 'Move what it owns out first' : undefined} onClick={() => setAsk('delete')}>
          Delete
        </button>
      </div>

      <Group
        title={`Members (${o.memberList.length})`}
        action={
          <button type="button" className={btnPlain} aria-label="Add member" title="Add member" disabled={o.state === 'deleting'} onClick={() => setAsk('add')}>
            <UserPlus size={18} aria-hidden />
            <span className="hidden sm:inline">Add</span>
          </button>
        }
      >
        {o.memberList.map((m) => (
          <li key={m.userId} className="flex items-center gap-2 px-3 py-1 text-sm">
            <span className="break-any min-w-0 flex-1">{m.email || m.displayName}</span>
            <span className={`${chip} bg-surface-2`}>{m.role}</span>
            {m.role !== 'owner' && (
              <button type="button" className={btnPlain} aria-label={`Remove ${m.email || m.displayName}`} title="Remove" onClick={() => setAsk({ remove: m })}>
                <UserMinus size={18} aria-hidden />
              </button>
            )}
          </li>
        ))}
      </Group>
      <Group title={`Owns (${o.objects.length})`} tip="Names only. Moving things between orgs is done from the item in the portal.">
        {o.objects.map((x) => (
          <li key={`${x.kind}:${x.id}`} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="break-any min-w-0 flex-1">{x.name}</span>
            <span className="shrink-0 text-xs text-muted">{OBJECT_LABEL[x.kind]}</span>
          </li>
        ))}
      </Group>
      <Group title={`Invitations (${o.invitations.length})`}>
        {o.invitations.map((i) => (
          <li key={i.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="break-any min-w-0 flex-1">{i.email}</span>
            <span className="shrink-0 text-xs text-muted">
              {i.role} · {i.state}
            </span>
          </li>
        ))}
      </Group>
      {o.sso && (
        <Group title={`SSO (${o.sso.length})`}>
          {o.sso.map((p) => (
            <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="break-any min-w-0 flex-1">{p.name}</span>
              <span className={`${chip} ${p.enabled ? 'bg-accent-soft' : 'bg-surface-2'}`}>{p.enabled ? 'on' : 'off'}</span>
            </li>
          ))}
        </Group>
      )}
      {o.domains && (
        <Group title={`Domains (${o.domains.length})`}>
          {o.domains.map((d) => (
            <li key={d.domain} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="break-any min-w-0 flex-1">{d.domain}</span>
              <span className="shrink-0 text-xs text-muted">{d.verified ? 'verified' : 'pending'}</span>
            </li>
          ))}
        </Group>
      )}

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
      {ask === 'recover' && <Recover org={o} run={run} onDone={load} onClose={() => setAsk(null)} />}
      {ask === 'add' && (
        <AddMemberSheet
          org={o}
          run={run}
          onDone={(next) => {
            setO(next);
            setAsk(null);
          }}
          onClose={() => setAsk(null)}
        />
      )}
      {typeof ask === 'object' && ask && 'remove' in ask && (
        <Confirm
          title="Remove member"
          body={`${ask.remove.email || ask.remove.displayName} leaves ${o.name}. What they shared with it ends.`}
          action="Remove"
          danger
          onConfirm={async () => {
            const r = await run(() => api.removeMember(o.id, ask.remove.userId));
            if (r) setO(r);
            return !!r;
          }}
          onClose={() => setAsk(null)}
        />
      )}
    </Sheet>
  );
}

function Group({ title, tip, action, children }: { title: string; tip?: string; action?: ReactNode; children: ReactNode[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <h3 className="flex min-w-0 flex-1 items-center gap-1 text-sm font-semibold">
          {title}
          {tip && <InfoTip label={`About ${title}`}>{tip}</InfoTip>}
        </h3>
        {action}
      </div>
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
