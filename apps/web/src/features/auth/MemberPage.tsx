import { Button } from '@isnanme/ui';
import type { DelegatedSession, SignedInAs } from '@portal/contracts';
import { MessageSquare, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AuthLayout } from '@/components/AuthLayout';
import { InfoTip } from '@/components/InfoTip';
import { useAuth } from '@/lib/auth';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { DelegatedSessionView } from './DelegatedSessionView';
import { api } from '@/lib/api';

/** A member account (MU2 S1a): signed in, but nothing is shared with it yet. Shows who is signed in and a way out. */
export function MemberPage() {
  const { logout } = useAuth();
  const [me, setMe] = useState<SignedInAs | null>(null);
  const [changing, setChanging] = useState(false);
  const [shared, setShared] = useState<DelegatedSession[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void api.delegated().then(setShared, () => setShared([]));
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    void fetch('/api/me', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j: { data?: SignedInAs }) => j.data && setMe(j.data))
      .catch(() => undefined);
  }, []);
  const user = me?.kind === 'account' ? me.user : null;
  if (openId)
    return (
      <AuthLayout title="Shared session">
        <DelegatedSessionView id={openId} onBack={() => setOpenId(null)} />
      </AuthLayout>
    );
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
        {shared && shared.length > 0 ? (
          <ul className="flex flex-col gap-1" data-shared-with-me="">
            {shared.map((x) => (
              <li key={x.id}>
                <button type="button" onClick={() => setOpenId(x.id)} className="press flex min-h-11 w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-surface-2">
                  <MessageSquare className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{x.title}</span>
                    <span className="block truncate text-[12.5px] text-muted">
                      {x.workspaceId} · {x.state} · {x.level === 'operate' ? 'operate' : 'view'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-1 text-sm text-ink-soft">
            No access yet
            <InfoTip label="About member accounts">An admin shares a session with you, then it shows here.</InfoTip>
          </p>
        )}
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
