import { CopyButton, Segmented } from '@isnanme/ui';
import type { ConnectCommands } from '@portal/contracts';
import { useState } from 'react';

type Which = 'install' | 'verified' | 'upgrade';

/**
 * The copy-paste command, exactly as the portal built it (the browser never assembles one). The token is in `install` and `verified`
 * only: it stays in memory, out of the address bar, the console and storage.
 */
export function CommandBlock({
  commands,
  upgradeFirst,
  onViewScript,
  onWhatItDoes,
}: {
  commands: ConnectCommands;
  /** Open on the upgrade command (the Outdated chip). */
  upgradeFirst?: boolean;
  onViewScript: () => void;
  onWhatItDoes: () => void;
}) {
  const [which, setWhich] = useState<Which>(upgradeFirst ? 'upgrade' : 'install');
  const text = commands[which];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Segmented<Which>
        label="Command"
        value={which}
        onChange={setWhich}
        options={[
          { value: 'install', label: 'Install' },
          { value: 'verified', label: 'Verify first' },
          { value: 'upgrade', label: 'Upgrade' },
        ]}
      />
      <div className="relative min-w-0 rounded-xl border border-line bg-surface-2">
        {/* tabIndex: a keyboard user can scroll a long command. */}
        <pre
          tabIndex={0}
          aria-label="Command"
          data-testid="command"
          className="max-h-44 min-w-0 overflow-auto whitespace-pre-wrap p-3 pr-14 font-mono text-[13px] leading-relaxed text-ink [overflow-wrap:anywhere]"
        >
          {text}
        </pre>
        <div className="absolute right-1 top-1">
          <CopyButton value={text} label="Copy command" toastMessage="Command copied" />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 text-[13px]">
        <button type="button" onClick={onViewScript} className="press min-h-11 font-medium text-ink-soft underline underline-offset-2">
          View script
        </button>
        <button type="button" onClick={onWhatItDoes} className="press min-h-11 font-medium text-ink-soft underline underline-offset-2">
          What it does
        </button>
      </div>
    </div>
  );
}
