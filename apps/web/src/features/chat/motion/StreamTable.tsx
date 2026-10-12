import { useLayoutEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { COMPONENTS } from '../Markdown';
import { MOTION } from './tokens';

/** The chat's own table (Markdown.tsx), drawn as it always is. */
const Table = COMPONENTS.table as ComponentType<{ children?: ReactNode }>;

/**
 * A table while it arrives. Rows show whole, but a new row can change how wide the columns are (the table lays
 * itself out by its content), which would make the cells already showing jump sideways. Each cell that moves
 * glides to its new place instead (the cells' old and new places, then an animation from one to the other); a
 * cell that was not there yet blurs in with its row. The table itself is drawn by the chat's own component, so it
 * looks the same as the stored reply's will.
 */
export function StreamTable({ children }: { children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const before = useRef(new WeakMap<Element, [number, number]>());
  // After every render of the table: where each cell is now, against where it was.
  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const now = new WeakMap<Element, [number, number]>();
    for (const cell of root.querySelectorAll<HTMLElement>('th, td')) {
      // (A table cell's offset is from its table, whatever transform it is in the middle of.)
      const here: [number, number] = [cell.offsetLeft, cell.offsetTop];
      const was = before.current.get(cell);
      if (was && !calm && (Math.abs(was[0] - here[0]) > 0.5 || Math.abs(was[1] - here[1]) > 0.5)) {
        cell.animate([{ transform: `translate(${was[0] - here[0]}px, ${was[1] - here[1]}px)` }, { transform: 'none' }], { duration: MOTION.word.ms, easing: MOTION.easeCss });
      }
      now.set(cell, here);
    }
    before.current = now;
  });
  return (
    <div ref={box} className="contents">
      <Table>{children}</Table>
    </div>
  );
}
