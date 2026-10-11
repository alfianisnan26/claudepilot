import { cn } from '@isnanme/ui';
import { useEffect, useRef, type ReactNode } from 'react';

/** Off, for the next key only, or held until tapped again (Web app §9.3). */
export type ModState = 'off' | 'once' | 'locked';
export type Modifier = 'ctrl' | 'alt';

export interface KeyDef {
  label: ReactNode;
  /** Accessible name when the label is a symbol. */
  name?: string;
  /** Bytes sent, or a modifier this key toggles. */
  send?: string;
  modifier?: Modifier;
  /** Repeats while held (arrows). */
  repeat?: boolean;
}

const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 60;

/**
 * A row of keys phone keyboards lack, above the keyboard. Keys never take focus, so the on-screen
 * keyboard stays open and typing continues in the terminal. Modifiers are shown by the caller's
 * state: a first tap applies to the next key, a second locks it, a third turns it off. Shared with
 * the browser live view (each with its own keys).
 */
export function KeyBar({
  keys,
  mods,
  onKey,
  onModifier,
  className,
}: {
  keys: KeyDef[];
  mods: Record<Modifier, ModState>;
  onKey: (send: string) => void;
  onModifier: (m: Modifier) => void;
  className?: string;
}) {
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> }>({});
  const stop = () => {
    clearTimeout(timers.current.delay);
    clearInterval(timers.current.every);
    timers.current = {};
  };
  useEffect(() => stop, []);

  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      className={cn('grid shrink-0 grid-cols-8 gap-1 border-t border-white/10 bg-[#141416] px-1.5 py-1.5 min-[600px]:grid-cols-16', className)}
    >
      {keys.map((k, i) => {
        const state = k.modifier ? mods[k.modifier] : 'off';
        return (
          <button
            key={i}
            type="button"
            tabIndex={-1}
            aria-label={k.name}
            aria-pressed={k.modifier ? state !== 'off' : undefined}
            // Pointer down, not click: keeps the terminal focused (and the keyboard up), and lets arrows repeat.
            onPointerDown={(e) => {
              e.preventDefault();
              if (k.modifier) return onModifier(k.modifier);
              if (!k.send) return;
              onKey(k.send);
              if (k.repeat) {
                stop();
                const send = k.send;
                timers.current.delay = setTimeout(() => (timers.current.every = setInterval(() => onKey(send), REPEAT_EVERY_MS)), REPEAT_DELAY_MS);
              }
            }}
            onPointerUp={stop}
            onPointerLeave={stop}
            onPointerCancel={stop}
            onContextMenu={(e) => e.preventDefault()}
            className={cn(
              'flex h-11 min-w-0 touch-none items-center justify-center rounded-lg font-mono text-[13px] select-none',
              state === 'locked'
                ? 'bg-white text-black'
                : state === 'once'
                  ? 'bg-white/30 text-white'
                  : 'bg-white/10 text-white/85 active:bg-white/25',
            )}
          >
            {k.label}
            {state === 'locked' && <span className="sr-only"> (locked)</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The terminal's keys: what Claude Code needs to interrupt, cycle modes and pick from menus. */
export const TERMINAL_KEYS: KeyDef[] = [
  { label: 'Esc', send: '\x1b' },
  { label: 'Tab', send: '\t' },
  { label: '⇧Tab', name: 'Shift+Tab', send: '\x1b[Z' },
  { label: 'Ctrl', modifier: 'ctrl' },
  { label: 'Alt', modifier: 'alt' },
  { label: '^C', name: 'Ctrl+C', send: '\x03' },
  { label: '^D', name: 'Ctrl+D', send: '\x04' },
  { label: '/', send: '/' },
  { label: '←', name: 'Left', send: '\x1b[D', repeat: true },
  { label: '↑', name: 'Up', send: '\x1b[A', repeat: true },
  { label: '↓', name: 'Down', send: '\x1b[B', repeat: true },
  { label: '→', name: 'Right', send: '\x1b[C', repeat: true },
  { label: '|', send: '|' },
  { label: '~', send: '~' },
  { label: '-', send: '-' },
  { label: '⏎', name: 'Enter', send: '\r' },
];

/**
 * Applies armed modifiers to what's about to be sent: Ctrl turns one character into its control
 * code (a–z, @–_, space) and an arrow into its Ctrl form; Alt prefixes Escape (Meta). Anything else
 * passes through unchanged.
 */
export function withModifiers(data: string, mods: Record<Modifier, ModState>): string {
  let out = data;
  if (mods.ctrl !== 'off') {
    const arrow = /^\x1b\[([ABCD])$/.exec(out);
    if (arrow) out = `\x1b[1;5${arrow[1]}`;
    else if (out.length === 1) {
      const c = out.charCodeAt(0);
      if (c >= 97 && c <= 122) out = String.fromCharCode(c - 96);
      else if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
      else if (out === ' ') out = '\x00';
    }
  }
  if (mods.alt !== 'off' && !out.startsWith('\x1b[1;')) out = `\x1b${out}`;
  return out;
}
