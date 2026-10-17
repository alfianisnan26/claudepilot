import { Badge, Button, Dialog, useToast } from '@isnanme/ui';
import type { PortalUser, SessionGrant, SessionGrantLevel } from '@portal/contracts';
import { ShieldAlert, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { api, errorText } from '@/lib/api';

/**
 * Share ONE session with an account (owner, 2026-10-17: "delegate the session ... instead delegating full workspace"). View: read it live.
 * Operate: also send, stop and answer its approvals. Never the terminal, files, other sessions, Bypass, model or end. In Bypass, operate
 * means the person can make the agent run anything in the workspace: said in red.
 */
export function ShareSessionDialog({ sessionId, bypass, open, onClose }: { sessionId: string; bypass: boolean; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [grants, setGrants] = useState<SessionGrant[]>([]);
  const [pick, setPick] = useState('');
  const [level, setLevel] = useState<SessionGrantLevel>('view');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, g] = await Promise.all([api.users(), api.sessionGrants(sessionId)]);
      setUsers(u.filter((x) => x.state === 'active'));
      setGrants(g);
    } catch (e) {
      toast(errorText(e, 'Couldn’t load the shares.'), 'error');
    }
  }, [sessionId, toast]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const grant = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      await api.grantSession(sessionId, pick, level);
      toast('Shared');
      setPick('');
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t share it.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (userId: string) => {
    try {
      await api.revokeSession(sessionId, userId);
      toast('Access removed');
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t remove it.'), 'error');
    }
  };
  const nameOf = (id: string) => users.find((u) => u.id === id)?.email ?? id;
  const holders = new Set(grants.map((g) => g.userId));

  return (
    <Dialog open={open} onClose={onClose} title="Share session" size="sm">
      <div className="flex flex-col gap-3" data-share-session="">
        {grants.length > 0 && (
          <ul className="divide-y divide-line rounded-2xl border border-line">
            {grants.map((g) => (
              <li key={g.userId} className="flex min-h-11 items-center gap-2 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{nameOf(g.userId)}</span>
                <Badge tone={g.level === 'operate' ? 'warning' : 'neutral'}>{g.level === 'operate' ? 'Operate' : 'View'}</Badge>
                <button type="button" onClick={() => void revoke(g.userId)} aria-label={`Remove ${nameOf(g.userId)}`} className="press inline-flex size-11 items-center justify-center rounded-full text-muted hover:bg-danger-soft hover:text-danger">
                  <Trash2 className="size-[18px]" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-ink-soft">Account</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-12 w-full rounded-2xl border border-line bg-surface px-3 text-[15px]">
            <option value="">Choose…</option>
            {users.filter((u) => !holders.has(u.id) || true).map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
                {holders.has(u.id) ? ' (change)' : ''}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="mb-1.5 flex items-center gap-1 text-sm font-semibold text-ink-soft">
            Access
            <InfoTip label="About access">View: read this session live. Operate: also send messages, stop a turn and answer its approvals. Nothing else of the workspace.</InfoTip>
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {(['view', 'operate'] as const).map((l) => (
              <button key={l} type="button" aria-pressed={level === l} onClick={() => setLevel(l)} className={`press min-h-11 rounded-2xl border px-3 text-sm font-semibold ${level === l ? 'border-accent bg-accent-soft text-ink' : 'border-line text-ink-soft'}`}>
                {l === 'view' ? 'View' : 'Operate'}
              </button>
            ))}
          </div>
        </fieldset>
        {level === 'operate' && bypass && (
          <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            This session is in Bypass: whoever can message it can make the agent run any command in its workspace.
          </p>
        )}
        <Button size="lg" loading={busy} disabled={!pick} onClick={() => void grant()} className="w-full">
          Share
        </Button>
      </div>
    </Dialog>
  );
}
