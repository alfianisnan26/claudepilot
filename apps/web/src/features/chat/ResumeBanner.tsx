import { Button, useToast } from '@isnanme/ui';
import type { ChatSession } from '@portal/contracts';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorText } from '@/lib/api';
import { isIneligible } from './shared';
import { isTrustDeclined } from './TrustSheet';

/**
 * A session whose Claude Code process is gone (Interrupted) or asleep after idling: say so (and why it
 * stopped, when the portal knows), and offer Resume. Sending a message resumes it too; this makes it
 * explicit and lets you check it first. A resume refused because the workspace has no account pool ready
 * says why, with the way to Workspaces to fix it.
 */
export function ResumeBanner({ session, onResume, connected }: { session: ChatSession; onResume: () => Promise<void>; connected: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const asleep = session.process === 'asleep';
  if (!asleep && session.state !== 'interrupted') return null;
  const resume = async () => {
    setBusy(true);
    setBlocked(null);
    try {
      await onResume();
    } catch (e) {
      if (isIneligible(e)) setBlocked(errorText(e, 'Agents can’t run in this workspace right now.'));
      // Cancelled on "Trust this folder?": nothing to report.
      else if (!isTrustDeclined(e)) toast(errorText(e, 'Could not resume the agent.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" className="glass-card flex items-center gap-3 rounded-[24px] px-4 py-3 text-[13.5px]">
      <div className="min-w-0 flex-1">
        <p className="text-ink-soft">
          {asleep
            ? 'Asleep after a quiet spell. It wakes when you send a message.'
            : 'Claude Code stopped in this workspace. Resume picks up the conversation where it left off.'}
        </p>
        {!asleep && session.endedReason && !blocked && <p className="mt-0.5 break-words text-[12px] text-muted">{session.endedReason}</p>}
        {blocked && (
          <p className="mt-0.5 break-words text-[12px] text-danger">
            {blocked}{' '}
            <Link to="/admin/workspaces" className="font-semibold underline underline-offset-2">
              Open Workspaces
            </Link>
          </p>
        )}
      </div>
      <Button size="sm" variant="secondary" icon={<Play className="size-4" />} loading={busy} disabled={!connected} onClick={() => void resume()}>
        Resume
      </Button>
    </div>
  );
}
