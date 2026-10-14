import { Badge, cn, ConfirmDialog, Menu, Spinner, useMediaQuery, useToast, type MenuItem } from '@isnanme/ui';
import type { ChatRequest, ChatSession } from '@portal/contracts';
import { Archive, ArchiveRestore, ArrowLeft, Bell, BellOff, Bot, CircleStop, FolderOpen, Gauge, Info, ListCollapse, ListTree, MoreHorizontal, Pencil, PanelRight, PanelRightClose, Pin, PinOff, RotateCw, ShieldAlert, Trash2, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { BRAND_NAME } from '@/components/Logo';
import { useNotifyWhenDone } from '@/features/notify/sessionFlag';
import { usePersonaOf } from '@/features/personas/identities';
import { errorText } from '@/lib/api';
import { pinnedToViewport, useVisualViewport } from '@/lib/viewport';
import { AgentsPanel, AgentsSheet } from './AgentsPanel';
import { chatApi } from './api';
import { DividerMark } from '@/features/autotransfer/DividerMark';
import { undoFor } from '@/features/autotransfer/pure';
import { useAutoMoveMenu } from '@/features/autotransfer/SessionMenuItem';
import { SuggestionCard } from '@/features/autotransfer/SuggestionCard';
import { useAutoMove } from '@/features/autotransfer/useAutoMove';
import { useGlanceFocus } from '@/features/glance/focus';
import { GlanceStrip } from '@/features/glance/Strip';
import { ApprovalBar, ApprovalCard } from './ApprovalCard';
import { BtwCard } from './btw/BtwCard';
import { BtwSheet } from './btw/BtwSheet';
import { BtwSidePanel } from './btw/BtwSidePanel';
import { useBtwLayout } from './btw/layout';
import { Composer, type ComposerHandle } from './Composer';
import { Controls, type ControlsHandle } from './Controls';
import { FilesPanel, FilesSheet, INITIAL_FILES_VIEW, type FilesView } from './FilesPanel';
import { KeepGoingChip } from './KeepGoing';
import { SessionInfoDialog } from './SessionInfo';
import { endedForSafety, StateBadge } from './shared';
import { Transcript } from './Transcript';
import { RecoverButton } from './Recover';
import { ResumeBanner } from './ResumeBanner';
import { ArchiveSessionDialog, DeleteSessionDialog, EndSessionDialog, RenameSessionDialog } from './SessionDialogs';
import { useMoveChat } from './SwitchDialog';
import { RestartChip, useRestart } from './Restart';
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
  const { connected, events, delta, agentLive, session, removed, inputs, outbox, tasks, btw, btwAsk, btwCancel, btwClose, btwPin, send, respond, control, stop, end } = useChatSession(id);
  // The glance widgets follow this session: Quota shows its Claude.
  useGlanceFocus({ sessionId: id, claudeId: session?.claudeId, workspaceId: session?.workspaceId });
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
  const [infoOpen, setInfoOpen] = useState(false);
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
  /** Pin (FR2): the session leads its group in the list and the Pinned chip lists it. */
  const togglePin = async () => {
    try {
      if (session?.pinnedAt) {
        await chatApi.unpin(id);
        toast('Unpinned');
      } else {
        await chatApi.pin(id);
        toast('Pinned');
      }
    } catch (e) {
      toast(errorText(e, 'Could not change the pin.'), 'error');
    }
  };
  const composer = useRef<ComposerHandle>(null);
  // btw: the card above the composer (or the side panel on a wide desktop, or the phone's sheet). Focus goes to it when this tab asks, and back to the composer when it closes.
  const row = useRef<HTMLDivElement>(null);
  const btwLayout = useBtwLayout(row);
  const btwEl = useRef<HTMLElement>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const focusBtw = useRef(false);
  const askBtw = useCallback(
    (q: string) => {
      focusBtw.current = true;
      btwAsk(q);
    },
    [btwAsk],
  );
  useEffect(() => {
    if (!btw || !focusBtw.current) return;
    focusBtw.current = false;
    requestAnimationFrame(() => btwEl.current?.focus({ preventScroll: true }));
  }, [btw?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeBtw = useCallback(() => {
    btwClose();
    composer.current?.focus();
  }, [btwClose]);
  const pinBtw = () => {
    if (!btw) return;
    setPinned(btw.id);
    btwPin().catch((e: unknown) => {
      setPinned(null);
      toast(errorText(e, 'Could not pin it.'), 'error');
    });
  };
  const btwCard = (variant: 'card' | 'panel' | 'sheet', extra?: ReactNode) =>
    btw && (
      <BtwCard
        ref={btwEl}
        btw={btw}
        variant={variant}
        pinned={btw.pinnedSeq !== undefined || pinned === btw.id}
        onClose={closeBtw}
        onAskAgain={() => askBtw(btw.question)}
        onCancel={btwCancel}
        onPin={pinBtw}
        extra={extra}
      />
    );
  const controls = useRef<ControlsHandle>(null);
  // The page follows the visible area, so the header stays put when the keyboard opens (iOS scrolls the
  // page instead of resizing it); the transcript scrolls under the glass header and dock.
  // A focused composer on a phone means the keyboard: the dock drops its safe-area gap at once.
  const viewport = useVisualViewport({ keyboardOnFocus: true });
  // The keyboard up on a short screen (a phone on its side: under 320 px left to see): the composer (and an approval's bar) need all of
  // it, so the header steps aside until the keyboard goes down.
  const cramped = !!viewport?.keyboard && viewport.height < CRAMPED_PX;
  // A short screen (under 500 px to see, a phone on its side; Web app §9.1): the glance strip steps aside and an approval waits as a bar,
  // so the transcript keeps its quarter.
  const short = !!viewport && viewport.height < SHORT_PX;
  const dock = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(0);
  // The composer and its notes, at the bottom of the dock: the phone's btw sheet sits on them (over an approval, if one waits, so the
  // sheet keeps its room on a short screen; the header's state says one waits).
  const base = useRef<HTMLDivElement>(null);
  const [baseHeight, setBaseHeight] = useState(0);
  useLayoutEffect(() => {
    const el = dock.current;
    if (!el) return;
    const measure = () => {
      setDockHeight(el.offsetHeight);
      setBaseHeight(base.current ? el.offsetHeight - base.current.offsetTop : el.offsetHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (base.current) observer.observe(base.current);
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
  const toggleAgents = () => {
    setAgentOpen(null); // the panel opens on its list
    toggle('agents');
  };
  // The sub-agent whose detail view is open in the Agents panel or sheet; its row in the transcript opens it.
  const [agentOpen, setAgentOpen] = useState<string | null>(null);
  const openAgent = useCallback(
    (taskId: string) => {
      setAgentOpen(taskId);
      if (wide) {
        if (panel !== 'agents') setPanel('agents');
      } else setSheet('agents');
    },
    [wide, panel],
  );
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

  // Auto move (auto-transfer PRD): the card of `ask` mode, the "auto" mark and Undo on a "Moved to" divider, and the chat's own mode.
  const auto = useAutoMove(id, session?.claudeId);
  const moveMark = useCallback(
    (handoffId: string) => {
      const event = auto.marks.get(handoffId);
      if (!event) return null;
      // Undo is the normal Move dialog with the Claude the chat left chosen (FR19).
      return <DividerMark event={event} undo={undoFor(auto.state?.lastMove ?? null, handoffId)} onUndo={(claudeId) => session && move.start(session, claudeId)} />;
    },
    [auto.marks, auto.state?.lastMove, session, move],
  );

  // Open requests: a `request` with no later `resolved`, oldest first (events are seq-ordered).
  const openRequests = useMemo(() => {
    const resolved = new Set<string>();
    for (const e of events) if (e.kind === 'resolved' && e.requestId) resolved.add(e.requestId);
    const open: ChatRequest[] = [];
    for (const e of events) if (e.kind === 'request' && e.request && !resolved.has(e.request.requestId)) open.push(e.request);
    return open;
  }, [events]);
  const current = openRequests[0] ?? null;
  // The approval as a bar (the keyboard up, or a short screen) until Review: that puts the keyboard away and opens the card. The next
  // request, or the keyboard coming back, starts as a bar again.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const keyboardUp = !!viewport?.keyboard;
  useEffect(() => {
    if (keyboardUp) setReviewing(null);
  }, [keyboardUp]);
  const approvalBar = !!current && (keyboardUp || short) && reviewing !== current.requestId;

  // Sub-agent lines carry the `Task` tool_use id as their label; people read the task's description.
  const agentNames = useMemo(
    () => new Map(tasks.flatMap((t) => (t.toolUseId ? [[t.toolUseId, t.description || t.subagentType || 'Agent'] as const] : []))),
    [tasks],
  );
  const running = tasks.filter((t) => t.status === 'running').length;
  const restart = useRestart(session, tasks);

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
  // The main turn runs (Stop, the live line); a session working only through its tasks takes a message as an idle one does (T-41).
  const working = state === 'working' && !session?.tasksOnly;
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
  const notifyDone = useNotifyWhenDone(id);
  const autoMenu = useAutoMoveMenu(id, auto.state, auto.platformMode, auto.setState, gone || ended);
  const menuItems: MenuItem[] = [
    // Bypass is one tap to leave (FR20): the header's red shield, and first here.
    ...(bypass ? [{ label: 'Turn off Bypass', icon: <ShieldAlert className="size-4" />, onSelect: fromMenu(() => void leaveBypass()), danger: true }] : []),
    { label: 'Info', icon: <Info className="size-4" />, onSelect: fromMenu(() => setInfoOpen(true)), disabled: !session },
    ...(roomy
      ? []
      : [
          ...(gone ? [] : [{ label: 'Files and changes', icon: <FolderOpen className="size-4" />, onSelect: fromMenu(toggleFiles) }]),
          { label: running ? `Agents · ${running} running` : 'Agents', icon: <Bot className="size-4" />, onSelect: fromMenu(toggleAgents) },
        ]),
    { label: 'Rename…', icon: <Pencil className="size-4" />, onSelect: fromMenu(() => setRenaming(true)), disabled: !session },
    { label: 'Usage', icon: <Gauge className="size-4" />, onSelect: fromMenu(() => setUsageOpen(true)) },
    { label: notifyDone.done ? 'Don\u2019t notify when done' : 'Notify when done', icon: notifyDone.done ? <BellOff className="size-4" /> : <Bell className="size-4" />, onSelect: fromMenu(notifyDone.toggle), disabled: !session || ended },
    details
      ? { label: 'Show less', icon: <ListCollapse className="size-4" />, onSelect: fromMenu(toggleDetails) }
      : { label: 'Show all details', icon: <ListTree className="size-4" />, onSelect: fromMenu(toggleDetails) },
    {
      label: 'Restart',
      icon: <RotateCw className="size-4" />,
      onSelect: fromMenu(() => restart.start('manual')),
      // T-102: never disabled for a running turn: the sheet offers Restart after this turn, or now behind a confirmation.
      disabled: gone || ended || !!session?.switching || restart.busy,
    },
    {
      label: 'Move to another Claude…',
      icon: <Bot className="size-4" />,
      onSelect: fromMenu(openSwitch),
      disabled: gone || ended || !!session?.switching,
    },
    ...(autoMenu.item ? [{ ...autoMenu.item, onSelect: fromMenu(autoMenu.item.onSelect) }] : []),
    session?.pinnedAt
      ? { label: 'Unpin', icon: <PinOff className="size-4" />, onSelect: fromMenu(() => void togglePin()) }
      : { label: 'Pin', icon: <Pin className="size-4" />, onSelect: fromMenu(() => void togglePin()), disabled: !session || !!session.archivedAt },
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
    // touch-action: pinch-zoom: a drag that starts on the header, the card or the composer pans nothing (it used to scroll the page behind and drag this
    // whole screen with it); the transcript and the panels are their own scrollers and keep scrolling. overflow: clip, not hidden: a hidden
    // box can still be scrolled by a focus(), which shifted the whole screen up under a landscape keyboard (tools/qa/session-states.mjs).
    <div
      className="fixed inset-x-0 top-0 h-dvh overflow-clip bg-bg text-ink [touch-action:pinch-zoom]"
      style={{ ...pinnedToViewport(viewport), ...(cramped ? ({ '--session-header-bottom': 'var(--bar-top)' } as CSSProperties) : null) }}
    >

      <div ref={row} className="flex h-full min-h-0">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/*
            The floating header (chat PRD §12.3): a frosted bar in the composer's style, inset from the edges by the same gap (index.css
            --bar-*), under the status bar; the transcript scrolls under it, and under the status bar's own band. Back, the title (tap:
            Session info), the state, ⋯; Bypass adds its red shield. Everything else is in ⋯.
          */}
          <div hidden={cramped} className="pointer-events-none absolute inset-x-0 top-0 z-30 pt-[var(--bar-top)] pr-[var(--bar-right)] pl-[var(--bar-left)]">
            {/* What scrolls under the header blurs and fades out below it (T-102): no hard edge, no darker band under the pill. */}
            <div aria-hidden="true" data-header-fade="" className="session-fade pointer-events-none absolute inset-x-0 top-0 -z-10 h-[calc(var(--session-header-bottom)+2.75rem)]" />
            <header
              data-session-header=""
              data-popover-ceiling=""
              className={cn(
                // No drop shadow (T-102): over the fade it read as a darker band under the pill; the border draws its edge.
                'glass-card pointer-events-auto relative isolate mx-auto flex h-[52px] max-w-[760px] items-center gap-1 rounded-full p-1 shadow-none!',
                bypass && 'border-danger/50',
              )}
            >
              {/* Bypass is on: the whole bar is tinted until it's off. */}
              {bypass && <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-danger/10" />}
              <Link
                to="/admin/sessions"
                aria-label="Back to sessions"
                className="press flex size-11 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-ink/[0.07] hover:text-ink"
              >
                <ArrowLeft className="size-[18px]" />
              </Link>
              <button
                type="button"
                onClick={() => setInfoOpen(true)}
                disabled={!session}
                aria-haspopup="dialog"
                aria-label={`${session?.title || 'Untitled'}, session info`}
                className="press flex h-11 min-w-0 flex-1 items-center rounded-full px-1.5 text-left"
              >
                <span className="truncate text-[15.5px] font-semibold text-ink">{session?.title || 'Untitled'}</span>
              </button>
              {/* The state, always in this one slot: Reconnecting while the link is down. */}
              <span className="flex shrink-0 items-center">
                {!connected ? (
                  <Badge tone="neutral">
                    <Spinner className="size-3" />
                    <span className="sr-only sm:not-sr-only">Reconnecting</span>
                  </Badge>
                ) : session && working ? (
                  // Working: on phones the spinner alone (the composer's Stop ring says it too), the title keeps its room.
                  <>
                    <span role="img" aria-label="Working" className="flex size-8 items-center justify-center text-accent sm:hidden">
                      <Spinner className="size-4" />
                    </span>
                    <span className="hidden sm:flex">
                      <StateBadge state={state} agents={running} />
                    </span>
                  </>
                ) : session ? (
                  endedForSafety(session.endedReason) && ended ? <Badge tone="danger">Ended</Badge> : <StateBadge state={state} agents={running} />
                ) : null}
              </span>
              <KeepGoingChip session={session} onOpen={() => setInfoOpen(true)} />
              {bypass && (
                <button
                  type="button"
                  onClick={() => void leaveBypass()}
                  aria-label="Bypass is on. Turn it off"
                  title="Bypass is on: Claude runs every tool without asking. Deny rules still apply. Tap to turn it off."
                  className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-danger hover:bg-danger-soft sm:w-auto sm:hover:bg-transparent"
                >
                  {/* From 640 px the red pill is 36 px high inside a 44 px target. */}
                  <span className="inline-flex items-center gap-1 sm:h-9 sm:rounded-full sm:bg-danger sm:px-2.5 sm:text-[12.5px] sm:font-semibold sm:text-white sm:dark:text-bg">
                    <ShieldAlert className="size-[18px] sm:size-3.5" aria-hidden="true" />
                    <span className="hidden sm:inline">Bypass</span>
                    <X className="hidden size-3.5 sm:block" aria-hidden="true" />
                  </span>
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
                        'press relative inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-ink/[0.07] hover:text-ink',
                        filesOpen && 'bg-ink/[0.07] text-ink',
                      )}
                    >
                      <FolderOpen className="size-[18px]" />
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
                      'press relative inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-ink/[0.07] hover:text-ink',
                      agentsOpen && 'bg-ink/[0.07] text-ink',
                    )}
                  >
                    <Bot className="size-[18px]" />
                    {running > 0 && <RunningCount count={running} />}
                    {/* Agents still at work: a small spinner on the icon, also once the main agent is idle. */}
                    {running > 0 && (
                      <span aria-hidden="true" className="absolute bottom-1.5 left-1.5 flex rounded-full bg-bg text-accent">
                        <Spinner className="size-3" />
                      </span>
                    )}
                  </button>
                </>
              )}
              {/* The kit's ⋯ is 36 px; on this bar every target is 44 (and its items too, for a thumb). */}
              <div ref={menuRef} className="shrink-0 [&_[aria-haspopup=menu]]:size-11 [&_[role=menuitem]]:min-h-11">
                <Menu
                  label={!roomy && running ? `Session actions, ${running} ${running === 1 ? 'agent' : 'agents'} running` : 'Session actions'}
                  trigger={
                    // The count sits at the corner of the 44 px button, clear of the dots (T-102: '14' used to cover them).
                    <span className="relative flex size-11 items-center justify-center">
                      <MoreHorizontal className="size-[18px]" data-menu-glyph="" />
                      {!roomy && running > 0 && <RunningCount count={running} />}
                    </span>
                  }
                  items={menuItems}
                />
              </div>
            </header>
          </div>

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
            padTop="calc(var(--session-header-bottom) + 1rem)"
            padBottom={dockHeight + 12}
            onOpenUsage={() => setUsageOpen(true)}
            persona={persona}
            moveMark={moveMark}
            tasks={tasks}
            agentLive={agentLive}
            onOpenAgent={openAgent}
            className="h-full"
          />

          {/*
            The composer floats the same gap from the left, right and bottom edges of the screen, keyboard up or down (index.css --bar-*).
            What stacks above it leaves the transcript a quarter of the screen below the header (chat PRD, Dock): the stack is capped, and
            an approval's text and a btw answer are what give way (each scrolls in a shorter block); anything that still does not fit leaves
            at the top, never the composer at the bottom.
          */}
          <div
            ref={dock}
            data-session-dock=""
            className={cn(
              'pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col justify-end pr-[var(--bar-right)] pb-[var(--bar-gap)] pl-[var(--bar-left)]',
              // Review on a short screen asked for the whole card: then the stack may take everything below the header.
              current && short && !approvalBar ? 'max-h-[calc(100%-var(--session-header-bottom)-0.25rem)]' : 'max-h-[calc(75%-var(--session-header-bottom))]',
            )}
          >
            <div className="pointer-events-auto mx-auto flex min-h-0 w-full max-w-[760px] flex-col justify-end gap-2 pt-2">
              {/* The oldest open request: the card, at most 45 % of what is visible; with the keyboard up or on a short screen, a bar whose Review opens it (chat PRD, Dock). */}
              {current && approvalBar ? (
                <ApprovalBar
                  request={current}
                  waiting={openRequests.length}
                  onReview={() => {
                    (document.activeElement as HTMLElement | null)?.blur();
                    setReviewing(current.requestId);
                  }}
                />
              ) : current ? (
                <ApprovalCard
                  className="min-h-0"
                  style={viewport ? { maxHeight: Math.floor(viewport.height * 0.45) } : undefined}
                  request={current}
                  waiting={openRequests.length}
                  onRespond={respond}
                  disabled={!connected}
                  agentName={current.agentLabel ? agentNames.get(current.agentLabel) : null}
                />
              ) : null}
              {auto.state?.pending && !gone && !ended && !session?.switching && (
                <SuggestionCard state={auto.state} allowAuto={auto.allowAuto} bypass={bypass} disabled={!connected} onChange={auto.setState} />
              )}
              {btw && btwLayout.mode === 'card' &&
                btwCard(
                  'card',
                  btwLayout.canSide && (
                    <button
                      type="button"
                      aria-label="Open in side panel"
                      title="Open in side panel"
                      onClick={() => btwLayout.setSide(true)}
                      className="press inline-flex size-9 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-surface-2 hover:text-ink tap:size-11"
                    >
                      <PanelRight className="size-[18px]" aria-hidden="true" />
                    </button>
                  ),
                )}
              {!viewport?.keyboard && !short && <GlanceStrip placement="composer" side="above" dense className="justify-end" />}
              <div ref={base} className="flex flex-col gap-2">
                {gone ? (
                  <GoneNote />
                ) : ended ? (
                  <EndedNote session={session} />
                ) : session?.switching ? (
                  <MovingNote to={session.switching.toClaude} step={session.switching.step} from={session.claudeName} />
                ) : (
                  <>
                    {session && <ResumeBanner session={session} connected={connected} onResume={() => trustedControl('resume')} />}
                    {session && !gone && (
                      <RestartChip hint={restart.hint} anchor={restart.anchor} onOpen={() => restart.start('mcp')} onCancel={() => void restart.actions.cancel()} onNow={restart.actions.now} />
                    )}
                    <Composer
                      ref={composer}
                      sessionId={id}
                      onSend={trustedSend}
                      connected={connected}
                      working={working}
                      onStop={stop}
                      onBtw={askBtw}
                      btwBusy={btw?.status === 'running'}
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
          {btw && btwLayout.mode === 'sheet' && (
            <BtwSheet bottom={baseHeight + 8} keyboard={!!viewport?.keyboard} onClose={closeBtw}>
              {btwCard('sheet')}
            </BtwSheet>
          )}
        </div>

        {btw && btwLayout.mode === 'panel' && (
          <BtwSidePanel width={btwLayout.width} maxWidth={btwLayout.maxWidth} onResize={btwLayout.setWidth}>
            {btwCard(
              'panel',
              <button
                type="button"
                aria-label="Back to card"
                title="Back to card"
                onClick={() => btwLayout.setSide(false)}
                className="press inline-flex size-9 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-surface-2 hover:text-ink tap:size-11"
              >
                <PanelRightClose className="size-[18px]" aria-hidden="true" />
              </button>,
            )}
          </BtwSidePanel>
        )}
        {wide && panel === 'agents' && btwLayout.mode !== 'panel' && (
          <aside id="agents-panel" aria-label="Agents" className="flex w-[360px] shrink-0 flex-col border-l border-line bg-bg pt-[var(--safe-top)]">
            <AgentsPanel
              sessionId={id}
              tasks={tasks}
              agentLive={agentLive}
              selected={agentOpen}
              onSelect={setAgentOpen}
              onStopTask={ended ? undefined : stopTask}
              onInterrupt={interrupt}
              connected={connected}
              onClose={toggleAgents}
              closeLabel="Hide agents"
            />
          </aside>
        )}
        {wide && !gone && panel === 'files' && btwLayout.mode !== 'panel' && (
          <aside id="files-panel" aria-label="Files" className="flex w-[360px] shrink-0 flex-col border-l border-line bg-bg pt-[var(--safe-top)]">
            <FilesPanel key={id} sessionId={id} view={filesView} onView={setFilesView} onClose={toggleFiles} closeLabel="Hide files" />
          </aside>
        )}
      </div>

      {!wide && (
        <AgentsSheet
          open={sheet === 'agents'}
          sessionId={id}
          tasks={tasks}
          agentLive={agentLive}
          selected={agentOpen}
          onSelect={setAgentOpen}
          onStopTask={ended ? undefined : stopTask}
          onInterrupt={interrupt}
          connected={connected}
          onClose={() => setSheet(null)}
        />
      )}
      {!wide && !gone && <FilesSheet key={id} open={sheet === 'files'} sessionId={id} view={filesView} onView={setFilesView} onClose={() => setSheet(null)} />}

      <TrustSheet trust={trust} />

      {move.element}
      {autoMenu.element}
      {restart.element}

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
      <SessionInfoDialog
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        session={session}
        persona={persona}
        gone={gone}
        connected={connected}
        onRename={() => {
          setInfoOpen(false);
          setRenaming(true);
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

/** Below this visible height with the keyboard up, the session screen is cramped (see `cramped`). */
const CRAMPED_PX = 320;
/** Below this visible height the screen is short (see `short`): the same 500 px as the short-touch layout (Web app §9.1). */
const SHORT_PX = 500;

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

/**
 * An ended session. A safety or integrity stop says so; why is in the transcript's last error. One ended for integrity offers Resume (T-136):
 * it comes back in place, the same chat.
 */
function EndedNote({ session }: { session: ChatSession | null | undefined }) {
  const stop = endedForSafety(session?.endedReason);
  const resumable = session?.state === 'ended' && !!session.endedFor;
  return (
    <div role="status" className={cn('glass-card flex items-center justify-center gap-2 rounded-full py-1 text-center text-[13.5px] text-muted', resumable ? 'pr-1.5 pl-4' : 'px-4 py-3')}>
      <span className="min-w-0 break-words">{stop ? <span className="font-semibold text-danger">{stop.label}</span> : 'Ended'}</span>
      {resumable && session && <RecoverButton session={session} />}
    </div>
  );
}

/**
 * How many agents are running: on the corner of its own 44 px button (Agents, or ⋯ on phones), inside the button's width and clear of its
 * glyph, so it covers neither the glyph nor the neighbouring button (T-102: '14' used to sit on ⋯).
 */
function RunningCount({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      data-running-count=""
      className="absolute -top-1 right-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white tabular-nums ring-2 ring-bg dark:text-bg"
    >
      {count}
    </span>
  );
}
