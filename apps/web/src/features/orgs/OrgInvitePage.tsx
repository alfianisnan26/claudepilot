import { Button, useToast } from '@isnanme/ui';
import { Building2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { api } from '@/lib/api';
import { useOrgs } from './OrgsProvider';
import { inviteCodeFrom, orgErrorText } from './rules';

/**
 * Accepting an invitation (docs/prd/organizations.md §6.8, slice 8): the link's fragment carries the code (`#<code>`); the page takes it,
 * takes it off the address bar, and joins on a tap. The server checks the signed-in email, the expiry and single use, and throttles.
 */
export function OrgInvitePage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { reload, setContext } = useOrgs();
  const [code] = useState(() => inviteCodeFrom(window.location.hash));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The code leaves the address bar (and the history entry) as soon as it is read.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, []);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.orgs.acceptInvitation({ code });
      await reload();
      setContext({ kind: 'org', id: r.orgId });
      toast(`You joined ${r.orgName}`);
      navigate(`/admin/orgs/${r.orgId}`, { replace: true });
    } catch (e) {
      setError(orgErrorText(e, 'Couldn’t join.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-org-invite="" className="flex flex-col gap-6">
      <PageHeader title="Invitation" />
      <Card className="flex flex-col items-start gap-4 p-4 sm:p-5">
        <Building2 className="size-8 text-accent" aria-hidden="true" />
        {code ? (
          <>
            <p className="text-[15px] [overflow-wrap:anywhere]">You were invited to an organization. Join it with the account you are signed in with.</p>
            <Button loading={busy} onClick={() => void join()} className="min-h-12" data-org-invite-join="">
              Join
            </Button>
          </>
        ) : (
          <p className="text-[15px] text-muted">This link has no invitation in it. Open the whole link you were sent.</p>
        )}
        {error && (
          <p role="alert" className="text-sm font-medium [overflow-wrap:anywhere] text-danger">
            {error}
          </p>
        )}
      </Card>
    </div>
  );
}
