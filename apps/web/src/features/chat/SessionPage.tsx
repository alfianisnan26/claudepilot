import { Badge, cn, ConfirmDialog, Menu, Spinner, useMediaQuery, useToast, type MenuItem } from '@isnanme/ui';
import type { ChatRequest, ChatSession } from '@portal/contracts';
import { Archive, ArchiveRestore, ArrowLeft, Bot, CircleStop, FolderOpen, Gauge, GitBranch, ListCollapse, ListTree, MoreHorizontal, Pencil, ShieldAlert, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { BRAND_NAME } from '@/components/Logo';
import { usePersonaOf } from '@/features/personas/identities';
import { PersonaAvatar } from '@/features/personas/PersonaAvatar';
import { TicketChip } from '@/features/tickets/TicketChip';
import { RunChip } from '@/features/ci/RunChip';
import { errorText } from '@/lib/api';
import { pinnedToViewport, useVisualViewport } from '@/lib/viewport';
import { AgentsPanel, AgentsSheet } from './AgentsPanel';
import { chatApi } from './api';
import { ApprovalCard } from './ApprovalCard';
import { Composer, type ComposerHandle } from './Composer';
import { Controls, modeDetails, type ControlsHandle } from './Controls';
import { FilesPanel, FilesSheet, INITIAL_FILES_VIEW, type FilesView } from './FilesPanel';
import { endedForSafety, StateBadge } from './shared';
import { Transcript } from './Transcript';
import { ResumeBanner } from './ResumeBanner';
import { ArchiveSessionDialog, DeleteSessionDialog, EndSessionDialog, RenameSessionDialog } from './SessionDialogs';
import { useMoveChat } from './SwitchDialog';
import { TrustSheet, useFolderTrust, type TrustTarget } from './TrustSheet';
import { UsageDialog } from './Usage';
import { useChatSession, type ChatControlArgs, type ChatControlOp, type ChatSendOptions } from './useChatSocket';
import { useWorkspaceFacts } from './useWorkspaceFacts';

/** The side panels: one at a time. */
type Side = 'agents' | 'files';

/** Which side panel is open on wide screens, remembered on this device: `1` agents (the default), `files`, `0` none. */
const PANEL_KEY = 'claudepilot.chat-agents-panel';
function savedPanel(): Side | null {
  try {
    const saved = localStorage.getItem(PANEL_KEY);
    return saved === '0' ? null : saved === 'files' ? 'files' : 'agents';
  } catch {
    return 'agents';
  }
}

/** Show all details, remembered in this browser for every session. */
const DETAILS_KEY = 'claudepilot.chat-details';
function savedDetails(): boolean {
  try {
    return localStorage.getItem(DETAILS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * One session, full screen (like the shell): a header with the state and controls, the transcript,
 * the approvals dock, the session's controls and the composer pinned to the bottom. From 1280 px the
 * agents or files panel sits on the right (toggleable, one at a time); below that each opens as a
 * sheet, and below 640 px Files and Agents move into the header's ⋯ menu. It owns the dedicated chat
 * socket for as long as it's mounted. A send, resume or change refused because the session's folder
 * needs trust asks first ("Trust this folder?") and runs again once trusted.
 */
export function SessionPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { connected, events, delta, session, removed, inputs, outbox, tasks, send, respond, control, stop, end } = useChatSession(id);
  const [ending, setEnding] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Deleted here (the dialog leaves on its own) or in another tab: back to the list.
  const leaving = useRef(false);
  useEffect(() => {
    if (!removed || leaving.current) return;
    leaving.current = true;
    toast('That session was deleted');
    navigate('/admin/sessions', { replace: true });
  }, [removed, navigate, toast]);
  const [usageOpen, setUsageOpen] = useState(false);
  /** Archive (FR4): ends it if it's still going, then back to the list, where it's under Archived. */
  const archive = async () => {
    try {
      await chatApi.archive(id);
      toast('Archived');
      navigate('/admin/sessions');
    } catch (e) {
      toast(errorText(e, 'Could not archive it.'), 'error');
    }
  };
  const unarchive = async () => {
    try {
      await chatApi.unarchive(id);
      toast('Back in Sessions');
    } catch (e) {
      toast(errorText(e, 'Could not unarchive it.'), 'error');
    }
  };
  const composer = useRef<ComposerHandle>(null);
  const controls = useRef<ControlsHandle>(null);
  // The page follows the visible area, so the header stays put when the keyboard opens (iOS scrolls the
  // page instead of resizing it); the transcript scrolls under the glass header and dock.
  // A focused composer on a phone means the keyboard: the dock drops its safe-area gap at once.
  const viewport = useVisualViewport({ keyboardOnFocus: true });
  const dock = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(0);
  useLayoutEffect(() => {
    const el = dock.current;
    if (!el) return;
    const measure = () => setDockHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A refused start's ack names no folder, and the session doesn't either: its folder is where Files
  // opens by default.
  const sessionRef = useRef(session);
  useLayoutEffect(() => {
    sessionRef.current = session;
  });
  const locate = useCallback(async (): Promise<TrustTarget> => {
    const [s, folder] = await Promise.all([sessionRef.current ?? chatApi.get(id), chatApi.files(id)]);
    return { workspaceId: s.workspaceId, folder: folder.path };
  }, [id]);
  const trust = useFolderTrust(id, locate);
  const { guard } = trust;
  const trustedSend = useCallback((text: string, opts?: ChatSendOptions) => guard(() => send(text, opts)), [guard, send]);
  const trustedControl = useCallback((op: ChatControlOp, args?: ChatControlArgs) => guard(() => control(op, args)), [guard, control]);
  const stopTask = useCallback((taskId: string) => control('stop_task', { taskId }), [control]);
  const interrupt = useCallback(() => control('stop'), [control]);
  // Leaving Bypass is one tap (FR20): back to the start mode, no confirmation.
  const leaveBypass = useCallback(async () => {
    try {
      await trustedControl('mode', { mode: 'default' });
      toast('Bypass off');
    } catch (e) {
      toast(errorText(e, 'Could not turn Bypass off.'), 'error');
    }
  }, [trustedControl, toast]);

  const wide = useMediaQuery('(min-width: 1280px)');
  // Below 640 px the title needs the room: Files and Agents live in the ⋯ menu.
  const roomy = useMediaQuery('(min-width: 640px)');
  const [panel, setPanel] = useState(savedPanel);
  const [sheet, setSheet] = useState<Side | null>(null);
  const open = wide ? panel : sheet;
  const agentsOpen = open === 'agents';
  const filesOpen = open === 'files';
  // The sheet is for narrow screens; when the window widens, the side panel takes over.
  useEffect(() => {
    if (wide) setSheet(null);
  }, [wide]);
  const toggle = (side: Side) => {
    if (!wide) return setSheet((v) => (v === side ? null : side));
    const next = panel === side ? null : side;
    setPanel(next);
    try {
      localStorage.setItem(PANEL_KEY, next === null ? '0' : next === 'agents' ? '1' : 'files');
    } catch {
      // private window: just not remembered
    }
  };
  const [details, setDetails] = useState(savedDetails);
  const toggleDetails = () => {
    const next = !details;
    setDetails(next);
    try {
      localStorage.setItem(DETAILS_KEY, next ? '1' : '0');
    } catch {
      // private window: just not remembered
    }
  };
  const toggleAgents = () => toggle('agents');
  const toggleFiles = () => toggle('files');
  // Where Files is (tab, folder) survives closing the panel; another session starts fresh, before
  // anything renders with this one's folder.
  const [filesView, setFilesView] = useState<FilesView>(INITIAL_FILES_VIEW);
  const [filesFor, setFilesFor] = useState(id);
  if (filesFor !== id) {
    setFilesFor(id);
    setFilesView(INITIAL_FILES_VIEW);
  }

  useEffect(() => {
    document.title = `${session?.title || 'Session'} · chat`;
    return () => void (document.title = BRAND_NAME);
  }, [session?.title]);

  // A moved chat is still this session. An old link to a session an earlier move had made (its id is an alias
  // now) opens the chat under its own id.
  useEffect(() => {
    if (session && session.id !== id) navigate(`/admin/sessions/${session.id}`, { replace: true });
  }, [session, id, navigate]);

  const move = useMoveChat();
  const openSwitch = () => session && move.start(session);

  // Open requests: a `request` with no later `resolved`, oldest first (events are seq-ordered).
  const openRequests = useMemo(() => {
    const resolved = new Set<string>();
    for (const e of events) if (e.kind === 'resolved' && e.requestId) resolved.add(e.requestId);
    const open: ChatRequest[] = [];
    for (const e of events) if (e.kind === 'request' && e.request && !resolved.has(e.request.requestId)) open.push(e.request);
    return open;
  }, [events]);
  const current = openRequests[0] ?? null;

  // Sub-agent lines carry the `Task` tool_use id as their label; people read the task's description.
  const agentNames = useMemo(
    () => new Map(tasks.flatMap((t) => (t.toolUseId ? [[t.toolUseId, t.description || t.subagentType || 'Agent'] as const] : []))),
    [tasks],
  );
  const running = tasks.filter((t) => t.status === 'running').length;

  // Withdrawn: the words come back into the box, so they can be fixed and sent again.
  const cancelQueued = useCallback(
    async (uuid: string, text: string) => {
      try {
        await control('cancel_queued', { inputUuid: uuid });
        composer.current?.restore(text);
      } catch (e) {
        toast(errorText(e, 'Could not withdraw it.'), 'error');
      }
    },
    [control, toast],
  );

  // The workspace's persona (I11): its name and avatar, where the session says who it is.
  const persona = usePersonaOf(session?.workspaceId);
  const state = session?.state ?? 'starting';
  const working = state === 'working';
  const ended = state === 'ended';
  const bypass = session?.mode === 'bypassPermissions' && !ended;
  // Its workspace was removed: the transcript is all that's left, so nothing that needs the workspace is offered.
  const { factOf } = useWorkspaceFacts();
  const gone = !!session && !!factOf(session.workspaceId)?.gone;

  // What the ⋯ menu opens takes focus back to ⋯ when it closes (the menu item it came from is gone by then).
  const menuRef = useRef<HTMLDivElement>(null);
  const fromMenu = (fn: () => void) => () => {
    menuRef.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus({ preventScroll: true });
    fn();
  };
  const agentsLabel = running ? `Agents, ${running} running` : 'Agents';
  const mode = modeDetails(session?.mode ?? 'default');
  const ModeIcon = mode.icon;
  const menuItems: MenuItem[] = [
    ...(roomy
      ? []
      : [
          ...(gone ? [] : [{ label: 'Files and changes', icon: <FolderOpen className="size-4" />, onSelect: fromMenu(toggleFiles) }]),
          { label: running ? `Agents · ${running} running` : 'Agents', icon: <Bot className="size-4" />, onSelect: fromMenu(toggleAgents) },
          // Phones keep the line above the composer short: the permission mode is changed from here.
          ...(session && !ended && !gone
            ? [{ label: `Mode: ${mode.label}`, icon: <ModeIcon className="size-4" />, onSelect: fromMenu(() => controls.current?.openMode()) }]
            : []),
        ]),
    { label: 'Rename…', icon: <Pencil className="size-4" />, onSelect: fromMenu(() => setRenaming(true)), disabled: !session },
    { label: 'Usage', icon: <Gauge className="size-4" />, onSelect: fromMenu(() => setUsageOpen(true)) },
    details
      ? { label: 'Show less', icon: <ListCollapse className="size-4" />, onSelect: fromMenu(toggleDetails) }
      : { label: 'Show all details', icon: <ListTree className="size-4" />, onSelect: fromMenu(toggleDetails) },
    {
      label: 'Move to another Claude…',
      icon: <Bot className="size-4" />,
      onSelect: fromMenu(openSwitch),
      disabled: gone || ended || !!session?.switching,
    },
    session?.archivedAt
      ? { label: 'Unarchive', icon: <ArchiveRestore className="size-4" />, onSelect: fromMenu(() => void unarchive()) }
      : {
          label: 'Archive',
          icon: <Archive className="size-4" />,
          onSelect: fromMenu(() => (session?.state === 'working' || session?.state === 'waiting' || session?.worktree ? setArchiving(true) : void archive())),
          disabled: !session,
        },
    { label: 'End session', icon: <CircleStop className="size-4" />, onSelect: fromMenu(() => setEnding(true)), danger: true, disabled: ended },
    { label: 'Delete…', icon: <Trash2 className="size-4" />, onSelect: fromMenu(() => setDeleting(true)), danger: true, disabled: !session },
  ];

  return (
    <div className="fixed inset-x-0 top-0 h-dvh overflow-hidden bg-bg text-ink" style={pinnedToViewport(viewport)}>
      <header
        className={cn(
          'glass absolute inset-x-0 top-0 z-30 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center gap-2 border-b px-2 pt-[env(safe-area-inset-top)] sm:px-3',
          bypass ? 'border-danger/40' : 'border-ink/[0.05]',
        )}
      >
        {/* Bypass is on: the whole header is tinted until it's off. */}
        {bypass && <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-danger/10" />}
        <Link
          to="/admin/sessions"
          aria-label="Back to sessions"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
        >
          <ArrowLeft className="size-[18px]" />
        </Link>
        <div className="min-w-0 flex-1">
          {/* Tap the title to rename (FR4). */}
          <button
            type="button"
            onClick={() => setRenaming(true)}
            disabled={!session}
            title="Rename"
            className="block max-w-full truncate rounded-md text-left text-[15.5px] font-semibold hover:text-ink-soft"
          >
            {session?.title || 'Untitled'}
          </button>
          <p className="truncate text-[12px] text-muted">
            {persona && (
              <>
                <PersonaAvatar name={persona.name} avatar={persona.avatar} size="xs" showName className="inline-flex max-w-[40%] align-middle font-semibold text-ink-soft" />
                {' · '}
              </>
            )}
            <span className="font-mono">{session?.workspaceId ?? '…'}</span>
            {session?.claudeName ? ` · ${session.claudeName}` : ''}
            {session?.ticketId && (
              <>
                {' · '}
                <TicketChip ticketId={session.ticketId} compact />
              </>
            )}
            {session?.worktree && <RunChip sessionId={session.id} compact lead=" · " />}
            {session?.worktree && (
              <>
                {' · '}
                <span className="inline-flex max-w-[45%] items-center gap-1 align-bottom font-mono" title={session.worktree.path}>
                  <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{session.worktree.branch}</span>
                </span>
              </>
            )}
            {session?.endedReason === 'transferred' ? ' · left behind' : ''}
            {gone ? ' · workspace removed' : ''}
            {!connected && ' · reconnecting…'}
          </p>
        </div>
        {/* No Working badge and no Stop here: the composer's button shows a ring while Claude works and is the Stop. */}
        {session &&
          !working &&
          (endedForSafety(session.endedReason) && ended ? <Badge tone="danger">Ended</Badge> : <StateBadge state={state} />)}
        {bypass && (
          <button
            type="button"
            onClick={() => void leaveBypass()}
            aria-label="Turn off Bypass"
            title="Bypass is on: Claude runs every tool without asking. Deny rules still apply. Tap to turn it off."
            className="press inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-danger px-2.5 text-[12.5px] font-semibold text-white dark:text-bg"
          >
            <ShieldAlert className="size-3.5" aria-hidden="true" />
            Bypass
            <X className="size-3.5" aria-hidden="true" />
          </button>
        )}
        {roomy && (
          <>
            {!gone && (
              <button
                type="button"
                onClick={toggleFiles}
                aria-label="Files"
                aria-expanded={filesOpen}
                aria-controls={filesOpen ? 'files-panel' : undefined}
                title={wide ? (filesOpen ? 'Hide files' : 'Show files and changes') : 'Files and changes'}
                className={cn(
                  'press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-semibold text-muted hover:bg-surface-2 hover:text-ink',
                  filesOpen && 'bg-surface-2 text-ink',
                )}
              >
                <FolderOpen className="size-[18px]" />
                <span>Files</span>
              </button>
            )}
            <button
              type="button"
              onClick={toggleAgents}
              aria-label={agentsLabel}
              aria-expanded={agentsOpen}
              aria-controls={agentsOpen ? 'agents-panel' : undefined}
              title={wide ? (agentsOpen ? 'Hide agents' : 'Show agents') : 'Agents'}
              className={cn(
                'press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-semibold text-muted hover:bg-surface-2 hover:text-ink',
                agentsOpen && 'bg-surface-2 text-ink',
              )}
            >
              <Bot className="size-[18px]" />
              <span>Agents</span>
              {running > 0 && <RunningCount count={running} />}
            </button>
          </>
        )}
        <div ref={menuRef} className="shrink-0">
          <Menu
            label={!roomy && running ? `Session actions, ${running} ${running === 1 ? 'agent' : 'agents'} running` : 'Session actions'}
            trigger={
              <span className="relative flex">
                <MoreHorizontal className="size-[18px]" />
                {!roomy && running > 0 && <RunningCount count={running} small />}
              </span>
            }
            items={menuItems}
          />
        </div>
      </header>

      <div className="flex h-full min-h-0">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <Transcript
            sessionId={id}
            events={events}
            delta={delta}
            outbox={outbox}
            inputs={inputs}
            agentNames={agentNames}
            onCancelQueued={cancelQueued}
            details={details}
            working={working}
            padTop="calc(3.5rem + env(safe-area-inset-top) + 1.25rem)"
            padBottom={dockHeight + 12}
            onOpenUsage={() => setUsageOpen(true)}
            persona={persona}
            className="h-full"
          />

          <div ref={dock} className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
            <div
              className={cn(
                'pointer-events-auto mx-auto flex w-full max-w-[760px] flex-col gap-2 px-3 pt-2 sm:px-4',
                viewport?.keyboard ? 'pb-1.5' : 'pb-[max(0.75rem,env(safe-area-inset-bottom))]',
              )}
            >
              {current && (
                <ApprovalCard
                  request={current}
                  waiting={openRequests.length}
                  onRespond={respond}
                  disabled={!connected}
                  agentName={current.agentLabel ? agentNames.get(current.agentLabel) : null}
                />
              )}
              {gone ? (
                <GoneNote />
              ) : ended ? (
                <EndedNote reason={session?.endedReason} />
              ) : session?.switching ? (
                <MovingNote to={session.switching.toClaude} step={session.switching.step} from={session.claudeName} />
              ) : (
                <>
                  {session && <ResumeBanner session={session} connected={connected} onResume={() => trustedControl('resume')} />}
                  <Composer
                    ref={composer}
                    sessionId={id}
                    onSend={trustedSend}
                    connected={connected}
                    working={working}
                    onStop={stop}
                    accessory={
                      session && (
                        <Controls
                          ref={controls}
                          sessionId={id}
                          session={session}
                          connected={connected}
                          control={trustedControl}
                          suspended={trust.prompt !== null}
                          className="min-w-0 flex-1"
                        />
                      )
                    }
                  />
                </>
              )}
            </div>
          </div>
        </div>

        {wide && panel === 'agents' && (
          <aside id="agents-panel" aria-label="Agents" className="flex w-[360px] shrink-0 flex-col border-l border-line bg-bg pt-[calc(3.5rem+env(safe-area-inset-top))]">
            <AgentsPanel
              tasks={tasks}
              onStopTask={ended ? undefined : stopTask}
              onInterrupt={interrupt}
              connected={connected}
              onClose={toggleAgents}
              closeLabel="Hide agents"
            />
          </aside>
        )}
        {wide && !gone && panel === 'files' && (
          <aside id="files-panel" aria-label="Files" className="flex w-[360px] shrink-0 flex-col border-l border-line bg-bg pt-[calc(3.5rem+env(safe-area-inset-top))]">
            <FilesPanel key={id} sessionId={id} view={filesView} onView={setFilesView} onClose={toggleFiles} closeLabel="Hide files" />
          </aside>
        )}
      </div>

      {!wide && (
        <AgentsSheet
          open={sheet === 'agents'}
          tasks={tasks}
          onStopTask={ended ? undefined : stopTask}
          onInterrupt={interrupt}
          connected={connected}
          onClose={() => setSheet(null)}
        />
      )}
      {!wide && !gone && <FilesSheet key={id} open={sheet === 'files'} sessionId={id} view={filesView} onView={setFilesView} onClose={() => setSheet(null)} />}

      <TrustSheet trust={trust} />

      {move.element}

      <EndSessionDialog session={ending ? session : null} onClose={() => setEnding(false)} />
      <RenameSessionDialog session={renaming ? session : null} onClose={() => setRenaming(false)} />
      <DeleteSessionDialog
        session={deleting ? session : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          leaving.current = true;
          navigate('/admin/sessions', { replace: true });
        }}
      />
      <UsageDialog open={usageOpen} onClose={() => setUsageOpen(false)} events={events} session={session} />
      <ArchiveSessionDialog
        session={archiving ? session : null}
        onClose={() => setArchiving(false)}
        onArchived={() => {
          leaving.current = true;
          navigate('/admin/sessions');
        }}
      />
    </div>
  );
}

/** The session's workspace was removed: the transcript stays, and that's all. */
function GoneNote() {
  return (
    <p role="status" className="glass-card rounded-[24px] px-4 py-3 text-center text-[13.5px] text-muted">
      <span className="font-semibold text-ink">Workspace removed.</span> Read-only.
    </p>
  );
}

/** The chat is moving to another Claude: nothing is sent or queued meanwhile; the transcript shows the steps. */
function MovingNote({ to, step, from }: { to: string; step: 'handoff' | 'starting' | 'finishing'; from: string | null }) {
  return (
    <p role="status" aria-live="polite" className="glass-card flex items-center justify-center gap-2.5 rounded-full px-4 py-3 text-center text-[13.5px] text-muted">
      <Spinner className="size-4" />
      <span>
        {step === 'handoff' ? `${from ?? 'Claude'} is writing the handoff…` : step === 'starting' ? `Starting ${to}…` : `Moving to ${to}…`}
      </span>
    </p>
  );
}

/** An ended session. A safety or integrity stop says so; why is in the transcript's last error. */
function EndedNote({ reason }: { reason: string | null | undefined }) {
  const stop = endedForSafety(reason);
  return (
    <p role="status" className="glass-card rounded-full px-4 py-3 text-center text-[13.5px] text-muted">
      {stop ? <span className="font-semibold text-danger">{stop.label}</span> : 'Ended'}
    </p>
  );
}

/** How many agents are running: a green pill by Agents, or a smaller one on the ⋯ button on phones. */
function RunningCount({ count, small }: { count: number; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex items-center justify-center rounded-full bg-accent font-bold text-white tabular-nums dark:text-bg',
        small ? 'absolute -top-2 -right-2 h-4 min-w-4 px-1 text-[10px] ring-2 ring-bg' : 'h-5 min-w-5 px-1.5 text-[11px]',
      )}
    >
      {count}
    </span>
  );
}
