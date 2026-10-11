import { Badge, Button, ConfirmDialog, EmptyState, LoadError, Menu, RowsSkeleton, useToast } from '@isnanme/ui';
import type { ChatSession } from '@portal/contracts';
import { MessageSquare, MessagesSquare, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { errorText } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { chatApi } from './api';
import { NewSessionDialog } from './NewSessionDialog';
import { endedForSafety, formatUsd, StateBadge } from './shared';
import { useChatList } from './useChatSocket';

export function SessionsPage() {
  const toast = useToast();
  const { sessions, failed, reload } = useChatList();
  const [creating, setCreating] = useState(false);
  const [ending, setEnding] = useState<ChatSession | null>(null);
  const [endBusy, setEndBusy] = useState(false);

  // Attention first (anything waiting on you), then by most recent activity.
  const sorted = useMemo(
    () =>
      sessions
        ? [...sessions].sort((a, b) => {
            const wait = (a.waiting > 0 ? 0 : 1) - (b.waiting > 0 ? 0 : 1);
            return wait || new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
          })
        : null,
    [sessions],
  );

  const endSession = async () => {
    if (!ending) return;
    setEndBusy(true);
    try {
      await chatApi.end(ending.id);
      toast('Session ended');
      setEnding(null);
      await reload();
    } catch (e) {
      toast(errorText(e, 'Could not end it.'), 'error');
    } finally {
      setEndBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Chat with the Claude Code agents in your workspaces."
        action={
          sorted &&
          sorted.length > 0 && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              <span className="hidden sm:inline">New session</span>
              <span className="sm:hidden">New</span>
            </Button>
          )
        }
      />

      {failed && !sorted && <LoadError onRetry={reload} />}
      {!sorted && !failed && <RowsSkeleton rows={3} lines={1} trailing icon="rounded-2xl" />}

      {sorted &&
        (sorted.length === 0 ? (
          <EmptyState
            icon={<MessagesSquare className="size-6" />}
            title="No sessions yet"
            action={
              <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                New session
              </Button>
            }
          >
            Start a session to chat with Claude Code in one of your running workspaces.
          </EmptyState>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {sorted.map((s) => (
                <SessionRow key={s.id} session={s} onEnd={() => setEnding(s)} />
              ))}
            </ul>
          </Card>
        ))}

      <NewSessionDialog open={creating} onClose={() => setCreating(false)} />
      <ConfirmDialog
        open={!!ending}
        title={`End ${ending?.title || 'this session'}?`}
        description="The chat is closed and Claude Code stops working on it. The transcript stays for your records."
        confirmLabel="End session"
        loading={endBusy}
        onConfirm={() => void endSession()}
        onClose={() => !endBusy && setEnding(null)}
      />
    </>
  );
}

function SessionRow({ session: s, onEnd }: { session: ChatSession; onEnd: () => void }) {
  const title = s.title || 'Untitled';
  const active = s.state === 'working' || s.state === 'waiting';
  const safety = s.state === 'ended' ? endedForSafety(s.endedReason) : null;
  return (
    <li className="flex items-center gap-3 p-4 sm:px-5">
      <Link to={`/admin/sessions/${s.id}`} className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-soft'}`}
        >
          <MessageSquare className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate font-semibold">{title}</p>
            {safety ? <Badge tone="danger">{safety.label}</Badge> : <StateBadge state={s.state} />}
            {s.waiting > 0 && <Badge tone="warning">{s.waiting === 1 ? 'Needs you' : `${s.waiting} waiting`}</Badge>}
          </div>
          <p className="mt-0.5 truncate text-[13px] text-muted">
            <span className="font-mono">{s.workspaceId}</span>
            {s.costUsd > 0 && ` · ${formatUsd(s.costUsd)}`}
            {' · '}
            <span title={formatDateTime(s.lastActivityAt)}>{timeAgo(s.lastActivityAt)}</span>
          </p>
        </div>
      </Link>
      <Menu label={`Actions for ${title}`} items={[{ label: 'End session', icon: <Trash2 className="size-4" />, onSelect: onEnd, danger: true }]} />
    </li>
  );
}
