import { Badge, Button, ConfirmDialog, LoadError, Menu, RowsSkeleton, Switch, useToast } from '@isnanme/ui';
import type { CreatedPortalToken, PortalAgentWorkspace, PortalMcpState, PortalToken } from '@portal/contracts';
import { Ban, Bot, ChevronRight, KeyRound, Plug, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { SettingRow } from '@/components/SettingRow';
import { errorText } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { portalMcpApi } from './api';
import { groupTokens, OUTCOME, SCOPE_LABEL, SCOPE_TONE, timeLeft, tokenState, type TokenGroup } from './labels';
import { CodeBlock, MONO } from './parts';
import { CreatedTokenDialog, NewTokenDialog } from './TokenDialogs';

type Confirm =
  | { kind: 'off' }
  | { kind: 'sessions' }
  | { kind: 'revoke'; token: PortalToken }
  | { kind: 'label'; group: TokenGroup; keepNewest: boolean }
  | { kind: 'all' }
  | { kind: 'agent-off'; workspace: PortalAgentWorkspace }
  | null;

/** How often the page looks again while it is open, for the activity list and "last used". */
const REFRESH_MS = 20_000;

/**
 * Access → MCP: the switch and the endpoint, access tokens, agent access per workspace, recent calls, and the
 * advanced switches. Tokens are made here and nowhere else; each is shown once. Words live in ⓘ notes.
 */
export function McpAccess() {
  const toast = useToast();
  const [state, setState] = useState<PortalMcpState | null>(null);
  /** Null while the workspaces are still being listed (the slow part), so the rest of the page doesn't wait for them. */
  const [agents, setAgents] = useState<PortalAgentWorkspace[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedPortalToken | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [showAll, setShowAll] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await portalMcpApi.state());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  const loadAgents = useCallback(() => portalMcpApi.agents().then(setAgents, () => undefined), []);
  useEffect(() => {
    void load();
    void loadAgents();
  }, [load, loadAgents]);
  useEffect(() => {
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string, fail: string) => {
    setBusy(true);
    try {
      await fn();
      setConfirm(null);
      toast(done);
      await Promise.all([load(), loadAgents()]);
    } catch (e) {
      toast(errorText(e, fail), 'error');
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = (enabled: boolean) => act(() => portalMcpApi.updateSettings({ enabled }), enabled ? 'MCP on' : 'MCP off', 'Couldn’t change MCP.');
  const setSessionControl = (sessionControl: boolean) => act(() => portalMcpApi.updateSettings({ sessionControl }), sessionControl ? 'Session control on' : 'Session control off', 'Couldn’t change it.');
  const setAgent = (w: PortalAgentWorkspace, enabled: boolean) => act(() => portalMcpApi.setAgentAccess(w.workspaceId, enabled), enabled ? `Agents in ${w.name} get portal tools` : `Agent access off in ${w.name}`, 'Couldn’t change it.');

  if (failed && !state) return <LoadError onRetry={load} />;
  if (!state) return <RowsSkeleton rows={3} lines={2} trailing icon="rounded-2xl" />;

  const { settings } = state;
  const now = Date.now();
  const live = state.tokens.filter((t) => tokenState(t, now).live);
  const gone = state.tokens.length - live.length;
  const groups = groupTokens(showAll ? state.tokens : live, now);
  const labelCount = confirm?.kind === 'label' ? (confirm.keepNewest ? confirm.group.live.length - 1 : confirm.group.live.length) : 0;
  const agentTokens = (agents ?? []).reduce((n, a) => n + a.liveTokens, 0);

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <ul className="divide-y divide-line">
          <SettingRow
            icon={<Plug className="size-5" />}
            tone={settings.enabled ? 'accent' : 'neutral'}
            label={
              <>
                MCP
                <InfoTip label="About MCP">
                  The portal’s own MCP endpoint: Claude Code, claude.ai or a script manage workspaces, pools and sessions with a token, and agents in a workspace work tickets. Every call is recorded. Off: the endpoint answers 404.
                </InfoTip>
              </>
            }
            sub={settings.enabled ? `${live.length} token${live.length === 1 ? '' : 's'} · ${agentTokens} agent · ${state.callsToday} calls today` : 'Off'}
            trailing={<Switch label="MCP" checked={settings.enabled} disabled={busy} onChange={(on) => (on ? void setEnabled(true) : setConfirm({ kind: 'off' }))} />}
          />
        </ul>
        {settings.enabled && (
          <div className="border-t border-line px-4 py-3 sm:px-5">
            <CodeBlock value={state.url} label="Copy URL" />
          </div>
        )}
      </Card>

      <section>
        <Heading
          title="Tokens"
          tip="One scope each, and it expires. Revoking ends it on its next call. A label names one client: its tokens are grouped, and a new token with a used label replaces them or is added next to them."
          action={
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New
            </Button>
          }
        />
        {groups.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-center text-sm text-muted">No tokens.</p>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {groups.map((g) =>
                g.tokens.length === 1 ? (
                  <TokenRow key={g.label} token={g.tokens[0]!} now={now} onRevoke={() => setConfirm({ kind: 'revoke', token: g.tokens[0]! })} />
                ) : (
                  <GroupRow
                    key={g.label}
                    group={g}
                    now={now}
                    onRevoke={(t) => setConfirm({ kind: 'revoke', token: t })}
                    onRevokeLabel={(keepNewest) => setConfirm({ kind: 'label', group: g, keepNewest })}
                  />
                ),
              )}
            </ul>
          </Card>
        )}
        {(gone > 0 || live.length > 1) && (
          <div className="mt-2 flex items-center justify-between gap-3 text-[13px] text-muted">
            {gone > 0 ? (
              <button type="button" className="rounded-lg font-semibold hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Hide' : 'Show'} {gone} ended
              </button>
            ) : (
              <span />
            )}
            {live.length > 1 && (
              <button type="button" className="rounded-lg font-semibold text-danger focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none" onClick={() => setConfirm({ kind: 'all' })}>
                Revoke all
              </button>
            )}
          </div>
        )}
      </section>

      <section>
        <Heading title="Agents" tip="Agents in a switched-on workspace get portal tools (tickets, notes, proposals for you to review) through a token made for each session. It lives in that session’s process only and ends with it. Off by default." />
        {agents === null ? (
          <RowsSkeleton rows={2} lines={1} trailing icon="rounded-2xl" />
        ) : agents.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-center text-sm text-muted">No workspaces.</p>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {agents.map((w) => (
                <li key={w.workspaceId} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                  <Bot className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{w.name}</span>
                    {w.liveTokens > 0 && <span className="block text-[12.5px] text-muted">{w.liveTokens} live</span>}
                  </span>
                  <Switch label={`Agent access in ${w.name}`} checked={w.enabled} disabled={busy} onChange={(on) => (on ? void setAgent(w, true) : setConfirm({ kind: 'agent-off', workspace: w }))} />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section>
        <Heading title="Activity" tip="The latest calls, newest first. Arguments are kept with secrets removed." />
        {state.activity.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-center text-sm text-muted">No calls yet.</p>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {state.activity.slice(0, 10).map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-semibold" style={{ fontFamily: MONO }}>
                      {a.tool ?? a.method}
                    </p>
                    <p className="truncate text-[12.5px] text-muted" title={formatDateTime(a.at)}>
                      {timeAgo(a.at)} · {a.tokenLabel ?? 'unknown'}
                      {a.errorCode ? ` · ${a.errorCode}` : ''}
                    </p>
                  </div>
                  {a.outcome !== 'ok' && <Badge tone={OUTCOME[a.outcome].tone}>{OUTCOME[a.outcome].label}</Badge>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <div>
        <button
          type="button"
          aria-expanded={more}
          onClick={() => setMore((v) => !v)}
          className="inline-flex items-center gap-1 rounded-lg text-[13px] font-semibold text-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          <ChevronRight className={`size-4 transition-transform ${more ? 'rotate-90' : ''}`} />
          More
        </button>
        {more && (
          <div className="mt-2 flex flex-col gap-3">
            <Card>
              <ul className="divide-y divide-line">
                <SettingRow
                  icon={<Bot className="size-5" />}
                  tone={settings.sessionControl ? 'warning' : 'neutral'}
                  label={
                    <>
                      Session control
                      <InfoTip label="About session control">Admin tokens can start sessions and send them messages, which run commands in a workspace. Off: sessions can be read, interrupted and ended only.</InfoTip>
                    </>
                  }
                  trailing={<Switch label="Session control" checked={settings.sessionControl} disabled={busy} onChange={(on) => (on ? setConfirm({ kind: 'sessions' }) : void setSessionControl(false))} />}
                />
              </ul>
            </Card>
            <p className="text-[13px] text-muted">
              <span className="font-semibold text-ink-soft">{state.tools.length} tools</span> ·{' '}
              <span title={state.tools.map((t) => `${t.name} (${SCOPE_LABEL[t.scope]}${t.agent ? ', agents' : ''})`).join('\n')}>{state.tools.filter((t) => t.agent).length} for agents</span>
            </p>
          </div>
        )}
      </div>

      <NewTokenDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(c) => {
          setCreating(false);
          setCreated(c);
          void load();
        }}
      />
      <CreatedTokenDialog created={created} onClose={() => setCreated(null)} />

      <ConfirmDialog
        open={confirm?.kind === 'off'}
        title="Turn off MCP?"
        description="Calls fail until it is back on. Tokens stay."
        confirmLabel="Turn off"
        loading={busy}
        onConfirm={() => void setEnabled(false)}
        onClose={() => !busy && setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'sessions'}
        tone="primary"
        title="Allow session control?"
        description="Admin tokens can start and steer sessions: code runs in a workspace."
        confirmLabel="Allow"
        loading={busy}
        onConfirm={() => void setSessionControl(true)}
        onClose={() => !busy && setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'revoke'}
        title={confirm?.kind === 'revoke' ? `Revoke “${confirm.token.label}”?` : 'Revoke?'}
        description="It stops working on its next call."
        confirmLabel="Revoke"
        loading={busy}
        onConfirm={() => confirm?.kind === 'revoke' && void act(() => portalMcpApi.revokeToken(confirm.token.id), 'Revoked', 'Couldn’t revoke it.')}
        onClose={() => !busy && setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'label'}
        title={confirm?.kind === 'label' ? `Revoke ${labelCount} “${confirm.group.label}” token${labelCount === 1 ? '' : 's'}?` : 'Revoke?'}
        description={confirm?.kind === 'label' && confirm.keepNewest ? 'The newest one stays.' : 'They stop working on their next call.'}
        confirmLabel="Revoke"
        loading={busy}
        onConfirm={() =>
          confirm?.kind === 'label' && void act(() => portalMcpApi.revokeLabel({ label: confirm.group.label, keepNewest: confirm.keepNewest }), 'Revoked', 'Couldn’t revoke them.')
        }
        onClose={() => !busy && setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'all'}
        title={`Revoke ${live.length + agentTokens} tokens?`}
        description="Agents’ tokens too. MCP stays on."
        confirmLabel="Revoke all"
        loading={busy}
        onConfirm={() => void act(() => portalMcpApi.revokeAll(), 'All revoked', 'Couldn’t revoke them.')}
        onClose={() => !busy && setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'agent-off'}
        title={confirm?.kind === 'agent-off' ? `Turn off agent access in ${confirm.workspace.name}?` : 'Turn off?'}
        description="Its sessions lose their portal tools now."
        confirmLabel="Turn off"
        loading={busy}
        onConfirm={() => confirm?.kind === 'agent-off' && void setAgent(confirm.workspace, false)}
        onClose={() => !busy && setConfirm(null)}
      />
    </div>
  );
}

/** A section's title (with its ⓘ) and an optional action. */
function Heading({ title, tip, action }: { title: string; tip: string; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-1 text-[15px] font-semibold">
        {title}
        <InfoTip label={`About ${title.toLowerCase()}`}>{tip}</InfoTip>
      </h2>
      {action}
    </div>
  );
}

/** A label with more than one token: the count, the newest expiry and the last use; it opens to the tokens. */
function GroupRow({ group: g, now, onRevoke, onRevokeLabel }: { group: TokenGroup; now: number; onRevoke: (t: PortalToken) => void; onRevokeLabel: (keepNewest: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const scopes = [...new Set((g.live.length ? g.live : g.tokens).map((t) => t.scope))];
  const items = [
    ...(g.live.length > 1 ? [{ label: `Revoke older (${g.live.length - 1})`, danger: true, icon: <Ban className="size-4" />, onSelect: () => onRevokeLabel(true) }] : []),
    ...(g.live.length > 0 ? [{ label: `Revoke all (${g.live.length})`, danger: true, icon: <Ban className="size-4" />, onSelect: () => onRevokeLabel(false) }] : []),
  ];
  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-1.5 sm:px-5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ChevronRight className={`size-4 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 text-sm font-semibold break-words">{g.label}</span>
              <Badge tone={g.live.length > 1 ? 'warning' : 'neutral'}>{g.live.length > 0 ? `${g.live.length} live` : `${g.tokens.length} ended`}</Badge>
              {scopes.map((sc) => (
                <Badge key={sc} tone={SCOPE_TONE[sc]}>
                  {SCOPE_LABEL[sc]}
                </Badge>
              ))}
            </span>
            <span className="mt-0.5 block truncate text-[12.5px] text-muted">
              {g.expiresAt ? `newest ${timeLeft(Date.parse(g.expiresAt) - now)} left` : 'none live'} · {g.lastUsedAt ? `used ${timeAgo(g.lastUsedAt)}` : 'never used'}
            </span>
          </span>
        </button>
        {items.length > 0 && <Menu label={`Actions for ${g.label}`} items={items} />}
      </div>
      {open && (
        <ul className="divide-y divide-line border-t border-line bg-surface-2/40 pl-4">
          {g.tokens.map((t) => (
            <TokenRow key={t.id} token={t} now={now} onRevoke={() => onRevoke(t)} />
          ))}
        </ul>
      )}
    </li>
  );
}

function TokenRow({ token: t, now, onRevoke }: { token: PortalToken; now: number; onRevoke: () => void }) {
  const s = tokenState(t, now);
  return (
    <li className="flex items-center gap-3 px-4 py-3 sm:px-5">
      <KeyRound className="size-4 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-semibold">{t.label}</span>
          <Badge tone={SCOPE_TONE[t.scope]}>{SCOPE_LABEL[t.scope]}</Badge>
          {!s.live && <Badge tone={s.tone}>{s.label}</Badge>}
        </div>
        <p className="mt-0.5 truncate text-[12.5px] text-muted" title={t.revokedReason ?? undefined}>
          <span style={{ fontFamily: MONO }}>{t.preview}</span> · {s.live ? s.label : (t.revokedReason ?? s.label)} · {t.lastUsedAt ? timeAgo(t.lastUsedAt) : 'never used'}
        </p>
      </div>
      {s.live && <Menu label={`Actions for ${t.label}`} items={[{ label: 'Revoke', danger: true, icon: <Ban className="size-4" />, onSelect: onRevoke }]} />}
    </li>
  );
}
