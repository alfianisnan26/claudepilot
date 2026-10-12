import { CopyButton, Dialog, LoadError, Spinner } from '@isnanme/ui';
import type { ConnectCommands, ConnectPlanPreview } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { connectApi, fetchScript } from './api';

/** The installer's text with its sha256 ("View script"): what a person reads before they pipe it to a shell. */
export function ScriptSheet({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: ConnectCommands }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    setText(null);
    try {
      setText(await fetchScript(commands.scriptUrl));
    } catch {
      setFailed(true);
    }
  }, [commands.scriptUrl]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  return (
    <Dialog open={open} onClose={onClose} title="Script">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 items-center gap-2 rounded-xl bg-surface-2 py-1 pl-3">
          <span className="shrink-0 text-[13px] font-semibold text-ink-soft">sha256</span>
          <code className="min-w-0 flex-1 font-mono text-[12px] tabular-nums [overflow-wrap:anywhere]">{commands.scriptSha256}</code>
          <CopyButton value={commands.scriptSha256} label="Copy sha256" showLabel={false} toastMessage="Checksum copied" />
        </div>
        {failed && <LoadError onRetry={load} message="Could not load the script." />}
        {!text && !failed && (
          <div className="flex h-40 items-center justify-center" role="status" aria-label="Loading the script">
            <Spinner className="size-5" />
          </div>
        )}
        {text && (
          <pre tabIndex={0} aria-label="Script text" className="max-h-[50vh] min-w-0 overflow-auto rounded-xl border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed">
            {text}
          </pre>
        )}
      </div>
    </Dialog>
  );
}

/** The steps the installer takes for one enrollment ("What it does"), from the same code that builds its plan. */
export function PlanSheet({ open, onClose, targetId, enrollmentId }: { open: boolean; onClose: () => void; targetId: string; enrollmentId: string }) {
  const [plan, setPlan] = useState<ConnectPlanPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    setPlan(null);
    try {
      setPlan(await connectApi.plan(targetId, enrollmentId));
    } catch {
      setFailed(true);
    }
  }, [targetId, enrollmentId]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  return (
    <Dialog open={open} onClose={onClose} title="What it does">
      <div className="flex min-w-0 flex-col gap-3">
        {failed && <LoadError onRetry={load} message="Could not load the steps." />}
        {!plan && !failed && (
          <div className="flex h-24 items-center justify-center" role="status" aria-label="Loading the steps">
            <Spinner className="size-5" />
          </div>
        )}
        {plan && (
          <>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm [overflow-wrap:anywhere]">
              {plan.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            {plan.manifest && (
              <pre tabIndex={0} aria-label="Manifest" className="max-h-[40vh] min-w-0 overflow-auto rounded-xl border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed">
                {plan.manifest}
              </pre>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
