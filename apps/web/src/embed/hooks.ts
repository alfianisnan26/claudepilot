import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * A list that reads bottom-up (chat, a thread): it stays at the newest while the person is there, holds still when they scrolled up (a
 * "jump to latest" pill instead), keeps its place when older items load above, and calls `onTop` near the top for the next older page.
 */
export function useBottomList(ref: RefObject<HTMLElement | null>, count: number, onTop?: () => void, opts: { startAtTop?: boolean } = {}) {
  const [atBottom, setAtBottom] = useState(!opts.startAtTop);
  const stick = useRef(!opts.startAtTop);
  const prevHeight = useRef(0);
  const prevTop = useRef(0);
  const loadingOlder = useRef(false);

  const jump = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAtBottom(true);
  }, [ref]);

  // Before older items render above, the caller marks it so the place is kept instead of jumping.
  const older = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    loadingOlder.current = true;
    prevHeight.current = el.scrollHeight;
    prevTop.current = el.scrollTop;
  }, [ref]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (loadingOlder.current) {
      el.scrollTop = prevTop.current + (el.scrollHeight - prevHeight.current);
      loadingOlder.current = false;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [ref, count]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      stick.current = bottom;
      setAtBottom(bottom);
      if (el.scrollTop < 120 && onTop) onTop();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref, onTop]);

  return { atBottom, jump, older };
}
