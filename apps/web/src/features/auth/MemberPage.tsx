import { Button } from '@isnanme/ui';
import type { SignedInAs } from '@portal/contracts';
import { UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AuthLayout } from '@/components/AuthLayout';
import { InfoTip } from '@/components/InfoTip';
import { useAuth } from '@/lib/auth';
import { ChangePasswordDialog } from './ChangePasswordDialog';

/** A member account (MU2 S1a): signed in, but nothing is shared with it yet. Shows who is signed in and a way out. */
export function MemberPage() {
  const { logout } = useAuth();
  const [me, setMe] = useState<SignedInAs | null>(null);
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    void fetch('/api/me', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j: { data?: SignedInAs }) => j.data && setMe(j.data))
      .catch(() => undefined);
  }, []);
  const user = me?.kind === 'account' ? me.user : null;
  return (
    <AuthLayout title="Signed in">
      <div className="flex flex-col gap-4" data-member-page="">
        <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
          <UserRound className="size-5 shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block font-semibold [overflow-wrap:anywhere]">{user?.displayName ?? '…'}</span>
            <span className="block text-sm text-muted [overflow-wrap:anywhere]">{user?.email ?? ''}</span>
          </span>
        </div>
        <p className="flex items-center gap-1 text-sm text-ink-soft">
          No access yet
          <InfoTip label="About member accounts">An admin shares a workspace with you, then it shows here.</InfoTip>
        </p>
        <Button size="lg" variant="ghost" className="w-full" onClick={() => setChanging(true)}>
          Change password
        </Button>
        <Button size="lg" variant="ghost" className="w-full" onClick={() => void logout()}>
          Sign out
        </Button>
        <ChangePasswordDialog open={changing} onClose={() => setChanging(false)} />
      </div>
    </AuthLayout>
  );
}
