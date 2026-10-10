import { Button, cn, ConfirmDialog, Menu, useMediaQuery, useToast } from '@isnanme/ui';
import type { ChatRequest } from '@portal/contracts';
import { ArrowLeft, Bot, FolderOpen, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { errorText } from '@/lib/api';
import { AgentsPanel, AgentsSheet } from './AgentsPanel';
import { ApprovalCard } from './ApprovalCard';
import { Composer, type ComposerHandle } from './Composer';
import { Controls } from './Controls';
import { FilesPanel, FilesSheet, INITIAL_FILES_VIEW, type FilesView } from './FilesPanel';
import { StateBadge } from './shared';
import { Transcript } from './Transcript';
import { ResumeBanner } from './ResumeBanner';
import { useChatSession } from './useChatSocket';

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

/**
 * One session, full screen (like the shell): a header with the state and controls, the transcript,
 * the approvals dock, the session's controls and the composer pinned to the bottom. From 1280 px the
 * agents or files panel sits on the right (toggleable, one at a time); below that each opens as a
 * sheet. It owns the dedicated chat socket for as long as it's mounted.
 */
export function SessionPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const { connected, events, delta, session, inputs, outbox, tasks, send, respond, control, stop, end } = useChatSession(id);
  const [ending, setEnding] = useState(false);
  const composer = useRef<ComposerHandle>(null);

  const wide = useMediaQuery('(min-width: 1280px)');
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
    return () => void (document.title = 'portal');
  }, [session?.title]);

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

  const state = session?.state ?? 'starting';
  const working = state === 'working';
  const ended = state === 'ended';

  return (
    <div className="flex h-dvh flex-col bg-bg text-ink">
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg/90 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-md sm:px-3">
        <Link
          to="/admin/sessions"
          aria-label="Back to sessions"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
        >
          <ArrowLeft className="size-[18px]" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{session?.title || 'Untitled'}</p>
          <p className="truncate text-[11px] text-muted">
            <span className="font-mono">{session?.workspaceId ?? '…'}</span>
            {!connected && ' · reconnecting…'}
          </p>
        </div>
        {session && <StateBadge state={state} />}
        {working && (
          <Button size="sm" variant="secondary" icon={<Square className="size-3.5" />} onClick={stop}>
            <span className="hidden sm:inline">Stop</span>
          </Button>
        )}
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
          <span className="hidden sm:inline">Files</span>
        </button>
        <button
          type="button"
          onClick={toggleAgents}
          aria-label={running ? `Agents, ${running} running` : 'Agents'}
          aria-expanded={agentsOpen}
          aria-controls={agentsOpen ? 'agents-panel' : undefined}
          title={wide ? (agentsOpen ? 'Hide agents' : 'Show agents') : 'Agents'}
          className={cn(
            'press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-semibold text-muted hover:bg-surface-2 hover:text-ink',
            agentsOpen && 'bg-surface-2 text-ink',
          )}
        >
          <Bot className="size-[18px]" />
          <span className="hidden sm:inline">Agents</span>
          {running > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-bold text-white tabular-nums dark:text-bg">
              {running}
            </span>
          )}
        </button>
        <Menu
          label="Session actions"
          items={[{ label: 'End session', icon: <Trash2 className="size-4" />, onSelect: () => setEnding(true), danger: true, disabled: ended }]}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Transcript
            sessionId={id}
            events={events}
            delta={delta}
            outbox={outbox}
            inputs={inputs}
            agentNames={agentNames}
            onCancelQueued={cancelQueued}
            className="min-h-0 flex-1"
          />

          <div className="shrink-0 border-t border-line bg-bg">
            <div className="mx-auto w-full max-w-[760px] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {current && (
                <ApprovalCard
                  request={current}
                  waiting={openRequests.length}
                  onRespond={respond}
                  disabled={!connected}
                  agentName={current.agentLabel ? agentNames.get(current.agentLabel) : null}
                />
              )}
              {ended ? (
                <p className="py-2 text-center text-[13px] text-muted">This session has ended.</p>
              ) : (
                <>
                  {session && <ResumeBanner session={session} connected={connected} onResume={() => control('resume')} />}
                  {session && <Controls sessionId={id} session={session} connected={connected} control={control} className="mb-2" />}
                  <Composer ref={composer} onSend={send} connected={connected} working={working} />
                </>
              )}
            </div>
          </div>
        </div>

        {wide && panel === 'agents' && (
          <aside id="agents-panel" aria-label="Agents" className="flex w-[360px] shrink-0 flex-col border-l border-line bg-bg">
            <AgentsPanel tasks={tasks} onClose={toggleAgents} closeLabel="Hide agents" />
          </aside>
        )}
        {wide && panel === 'files' && (
          <aside id="files-panel" aria-label="Files" className="flex w-[360px] shrink-0 flex-col border-l border-line bg-bg">
            <FilesPanel key={id} sessionId={id} view={filesView} onView={setFilesView} onClose={toggleFiles} closeLabel="Hide files" />
          </aside>
        )}
      </div>

      {!wide && <AgentsSheet open={sheet === 'agents'} tasks={tasks} onClose={() => setSheet(null)} />}
      {!wide && <FilesSheet key={id} open={sheet === 'files'} sessionId={id} view={filesView} onView={setFilesView} onClose={() => setSheet(null)} />}

      <ConfirmDialog
        open={ending}
        title="End this session?"
        description="The chat is closed and Claude Code stops working on it. The transcript stays for your records."
        confirmLabel="End session"
        onConfirm={() => {
          end();
          setEnding(false);
        }}
        onClose={() => setEnding(false)}
      />
    </div>
  );
}
