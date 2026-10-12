// The session ⋯ menu's "Auto move" item and its small dialog: Off, Ask, Automatic, or Default (follow my choice).
import { Dialog, Segmented, useToast } from '@isnanme/ui';
import { ArrowRightLeft } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AutoMode, AutoSessionState } from '@portal/contracts';
import { errorText } from '@/lib/api';
import { autoApi } from './api';
import { MODE_LABEL } from './pure';

type Choice = AutoMode | 'default';

export function useAutoMoveMenu(sessionId: string, state: AutoSessionState | null, onChange: (s: AutoSessionState) => void, disabled: boolean): { item: { label: string; icon: ReactNode; onSelect: () => void; disabled: boolean }; element: ReactNode } {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const current: Choice = state?.mode ?? 'default';
  const set = (v: Choice) => {
    autoApi.setSessionMode(sessionId, v === 'default' ? null : v).then(onChange, (e: unknown) => toast(errorText(e, 'Couldn’t change auto move.'), 'error'));
  };
  const label = state ? `Auto move: ${MODE_LABEL[state.effectiveMode]}` : 'Auto move';
  return {
    item: { label, icon: <ArrowRightLeft className="size-4" />, onSelect: () => setOpen(true), disabled: disabled || !state },
    element: (
      <Dialog open={open} onClose={() => setOpen(false)} size="sm" title="Auto move" description="When this chat’s Claude is nearly out of quota.">
        <div className="flex flex-col gap-3 pb-2">
          <Segmented<Choice>
            label="Auto move for this chat"
            value={current}
            options={[
              { value: 'default', label: 'Default' },
              { value: 'off', label: 'Off' },
              { value: 'ask', label: 'Ask' },
              { value: 'auto', label: 'Automatic' },
            ]}
            onChange={set}
          />
          {state && (
            <p className="text-[13px] text-muted">
              Now: {MODE_LABEL[state.effectiveMode]}
              {!state.applicable && state.why === 'pooled' ? ' · not used on an account pool' : ''}
              {!state.applicable && state.why === 'no_plan_reading' ? ' · no plan reading for this Claude' : ''}
              {state.pausedUntil ? ` · paused until ${new Date(state.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
            </p>
          )}
        </div>
      </Dialog>
    ),
  };
}
