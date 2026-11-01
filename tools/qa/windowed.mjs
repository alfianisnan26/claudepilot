// Reading a windowed full-page list in a harness (components/WindowedList.tsx; docs/coord/UI-STANDARD.md §4): only the rows in view (and a
// few more) are in the page, so a harness that counts or reads "every row" sweeps the list instead: first to the end until every page is in
// (late pages regroup the list), then from the top, a screen at a time, to the
// end (which also loads the next pages), reading the rows drawn at each stop and merging them by key, first seen wins. The list scrolls inside
// itself on a desktop and with the document on a phone; both are handled.
import { sleep } from './lib.mjs';

/** The list's scroll position and size, and a step, in the page: `{ top, height, max }` of whichever scrolls. */
const VIEW = `(() => {
  const w = document.querySelector('[data-windowed]');
  const s = w && w.getAttribute('data-windowed') !== 'window' ? w.querySelector('[data-windowed-scroll]') : null;
  if (s) return { top: s.scrollTop, height: s.clientHeight, max: s.scrollHeight - s.clientHeight };
  const d = document.scrollingElement;
  return { top: d.scrollTop, height: innerHeight, max: d.scrollHeight - innerHeight };
})()`;
const scrollTo = (top) => `(() => {
  const w = document.querySelector('[data-windowed]');
  const s = w && w.getAttribute('data-windowed') !== 'window' ? w.querySelector('[data-windowed-scroll]') : null;
  if (s) s.scrollTop = ${top}; else document.scrollingElement.scrollTop = ${top};
})()`;

/**
 * Sweeps the windowed list. `rowsExpr` is an expression that returns the rows in the page as objects; `key(row)` names one (default `row.id`).
 * Returns every row seen, in the order first seen. `settle` is the wait after each step (ms).
 * @param {import('./browser.mjs').Browser} b
 */
export async function sweepRows(b, rowsExpr, { key = (r) => r.id, settle = 250, maxSteps = 400 } = {}) {
  // First every page: rows that arrive late regroup the list (a worker on an older page joins its lead's crew), so reading while pages
  // still arrive would keep a reading of the moment. Scroll to the end until the list stops growing, then read on a second pass.
  let last = -1;
  for (let i = 0, still = 0; i < maxSteps && still < 3; i++) {
    const v = await b.eval(VIEW);
    await b.eval(scrollTo(v.max));
    await sleep(settle * 2);
    const now = (await b.eval(VIEW)).max;
    still = now === last ? still + 1 : 0;
    last = now;
  }
  const seen = new Map();
  const take = async () => {
    for (const r of await b.eval(rowsExpr)) {
      const k = key(r);
      if (k != null && !seen.has(k)) seen.set(k, r);
    }
  };
  await b.eval(scrollTo(0));
  await sleep(settle);
  await take();
  let still = 0;
  for (let i = 0; i < maxSteps && still < 3; i++) {
    const v = await b.eval(VIEW);
    const next = Math.min(v.max, v.top + Math.max(200, Math.floor(v.height * 0.7)));
    if (next <= v.top) {
      // At the end: a next page may still be loading; wait and look again.
      still++;
      await sleep(settle * 3);
    } else still = 0;
    await b.eval(scrollTo(next));
    await sleep(settle);
    await take();
  }
  await b.eval(scrollTo(0));
  await sleep(settle);
  return [...seen.values()];
}

/** The list's own count of its items (aria-setsize on a drawn row; -1 while more pages are to come), or null when nothing is drawn. */
export async function setSize(b) {
  return b.eval(`(() => { const r = document.querySelector('[data-wl-index]'); return r ? Number(r.getAttribute('aria-setsize')) : null; })()`);
}
