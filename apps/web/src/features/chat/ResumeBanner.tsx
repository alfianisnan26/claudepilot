import { Button, useToast } from '@isnanme/ui';
import type { ChatSession } from '@portal/contracts';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { errorText } from '@/lib/api';
import { isTrustDeclined } from './TrustSheet';

/**
 * A session whose Claude Code process is gone (Interrupted) or asleep after idling: say so, and offer
 * Resume. Sending a message resumes it too; this makes it explicit and lets you check it first.
 */
export function ResumeBanner({ session, onResume, connected }: { session: ChatSession; onResume: () => Promise<void>; connected: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const asleep = session.process === 'asleep';
  if (!asleep && session.state !== 'interrupted') return null;
  const resume = async () => {
    setBusy(true);
    try {
      await onResume();
    } catch (e) {
      // Cancelled on "Trust this folder?": nothing to report.
      if (!isTrustDeclined(e)) toast(errorText(e, 'Could not resume the session.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" className="mb-2 flex items-center gap-3 rounded-2xl bg-surface-2 px-3.5 py-2.5 text-[13px]">
      <p className="min-w-0 flex-1 text-ink-soft">
        {asleep
          ? 'Asleep after a quiet spell. It wakes when you send a message.'
          : 'Claude Code stopped in this workspace. Resume picks up the conversation where it left off.'}
      </p>
      <Button size="sm" variant="secondary" icon={<Play className="size-4" />} loading={busy} disabled={!connected} onClick={() => void resume()}>
        Resume
      </Button>
    </div>
  );
}
