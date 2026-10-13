// The session ⋯ menu's "Auto move" item and its small dialog: Default (follow my choice), Off, Ask, and Automatic when the platform allows it.
// No item while the platform has auto move off: a chat's choice could not turn it on (FR1, the platform is the ceiling).
import { Dialog, useToast } from '@isnanme/ui';
import { ArrowRightLeft, Check } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AutoMode, AutoSessionState } from '@portal/contracts';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { autoApi } from './api';
import { MODE_LABEL, modeChoices, whyText } from './pure';

type Choice = AutoMode | 'default';
const CHOICE_LABEL: Record<Choice, string> = { default: 'Default', ...MODE_LABEL };
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export interface AutoMenuItem {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled: boolean;
}

export function useAutoMoveMenu(
  sessionId: string,
  state: AutoSessionState | null,
  platformMode: AutoMode | null,
  onChange: (s: AutoSessionState) => void,
  disabled: boolean,
): { item: AutoMenuItem | null; element: ReactNode } {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const current: Choice = state?.mode ?? 'default';
  const set = (v: Choice) => {
    autoApi.setSessionMode(sessionId, v === 'default' ? null : v).then(onChange, (e: unknown) => toast(errorText(e, 'Couldn’t change auto move.'), 'error'));
  };
  if (!state || !platformMode || platformMode === 'off') return { item: null, element: null };
  const why = state.applicable ? null : whyText(state.why);
  const notes = [why, state.pausedUntil ? `Paused until ${time(state.pausedUntil)}` : null].filter(Boolean);
  return {
    item: { label: `Auto move: ${MODE_LABEL[state.effectiveMode]}`, icon: <ArrowRightLeft className="size-4" />, onSelect: () => setOpen(true), disabled },
    element: (
      <Dialog open={open} onClose={() => setOpen(false)} size="sm" title="Auto move">
        <div className="flex flex-col gap-3 pb-2">
          {/* Rows, not the 40 px segmented control: each choice is a 44 px target on a phone. */}
          <div role="radiogroup" aria-label="Auto move for this chat" className="flex flex-col gap-1">
            {[...new Set([...modeChoices(platformMode), current])].map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={current === value}
                onClick={() => set(value)}
                className="press flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm font-medium text-ink hover:bg-surface-2 aria-checked:bg-surface-2"
              >
                <span className="min-w-0 flex-1">{CHOICE_LABEL[value]}</span>
                {current === value && <Check className="size-4 shrink-0 text-accent" aria-hidden="true" />}
              </button>
            ))}
          </div>
          <p className="flex min-w-0 items-center gap-1 text-[13px] text-muted">
            <span className="min-w-0 [overflow-wrap:anywhere]">
              Now: {MODE_LABEL[state.effectiveMode]}
              {notes.map((n) => ` · ${n}`).join('')}
            </span>
            <InfoTip label="About auto move">
              When this chat’s Claude is nearly out of quota: Ask shows a card above the composer; Automatic moves the chat by itself at the end of a
              turn and leaves an Undo. Default follows Settings.
            </InfoTip>
          </p>
        </div>
      </Dialog>
    ),
  };
}
