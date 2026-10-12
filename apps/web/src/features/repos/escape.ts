import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Escape for the things the Repos tab stacks: a menu over a repository sheet over a dialog over the workspace's sheet. The kit's
 * dialogs all listen on `document`, so one key press would close the lot. Here the one opened last answers, and the key goes no
 * further while any of these is open (when none is, it reaches the workspace's sheet as usual).
 */
const stack: { fn: () => void }[] = [];

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  top.fn();
}

export function useEscapeTop(active: boolean, onEscape: () => void) {
  const latest = useRef(onEscape);
  useLayoutEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    const entry = { fn: () => latest.current() };
    if (stack.length === 0) window.addEventListener('keydown', onKey, true);
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) window.removeEventListener('keydown', onKey, true);
    };
  }, [active]);
}
