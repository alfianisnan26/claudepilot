import { Badge, Button, ConfirmDialog, Spinner, useToast } from '@isnanme/ui';
import { claudeFeature, claudeMinimum, type McpServerAuth, type McpServerStatus, type McpWorkspaceStatus, type Workspace, type WorkspacePoolAssignment } from '@portal/contracts';
import { KeyRound, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { forbiddenReason } from './access';
import { mcpApi } from './api';
import { AuthChip, authDetail } from './AuthChip';
import { clock, DELIVERY, VERIFY } from './labels';
import { MONO } from './parts';
import { SignInDialog, type SignInTarget } from './SignInDialog';
import { useEscapeFirst } from './useEscapeFirst';

const serverId = (s: { plugin: string; key: string }) => `${s.plugin}/${s.key}`;

/**
 * The MCP sets row's detail in a workspace's Configuration (PRD §15, FR17): each server's delivery state
 * with its next step, the npm pre-install (§12) with Retry, whether Claude Code lists the set's servers
 * (FR16) with "Verify again", names the workspace's Secrets sets don't provide (US3), FR11's warnings,
 * and when changes apply (§10.3). Every in-workspace status says "as of HH:MM".
 */
export function McpConfiguration({ workspace, assignments }: { workspace: Workspace; assignments: WorkspacePoolAssignment[] }) {
  const toast = useToast();
  const [data, setData] = useState<McpWorkspaceStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<'installs' | 'verify' | null>(null);
  // OAuth (§13.3): the server being signed in to or out of, a check under way, and results newer than the last load.
  const [signingIn, setSigningIn] = useState<SignInTarget | null>(null);
  const [signingOut, setSigningOut] = useState<SignInTarget | null>(null);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [authNow, setAuthNow] = useState<Record<string, McpServerAuth>>({});
  // The portal's reason when it refused this person's sign-in, check or sign-out (403): those actions then show off, with it.
  const [authBlocked, setAuthBlocked] = useState<string | null>(null);
  const running = workspace.status === 'running';
  const id = workspace.id;

  const load = useCallback(async () => {
    try {
      setData(await mcpApi.workspace(id));
      setAuthNow({});
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);
  useEffect(() => void load(), [load, assignments.length]);
  useLive('pools', () => void load());

  const run = async (what: 'installs' | 'verify') => {
    setBusy(what);
    try {
      await (what === 'installs' ? mcpApi.retryInstalls(id) : mcpApi.verify(id));
      toast(what === 'installs' ? 'Installing again' : 'Checking the sets in the workspace');
    } catch (e) {
      toast(errorText(e, 'Could not start it.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const target = (s: McpServerStatus): SignInTarget => ({ plugin: s.plugin, key: s.key, name: s.entryName });
  const check = async (s: McpServerStatus) => {
    setChecking(serverId(s));
    try {
      const entries = await mcpApi.checkAuth(id, { plugin: s.plugin, key: s.key });
      const found = entries.find((e) => e.plugin === s.plugin && e.key === s.key);
      if (found) setAuthNow((m) => ({ ...m, [serverId(s)]: found.auth }));
    } catch (e) {
      const refused = forbiddenReason(e);
      if (refused) setAuthBlocked(refused);
      toast(refused ?? errorText(e, 'Could not check the sign-in.'), 'error');
    } finally {
      setChecking(null);
    }
  };
  const signedIn = (auth: McpServerAuth, t: SignInTarget) => {
    setSigningIn(null);
    setAuthNow((m) => ({ ...m, [serverId(t)]: auth }));
    if (auth.state === 'connected') toast(`Signed in to ${t.name}`);
    else toast(auth.detail ?? 'Signed in, but the server is not connected yet.', 'error');
    void load();
  };
  const signOut = async () => {
    if (!signingOut) return;
    setSignOutBusy(true);
    try {
      const auth = await mcpApi.signOut(id, { plugin: signingOut.plugin, key: signingOut.key });
      setAuthNow((m) => ({ ...m, [serverId(signingOut)]: auth }));
      toast(`Signed out of ${signingOut.name}`);
      setSigningOut(null);
      void load();
    } catch (e) {
      const refused = forbiddenReason(e);
      if (refused) {
        setAuthBlocked(refused);
        setSigningOut(null);
      }
      toast(refused ?? errorText(e, 'Could not sign out.'), 'error');
    } finally {
      setSignOutBusy(false);
    }
  };
  // The confirmation opens over the Configuration sheet: Escape closes it alone.
  useEscapeFirst(!!signingOut, () => !signOutBusy && setSigningOut(null));

  if (failed && !data) return <p className="text-[13px] text-muted">Could not load the servers’ status.</p>;
  if (!data) return null;
  const { servers, verify, missingNames, warnings } = data;
  const sets = new Set(servers.map((s) => s.poolId)).size;
  const latest = [...servers.map((s) => s.updatedAt), ...verify.map((v) => v.at)].sort().at(-1);
  const installFailed = servers.some((s) => s.install?.state === 'failed');
  const unverified = verify.filter((v) => v.result !== 'ok');
  const delivered = servers.some((s) => s.state === 'delivered' || s.state === 'pending_start');

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      {servers.length === 0 ? (
        <p className="text-muted">Nothing delivered yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {servers.map((s) => (
            <ServerLine
              key={serverId(s)}
              server={s}
              showSet={sets > 1}
              auth={authNow[serverId(s)] ?? s.auth ?? null}
              running={running}
              checking={checking === serverId(s)}
              blocked={authBlocked}
              onSignIn={() => setSigningIn(target(s))}
              onCheck={() => void check(s)}
              onSignOut={() => setSigningOut(target(s))}
            />
          ))}
        </ul>
      )}
      {missingNames.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl bg-flame-soft px-3 py-2 text-ink-soft">
          <KeyRound className="mt-0.5 size-4 shrink-0" />
          <span>
            Needs{' '}
            <span className="text-[12px]" style={{ fontFamily: MONO }}>
              {missingNames.join(', ')}
            </span>
            : assign a Secrets set that has {missingNames.length === 1 ? 'it' : 'them'}.
          </span>
        </p>
      )}
      {unverified.map((v) => (
        <p key={v.plugin} className="text-ink-soft">
          <Badge tone={VERIFY[v.result].tone}>{VERIFY[v.result].label}</Badge>{' '}
          <span className="text-[12px]" style={{ fontFamily: MONO }}>
            {v.plugin}
          </span>
          {v.detail ? `: ${v.detail}` : ''} <span className="text-muted">as of {clock(v.at)}</span>
        </p>
      ))}
      {warnings.map((w) => (
        <p key={w} className="flex items-start gap-2 text-ink-soft">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-flame" />
          {w}
        </p>
      ))}
      {(servers.length > 0 || installFailed) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {latest && <span className="text-[12px] text-muted">As of {clock(latest)}</span>}
          {delivered && <InfoTip label="When changes apply">Applies in new sessions, or after /reload-plugins. In portal chat, start a new session.</InfoTip>}
          <span className="flex-1" />
          {installFailed && (
            <Button variant="secondary" size="sm" onClick={() => void run('installs')} disabled={!running || !!busy}>
              {busy === 'installs' ? <Spinner className="size-3" /> : 'Retry installs'}
            </Button>
          )}
          {delivered && (
            <Button variant="ghost" size="icon" aria-label="Verify again" title="Verify again" onClick={() => void run('verify')} disabled={!running || !!busy} className="size-8">
              {busy === 'verify' ? <Spinner className="size-3" /> : <RefreshCw className="size-4" />}
            </Button>
          )}
        </div>
      )}
      <SignInDialog workspaceId={id} target={signingIn} onClose={() => setSigningIn(null)} onDone={signedIn} onForbidden={setAuthBlocked} />
      <ConfirmDialog
        open={!!signingOut}
        title={`Sign out of ${signingOut?.name ?? ''}?`}
        description="Agents in this workspace lose access to it until you sign in again."
        confirmLabel="Sign out"
        loading={signOutBusy}
        onConfirm={() => void signOut()}
        onClose={() => !signOutBusy && setSigningOut(null)}
      />
    </div>
  );
}

function ServerLine({
  server: s,
  showSet,
  auth,
  running,
  checking,
  blocked,
  onSignIn,
  onCheck,
  onSignOut,
}: {
  server: McpServerStatus;
  showSet: boolean;
  auth: McpServerAuth | null;
  running: boolean;
  checking: boolean;
  blocked: string | null;
  onSignIn: () => void;
  onCheck: () => void;
  onSignOut: () => void;
}) {
  const state = DELIVERY[s.state];
  const notListed = s.listed === false;
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-ink" style={{ fontFamily: MONO }}>
          {s.key}
        </span>
        <span className="text-ink-soft">
          {s.entryName} {s.version}
        </span>
        {showSet && <span className="text-muted">in {s.poolName}</span>}
        {auth && s.state === 'delivered' ? (
          <AuthChip auth={auth} running={running} checking={checking} blocked={blocked} onSignIn={onSignIn} onCheck={onCheck} onSignOut={onSignOut} />
        ) : (
          <Badge tone={state.tone}>{state.label}</Badge>
        )}
        {s.state === 'claude_too_old' && <InfoTip label="About the Claude Code version">MCP sets need Claude Code {claudeMinimum('mcp-sets')} or newer. {claudeFeature('mcp-sets').why} Upgrade it in the workspace’s Configuration.</InfoTip>}
        {s.install?.state === 'installing' && <Badge tone="neutral">Installing</Badge>}
        {s.install?.state === 'failed' && <Badge tone="danger">Install failed</Badge>}
        {notListed && <Badge tone="danger">Not loaded</Badge>}
      </span>
      {s.reason && <span className="text-muted">{s.reason}</span>}
      {s.install?.state === 'failed' && s.install.error && <span className="text-muted">{s.install.error}</span>}
      {auth && s.state === 'delivered' && authDetail(auth) && <span className="text-muted">{authDetail(auth)}</span>}
    </li>
  );
}
