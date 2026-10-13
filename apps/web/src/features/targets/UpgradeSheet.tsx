import { CopyButton, Dialog, LoadError, Segmented, Spinner } from '@isnanme/ui';
import type { ConnectMaintenanceCommands } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { connectApi } from './api';

type Which = 'upgrade' | 'doctor';

/** The Outdated chip: the token-less upgrade command for a target's agent (and its doctor), as the portal built it. No token is made. */
export function UpgradeSheet({ targetId, onClose }: { targetId: string | null; onClose: () => void }) {
  const [commands, setCommands] = useState<ConnectMaintenanceCommands | null>(null);
  const [failed, setFailed] = useState(false);
  const [which, setWhich] = useState<Which>('upgrade');
  const load = useCallback(async () => {
    if (!targetId) return;
    setFailed(false);
    setCommands(null);
    try {
      setCommands(await connectApi.commands(targetId));
    } catch {
      setFailed(true);
    }
  }, [targetId]);
  useEffect(() => {
    if (targetId) {
      setWhich('upgrade');
      void load();
    }
  }, [targetId, load]);
  const text = commands?.[which] ?? '';
  return (
    <Dialog open={!!targetId} onClose={onClose} title="Upgrade">
      <div className="flex min-w-0 flex-col gap-2">
        {failed && <LoadError onRetry={load} message="Could not load the command." />}
        {!commands && !failed && (
          <div className="flex h-24 items-center justify-center" role="status" aria-label="Loading the command">
            <Spinner className="size-5" />
          </div>
        )}
        {commands && (
          <>
            <Segmented<Which>
              label="Command"
              value={which}
              onChange={setWhich}
              options={[
                { value: 'upgrade', label: 'Upgrade' },
                { value: 'doctor', label: 'Doctor' },
              ]}
            />
            <div className="relative min-w-0 rounded-xl border border-line bg-surface-2">
              <pre
                tabIndex={0}
                aria-label="Command"
                data-testid="command"
                className="max-h-44 min-w-0 overflow-auto whitespace-pre-wrap p-3 pr-14 font-mono text-[13px] leading-relaxed text-ink [overflow-wrap:anywhere]"
              >
                {text}
              </pre>
              <div className="absolute right-1 top-1">
                <CopyButton value={text} label="Copy command" showLabel={false} toastMessage="Command copied" />
              </div>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
