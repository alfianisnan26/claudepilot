import { Button, ConfirmDialog, useToast } from '@isnanme/ui';
import type { Org, OrgMember, OrgRole } from '@portal/contracts';
import { UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Card } from '@/components/Card';
import { api } from '@/lib/api';
import { canManageOrg, canRemoveMember, orgErrorText, ROLE_LABEL, roleChoices } from './rules';
import { Alert, SectionTitle } from './settingsUi';

/**
 * Members: role pickers limited to what the service allows, remove, and Invite (jumps to Invitations, shown only when the person may
 * invite). The server decides each change; a refusal (the last owner) is shown as words.
 */
export function MembersSection({
  org,
  members,
  meId,
  onMembers,
  onSelfChanged,
  onInvite,
}: {
  org: Org;
  members: OrgMember[] | null;
  meId: string | null;
  onMembers: (members: OrgMember[]) => void;
  onSelfChanged: () => Promise<void>;
  onInvite?: () => void;
}) {
  const toast = useToast();
  const manage = canManageOrg(org.myRole);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<OrgMember | null>(null);

  const setRole = async (m: OrgMember, role: OrgRole) => {
    setError(null);
    try {
      onMembers(await api.orgs.setRole(org.id, m.userId, { role }));
      toast('Role changed');
      if (m.userId === meId) await onSelfChanged();
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t change the role.'));
    }
  };
  const remove = async () => {
    const m = removing;
    setRemoving(null);
    if (!m) return;
    setError(null);
    try {
      await api.orgs.remove(org.id, m.userId);
      toast('Removed');
      onMembers(await api.orgs.members(org.id));
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t remove them.'));
    }
  };

  return (
    <section aria-labelledby="org-members">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <SectionTitle
          id="org-members"
          about={
            manage
              ? 'Change a role or remove someone. Admins change roles up to admin; only an owner changes owners. An organization always keeps an owner.'
              : 'The people in this organization. Owners and admins change roles.'
          }
        >
          Members
        </SectionTitle>
        {onInvite && (
          <Button variant="secondary" icon={<UserPlus className="size-4" />} onClick={onInvite} data-org-invite-jump="">
            Invite
          </Button>
        )}
      </div>
      <Alert text={error} />
      <Card>
        {members === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : (
          <ul className="divide-y divide-line">
            {members.map((m) => {
              const self = m.userId === meId;
              const choices = roleChoices(org.myRole, m.role);
              return (
                <li key={m.userId} data-org-member={m.userId} className="flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 sm:px-5">
                  <span className="min-w-0 flex-1 basis-40">
                    <span className="block font-medium [overflow-wrap:anywhere]">
                      {m.displayName}
                      {self && <span className="text-muted"> (you)</span>}
                    </span>
                    {m.email && <span className="block text-[12.5px] [overflow-wrap:anywhere] text-muted">{m.email}</span>}
                  </span>
                  {choices.length > 0 ? (
                    <select
                      aria-label={`Role of ${m.displayName}`}
                      value={m.role}
                      onChange={(e) => void setRole(m, e.target.value as OrgRole)}
                      className="h-11 min-w-28 rounded-xl border border-line bg-surface px-3 text-sm font-semibold outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      {choices.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="px-2 text-sm font-semibold text-ink-soft">{ROLE_LABEL[m.role]}</span>
                  )}
                  {canRemoveMember(org.myRole, m.role, self) && (
                    <Button variant="ghost" size="icon" aria-label={`Remove ${m.displayName}`} onClick={() => setRemoving(m)}>
                      <UserMinus className="size-[18px]" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={!!removing}
        title="Remove member?"
        description={removing ? `${removing.displayName} loses access to this organization.` : ''}
        confirmLabel="Remove"
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </section>
  );
}
