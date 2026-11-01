import { Button, ConfirmDialog, useToast } from '@isnanme/ui';
import type { Org, OrgShare } from '@portal/contracts';
import { X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { api } from '@/lib/api';
import { canRevokeShare, KIND_LABEL, orgErrorText, targetName, type OrgObjectRow } from './rules';
import { Alert, SectionTitle } from './settingsUi';

const LEVEL: Record<OrgShare['level'], string> = { view: 'View', operate: 'Operate', manage: 'Manage' };

/**
 * Sharing: the org's open shares to the whole org or to one of its teams (members see the ones whose object they may view; owners and
 * admins every one). Revoke for owners and admins and for whoever shared it. Shares are made from the object's own Share dialog.
 */
export function SharingSection({ org, meId, rows }: { org: Org; meId: string | null; rows: OrgObjectRow[] }) {
  const toast = useToast();
  const [shares, setShares] = useState<OrgShare[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<OrgShare | null>(null);

  const load = useCallback(async () => {
    try {
      setShares(await api.orgs.shares(org.id));
    } catch (e) {
      setShares([]);
      setError(orgErrorText(e, 'Couldn’t load the shares.'));
    }
  }, [org.id]);
  useEffect(() => void load(), [load]);

  const revoke = async () => {
    const s = revoking;
    setRevoking(null);
    if (!s) return;
    setError(null);
    try {
      await api.orgs.revokeShare(org.id, s.id);
      toast('Share ended');
      await load();
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t end the share.'));
    }
  };

  return (
    <section aria-labelledby="org-sharing" data-org-sharing="">
      <SectionTitle id="org-sharing" about="What is shared with everyone in the organization or with one of its teams. Guests never receive the organization’s shares.">
        Sharing
      </SectionTitle>
      <Alert text={error} />
      <Card>
        {shares === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : shares.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">Nothing shared.</p>
        ) : (
          <ul className="divide-y divide-line">
            {shares.map((s) => (
              <li key={s.id} data-org-share={s.id} className="flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 sm:px-5">
                <span className="min-w-0 flex-1 basis-40">
                  <span className="block font-medium [overflow-wrap:anywhere]">{targetName(s.target, rows)}</span>
                  <span className="block text-[12.5px] [overflow-wrap:anywhere] text-muted">
                    {KIND_LABEL[s.target.type]} · {s.subject.kind === 'org' ? 'Everyone' : s.subject.name} · {LEVEL[s.level]}
                  </span>
                </span>
                {canRevokeShare(org.myRole, s, meId) && (
                  <Button variant="ghost" size="icon" aria-label={`End the share of ${targetName(s.target, rows)}`} onClick={() => setRevoking(s)}>
                    <X className="size-[18px]" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={!!revoking}
        title="End share?"
        description={revoking ? `${revoking.subject.kind === 'org' ? 'Everyone' : revoking.subject.name} loses this access at once.` : ''}
        confirmLabel="End"
        onConfirm={() => void revoke()}
        onClose={() => setRevoking(null)}
      />
    </section>
  );
}
