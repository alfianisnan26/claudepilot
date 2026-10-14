import { ConfirmDialog, Spinner, useToast } from '@isnanme/ui';
import { CHAT_RECOVER_CONFIRM, type ChatSession } from '@portal/contracts';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { ApiError, errorText } from '@/lib/api';
import { chatApi } from './api';

/**
 * Resume for a session ended for integrity (T-136, D-30): it comes back IN PLACE, the same row and conversation. A harmless cause resumes in
 * one tap; a suspicious one opens a sheet first with where the line came from and how the portal classified it. 44 px, icon-only on phones.
 */
export function RecoverButton({ session, onDone }: { session: ChatSession; onDone?: (s: ChatSession) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ended = session.endedFor;
  if (session.state !== 'ended' || !ended) return null;
  const suspicious = ended.classified === 'suspicious';

  const run = async (confirm: boolean) => {
    setBusy(true);
    try {
      const back = await chatApi.recover(session.id, confirm ? { confirm: true } : {});
      setConfirming(false);
      onDone?.(back);
    } catch (e) {
      // The classification changed since the page loaded: ask first.
      if (e instanceof ApiError && e.code === CHAT_RECOVER_CONFIRM) setConfirming(true);
      else toast(errorText(e, 'Couldn’t resume it.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span className="flex shrink-0 items-center" data-recover="">
        <button
          type="button"
          aria-label="Resume"
          disabled={busy}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (suspicious) setConfirming(true);
            else void run(false);
          }}
          className="press flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-full px-2.5 text-[13.5px] font-semibold text-primary hover:bg-surface-2 disabled:opacity-60 sm:px-3.5"
        >
          {busy ? <Spinner className="size-[18px]" /> : <RotateCcw className="size-[18px]" aria-hidden="true" />}
          <span className="hidden sm:inline">Resume</span>
        </button>
        <InfoTip label="About Resume">
          {suspicious
            ? `Brings this session back as it was: same chat, same conversation. The line that ended it looks suspicious (${ended.origin}), so you confirm first.`
            : 'Brings this session back as it was: same chat, conversation, tags and cost. The line that ended it is not read again.'}
        </InfoTip>
      </span>
      <ConfirmDialog
        open={confirming}
        title="Resume this session?"
        tone="danger"
        description={
          <span className="block space-y-2 break-words [overflow-wrap:anywhere]">
            <span className="block">It ended because {ended.reason}.</span>
            <span className="block">
              Origin: <span className="font-semibold">{ended.origin}</span>. The portal classified it as <span className="font-semibold">{ended.classified}</span>.
            </span>
            <span className="block">Claude Code resumes the same conversation. Only resume it if you know where that line came from.</span>
          </span>
        }
        confirmLabel="Resume"
        loading={busy}
        onConfirm={() => void run(true)}
        onClose={() => !busy && setConfirming(false)}
      />
    </>
  );
}
