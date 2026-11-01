import { Button, ConfirmDialog, Dialog, useToast } from '@isnanme/ui';
import type { Org } from '@portal/contracts';
import { Pause, Play, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Card } from '@/components/Card';
import { HOME } from '@/app/nav';
import { api } from '@/lib/api';
import { PERSONAL } from '@/lib/orgContext';
import { orgField } from './NewOrgDialog';
import { useOrgs } from './OrgsProvider';
import { confirmsDelete, orgErrorText } from './rules';
import { Alert, SectionTitle } from './settingsUi';

/**
 * Danger zone (owners only): suspend (every right from the org is none until resumed; owners still see it) or resume one an owner
 * suspended, and delete (only when it owns nothing; typed confirmation with the slug; hidden for 30 days, then purged).
 */
export function DangerSection({ org, onChanged }: { org: Org; onChanged: (org: Org) => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { reload: reloadOrgs, setContext } = useOrgs();
  const [error, setError] = useState<string | null>(null);
  const [suspending, setSuspending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (deleting) setTyped('');
  }, [deleting]);

  const run = async (fn: () => Promise<Org>, done: string, fallback: string) => {
    setError(null);
    try {
      onChanged(await fn());
      await reloadOrgs();
      toast(done);
    } catch (e) {
      setError(orgErrorText(e, fallback));
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.orgs.delete(org.id);
      setDeleting(false);
      setContext(PERSONAL);
      await reloadOrgs();
      toast('Organization deleted');
      navigate(HOME);
    } catch (e) {
      setDeleting(false);
      setError(orgErrorText(e, 'Couldn’t delete it.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="org-danger" data-org-danger="">
      <SectionTitle id="org-danger" about="Suspending stops every right that comes from the organization until an owner resumes it. Deleting needs it to own nothing; it is gone after 30 days.">
        Danger zone
      </SectionTitle>
      <Alert text={error} />
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:p-5">
        {org.state === 'active' ? (
          <Button variant="secondary" icon={<Pause className="size-4" />} onClick={() => setSuspending(true)} data-org-suspend="">
            Suspend
          </Button>
        ) : (
          <Button variant="secondary" icon={<Play className="size-4" />} onClick={() => run(() => api.orgs.resume(org.id), 'Resumed', 'Couldn’t resume it.')} data-org-resume="">
            Resume
          </Button>
        )}
        <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(true)} data-org-delete="">
          Delete
        </Button>
      </Card>
      <ConfirmDialog
        open={suspending}
        title="Suspend organization?"
        description="Nobody can use its things until an owner resumes it."
        confirmLabel="Suspend"
        onConfirm={() => {
          setSuspending(false);
          void run(() => api.orgs.suspend(org.id), 'Suspended', 'Couldn’t suspend it.');
        }}
        onClose={() => setSuspending(false)}
      />
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete organization?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} disabled={!confirmsDelete(typed, org.slug)} onClick={() => void remove()} data-org-delete-confirm="">
              Delete
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm [overflow-wrap:anywhere]">
            Type <span className="font-mono font-semibold">{org.slug}</span> to delete {org.name}.
          </span>
          <input type="text" autoComplete="off" autoCapitalize="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} className={orgField} data-org-delete-input="" />
        </label>
      </Dialog>
    </section>
  );
}
