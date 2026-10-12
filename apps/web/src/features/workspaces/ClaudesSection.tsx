import { Badge, Button, ConfirmDialog, FormDialog, Menu, TextField, useToast, type MenuItem } from '@isnanme/ui';
import { CLAUDE_NAME_MAX, type Workspace, type WorkspaceClaude, type WorkspaceClaudeState, type WorkspaceTerminal } from '@portal/contracts';
import { Bot, LogIn, LogOut, Pencil, Plus, SquareTerminal, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { chatApi } from '@/features/chat/api';
import { ClaudeMeter } from '@/features/usage/claude';
import { api, errorText } from '@/lib/api';
import { ClaudeLoginDialog } from './ClaudeLoginDialog';

type Naming = { claude: WorkspaceClaude | null } | null;

/**
 * The workspace's Claudes (Workspace Claudes): each a directory with its own Claude Code login and
 * chats. Per Claude: whether it's signed in (status and method only), its terminals, and Sign in,
 * Switch account, Sign out, Rename and Remove; New adds one, signed out. A pool on the workspace
 * replaces own sign-ins, so those actions wait until it's unassigned.
 */
export function ClaudesSection({ workspace: w, onLeave }: { workspace: Workspace; onLeave: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [states, setStates] = useState<WorkspaceClaudeState[] | null>(null);
  const [terminals, setTerminals] = useState<WorkspaceTerminal[]>([]);
  const [signingIn, setSigningIn] = useState<WorkspaceClaude | null>(null);
  const [signingOut, setSigningOut] = useState<WorkspaceClaude | null>(null);
  const [removing, setRemoving] = useState<WorkspaceClaude | null>(null);
  const [naming, setNaming] = useState<Naming>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, t] = await Promise.all([api.workspaces.claudes(w.id).catch(() => []), api.workspaces.terminals(w.id).catch(() => [])]);
    setStates(s);
    setTerminals(t);
  }, [w.id]);
  useEffect(() => void load(), [load]);

  /** Its first terminal, or a new Claude terminal on it. */
  const openTerminal = async (c: WorkspaceClaude) => {
    setBusy(c.id);
    try {
      const existing = terminals.find((t) => t.claudeId === c.id);
      const term = existing ?? (await api.workspaces.openTerminal(w.id, { kind: 'claude', claudeId: c.id }));
      onLeave();
      navigate(`/admin/workspaces/${w.id}/shell?term=${term.id}`);
    } catch (e) {
      toast(errorText(e, 'Couldn’t open its terminal.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    if (!signingOut) return;
    setBusy(signingOut.id);
    try {
      await api.workspaces.claudeLogout(w.id, signingOut.directory ? signingOut.id : undefined);
      toast(`${signingOut.name} signed out`);
      setSigningOut(null);
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t sign out.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(removing.id);
    try {
      await api.workspaces.removeClaude(w.id, removing.id);
      toast(`${removing.name} removed`);
      setRemoving(null);
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t remove it.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const saveName = async () => {
    if (!naming) return;
    const label = name.trim();
    if (!label) return setNameError('Name the Claude.');
    try {
      if (naming.claude) await api.workspaces.renameClaude(w.id, naming.claude.id, label);
      else await chatApi.createClaude({ workspaceId: w.id, name: label });
      toast(naming.claude ? 'Renamed' : `${label} added. Sign in to use it.`);
      setNaming(null);
      await load();
    } catch (e) {
      const details = (e as { details?: { name?: string } }).details;
      if (details?.name) setNameError(details.name);
      else setNameError(errorText(e, 'Couldn’t save it.'));
    }
  };

  const pooled = !!w.account;

  return (
    <section aria-label="Claudes" className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold text-muted">Claudes{states ? ` · ${states.length}` : ''}</p>
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus className="size-4" />}
          onClick={() => (setNaming({ claude: null }), setName(''), setNameError(undefined))}
        >
          New
        </Button>
      </div>
      {!states ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {states.map(({ claude: c, auth, terminals: count }) => {
            const signedIn = !!auth?.loggedIn;
            const items: MenuItem[] = [
              {
                label: signedIn ? 'Switch account…' : 'Sign in…',
                icon: <LogIn className="size-4" />,
                onSelect: () => setSigningIn(c),
                disabled: pooled || !auth,
              },
              ...(signedIn ? [{ label: 'Sign out', icon: <LogOut className="size-4" />, onSelect: () => setSigningOut(c), disabled: pooled }] : []),
              { label: 'Rename…', icon: <Pencil className="size-4" />, onSelect: () => (setNaming({ claude: c }), setName(c.name), setNameError(undefined)) },
              ...(c.directory
                ? [{ label: 'Remove', icon: <Trash2 className="size-4" />, onSelect: () => setRemoving(c), danger: true, disabled: count > 0 }]
                : []),
            ];
            return (
              <li key={c.id} className="flex items-center gap-3 rounded-xl bg-surface-2 py-2 pr-1.5 pl-3">
                <Bot className={`size-4 shrink-0 ${signedIn ? 'text-accent' : 'text-muted'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <p className="truncate text-sm font-semibold">{c.name}</p>
                    <span className="shrink-0">
                      {auth === null ? (
                        <Badge tone="neutral">Unknown</Badge>
                      ) : signedIn ? (
                        <Badge tone="success">Signed in{auth.method === 'console' ? ' · key' : ''}</Badge>
                      ) : (
                        <Badge tone="neutral">Signed out</Badge>
                      )}
                    </span>
                  </div>
                  <p className="truncate text-[12.5px] text-muted">
                    {count ? `${count} terminal${count > 1 ? 's' : ''}` : 'No terminal'}
                    {c.directory ? '' : ' · original home'}
                  </p>
                </div>
                <ClaudeMeter claudeId={c.id} />
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<SquareTerminal className="size-4" />}
                  aria-label={`Open a terminal as ${c.name}`}
                  loading={busy === c.id}
                  onClick={() => void openTerminal(c)}
                />
                <Menu label={`Actions for ${c.name}`} items={items} />
              </li>
            );
          })}
        </ul>
      )}
      {pooled && <p className="text-[12.5px] text-muted">This workspace uses its account pool; own sign-ins wait until it’s unassigned.</p>}

      <ClaudeLoginDialog
        workspace={signingIn ? w : null}
        claude={signingIn}
        onClose={() => setSigningIn(null)}
        onDone={() => {
          toast(`${signingIn?.name ?? 'Claude'} signed in`);
          setSigningIn(null);
          void load();
        }}
      />
      <ConfirmDialog
        open={!!signingOut}
        tone="primary"
        title={`Sign out ${signingOut?.name ?? ''}?`}
        description="Claude Code forgets this Claude’s sign-in. The other Claudes keep theirs."
        confirmLabel="Sign out"
        loading={!!signingOut && busy === signingOut.id}
        onConfirm={() => void signOut()}
        onClose={() => setSigningOut(null)}
      />
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.name ?? ''}?`}
        description="It leaves the list. Its directory, with any login and chats in it, stays on the workspace."
        confirmLabel="Remove"
        loading={!!removing && busy === removing.id}
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
      <FormDialog
        open={!!naming}
        onClose={() => setNaming(null)}
        size="sm"
        title={naming?.claude ? `Rename ${naming.claude.name}` : 'New Claude'}
        description={naming?.claude ? undefined : 'Its own directory, login and chats. It starts signed out.'}
        onSubmit={saveName}
        submitLabel={naming?.claude ? 'Save' : 'Add'}
      >
        <TextField
          label="Name"
          maxLength={CLAUDE_NAME_MAX}
          placeholder="Work"
          autoComplete="off"
          value={name}
          onChange={(e) => (setName(e.target.value), setNameError(undefined))}
          error={nameError}
        />
      </FormDialog>
    </section>
  );
}
