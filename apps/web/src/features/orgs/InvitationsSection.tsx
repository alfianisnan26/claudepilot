import { Button, useToast } from '@isnanme/ui';
import type { CreatedOrgInvitation, Org, OrgInvitation, OrgInvitationRole } from '@portal/contracts';
import { Check, Copy, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Card } from '@/components/Card';
import { api } from '@/lib/api';
import { orgField } from './NewOrgDialog';
import { canListInvitations, inviteLink, inviteRoleChoices, orgErrorText, ROLE_LABEL } from './rules';
import { selectField, SectionTitle } from './settingsUi';

/**
 * Org settings, Invitations (docs/prd/organizations.md §6.8, slice 8): owners and admins invite by email with a role, copy the link once
 * (no mail is sent; the code is in the link's fragment and only its hash is kept), see pending and expired ones, and revoke one at once.
 * Org settings (2026-11-01): a member the org lets invite (`membersMayInvite`, Org.may.invite) gets the form only; the list is the managers'.
 */
export function InvitationsSection({ org }: { org: Org }) {
  const toast = useToast();
  const roles = inviteRoleChoices(org.myRole);
  const listable = canListInvitations(org.myRole);
  const [list, setList] = useState<OrgInvitation[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgInvitationRole>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedOrgInvitation | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!listable) return;
    try {
      setList(await api.orgs.invitations(org.id));
    } catch (e) {
      setList([]);
      setError(orgErrorText(e, 'Couldn’t load the invitations.'));
    }
  }, [org.id, listable]);
  useEffect(() => void load(), [load]);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setCreated(await api.orgs.invite(org.id, { email: email.trim(), role }));
      setEmail('');
      await load();
    } catch (err) {
      setError(orgErrorText(err, 'Couldn’t invite them.'));
    } finally {
      setBusy(false);
    }
  };
  const link = created ? inviteLink(window.location.origin, created.code) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast('Link copied');
    } catch {
      setError('Couldn’t copy. Select the link and copy it.');
    }
  };
  const revoke = async (inv: OrgInvitation) => {
    setError(null);
    try {
      await api.orgs.revokeInvitation(org.id, inv.id);
      if (created?.id === inv.id) setCreated(null);
      toast('Revoked');
      await load();
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t revoke it.'));
    }
  };

  return (
    <section aria-labelledby="org-invitations" data-org-invitations="">
      <SectionTitle id="org-invitations" about="Invite by email, then copy the link and send it yourself. It works once, for 7 days, and only for someone signed in with that email.">
        Invitations
      </SectionTitle>
      <Card className="p-4 sm:p-5">
        <form onSubmit={invite} className="flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink-soft">Email</span>
            <input type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} className={orgField} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink-soft">Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value as OrgInvitationRole)} className={selectField}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" loading={busy} disabled={!email.trim()} className="min-h-12">
            Invite
          </Button>
        </form>

        {created && (
          <div data-org-invite-link="" className="mt-4 flex flex-col gap-2 rounded-2xl bg-surface-2 p-3">
            <span className="text-sm font-semibold text-ink-soft">Link for {created.email}</span>
            <span className="font-mono text-[13px] [overflow-wrap:anywhere] select-all">{link}</span>
            <span className="text-[12.5px] text-muted">Shown once. Copy it now.</span>
            <Button variant="secondary" icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />} onClick={() => void copy()} className="self-start">
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm font-medium [overflow-wrap:anywhere] text-danger">
            {error}
          </p>
        )}
      </Card>

      {listable && (
        <Card className="mt-3">
          {list === null ? (
            <div className="skeleton m-4 h-10 rounded-xl" />
          ) : list.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted sm:px-5">No open invitations.</p>
          ) : (
            <ul className="divide-y divide-line">
              {list.map((inv) => (
                <li key={inv.id} data-org-invitation={inv.id} className="flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 sm:px-5">
                  <span className="min-w-0 flex-1 basis-40">
                    <span className="block font-medium [overflow-wrap:anywhere]">{inv.email}</span>
                    <span className={`block text-[12.5px] ${inv.state === 'expired' ? 'text-danger' : 'text-muted'}`}>
                      {ROLE_LABEL[inv.role]} · {inv.state === 'expired' ? 'Expired' : `Until ${new Date(inv.expiresAt).toLocaleDateString()}`}
                    </span>
                  </span>
                  <Button variant="ghost" size="icon" aria-label={`Revoke the invitation for ${inv.email}`} onClick={() => void revoke(inv)}>
                    <X className="size-[18px]" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </section>
  );
}
