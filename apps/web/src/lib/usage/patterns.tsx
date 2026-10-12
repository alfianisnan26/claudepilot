import { useSyncExternalStore } from 'react';
import { PATTERN_TILE, PATTERNS_KEY, SLOT_PATTERNS, slotIndex } from './palette';
import type { PaletteSlot } from '@portal/contracts';

/**
 * Hatch patterns on the usage colours (the non-colour cue in lib/usage/palette.ts). A per-device choice: on, off, or (never chosen) on
 * when the system asks for it (`forced-colors`, `prefers-contrast: more`). Read by every swatch and chart through `usePatterns`.
 */
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

function stored(): boolean | null {
  try {
    const v = localStorage.getItem(PATTERNS_KEY);
    return v === 'on' ? true : v === 'off' ? false : null;
  } catch {
    return null;
  }
}
function systemAsks(): boolean {
  try {
    return window.matchMedia('(forced-colors: active)').matches || window.matchMedia('(prefers-contrast: more)').matches;
  } catch {
    return false;
  }
}
let chosen: boolean | null = stored();

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PATTERNS_KEY) {
      chosen = stored();
      emit();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
};
const read = () => chosen ?? systemAsks();

export function setPatterns(on: boolean): void {
  chosen = on;
  try {
    localStorage.setItem(PATTERNS_KEY, on ? 'on' : 'off');
  } catch {
    // not remembered on this device
  }
  emit();
}

/** Whether hatch patterns are on, and a way to change it. */
export function usePatterns(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  return [on, setPatterns];
}

/** The marks of a slot's pattern, drawn in the surface colour so they read on every slot in both themes. */
function Marks({ slot }: { slot: number }) {
  return (
    <>
      {SLOT_PATTERNS[slot]!.map((m, i) =>
        m.type === 'path' ? (
          <path key={i} d={m.d} fill="none" stroke="var(--color-surface)" strokeOpacity="0.7" strokeWidth="1.1" />
        ) : (
          <circle key={i} cx={m.cx} cy={m.cy} r={m.r} fill="var(--color-surface)" fillOpacity="0.7" />
        ),
      )}
    </>
  );
}

/** `<pattern>` elements for the slots that have one, ids `<prefix>-<slot>`: put inside an `<svg><defs>`. */
export function PatternDefs({ prefix }: { prefix: string }) {
  return (
    <>
      {SLOT_PATTERNS.map((marks, slot) =>
        marks.length ? (
          <pattern key={slot} id={`${prefix}-${slot}`} width={PATTERN_TILE} height={PATTERN_TILE} patternUnits="userSpaceOnUse">
            <Marks slot={slot} />
          </pattern>
        ) : null,
      )}
    </>
  );
}

/** The fill that lays a slot's pattern over its colour, or null where the slot has none (slot 0, Others): `url(#<prefix>-<slot>)`. */
export function patternFill(prefix: string, slot: PaletteSlot | undefined): string | null {
  const i = slotIndex(slot);
  return i !== null && SLOT_PATTERNS[i]!.length ? `url(#${prefix}-${i})` : null;
}
