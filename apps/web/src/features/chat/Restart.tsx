import { Button, ConfirmDialog, useToast } from '@isnanme/ui';
import type { ChatSession, ChatTask } from '@portal/contracts';
import { RotateCw } from 'lucide-react';
import { useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { chatApi } from './api';

/** Whether a Restart can be asked now: at a turn boundary, nothing waiting, not moving or already restarting. */
export function canRestart(session: ChatSession | null | undefined): boolean {
  return !!session && session.state !== 'ended' && session.state !== 'working' && session.state !== 'waiting' && !session.switching && !session.restarting;
}

/**
 * Restart (chat PRD, Restart): Claude Code starts again on the same conversation, so MCP servers delivered since connect. One tap when
 * nothing would be lost; running agents (they stop with the old process) are named in a confirmation first.
 */
export function useRestart(session: ChatSession | null | undefined, tasks: ChatTask[]) {
  const toast = useToast();
  const [asking, setAsking] = useState<'mcp' | 'manual' | null>(null);
  const [busy, setBusy] = useState(false);
  const running = tasks.filter((t) => t.status === 'running');

  const run = async (why: 'mcp' | 'manual') => {
    if (!session) return;
    setBusy(true);
    try {
      await chatApi.restart(session.id, why);
      setAsking(null);
    } catch (e) {
      setAsking(null);
      toast(errorText(e, 'Couldn’t restart it.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const start = (why: 'mcp' | 'manual') => {
    if (!canRestart(session) || busy) return;
    if (running.length) setAsking(why);
    else void run(why);
  };

  const names = running.map((t) => t.description || t.subagentType || 'Agent');
  const element = (
    <ConfirmDialog
      open={asking !== null}
      title="Restart?"
      description={`Stops ${names.length === 1 ? names[0] : `${names.length} agents: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`}.`}
      confirmLabel="Restart"
      loading={busy}
      onConfirm={() => asking && void run(asking)}
      onClose={() => !busy && setAsking(null)}
    />
  );
  return { start, element, busy: busy || !!session?.restarting };
}

/** Something was delivered after this session's process started (`configChangedAt`): one tap restarts it to load it. */
export function RestartChip({ session, busy, onRestart }: { session: ChatSession; busy: boolean; onRestart: () => void }) {
  if (!session.configChangedAt || session.state === 'ended' || session.switching) return null;
  const ready = canRestart(session);
  return (
    <div role="status" className="glass-card flex items-center gap-2 self-center rounded-full py-1 pr-1 pl-3.5 text-[13px] text-ink-soft">
      <span className="font-semibold">Tools changed</span>
      <InfoTip label="About tools changed">
        MCP servers or settings arrived after this session started. Restart loads them; the conversation stays.
        {!ready && ' Available when the turn ends.'}
      </InfoTip>
      <Button size="sm" variant="secondary" icon={<RotateCw className="size-4" />} loading={busy} disabled={!ready} onClick={onRestart}>
        Restart
      </Button>
    </div>
  );
}
