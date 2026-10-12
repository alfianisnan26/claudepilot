// Keyboard audit: Tab through a page and report every stop without a visible focus indicator, in what order, and what the order skips.
// node tools/qa/focus.mjs [path ...]   (needs the QA portal; one browser)
import { Browser } from './browser.mjs';
import { sleep } from './lib.mjs';

const paths = process.argv.slice(2).length ? process.argv.slice(2) : ['/admin/workspaces', '/admin/sessions', '/admin/usage', '/admin/pools?tab=accounts', '/admin/access', '/login'];
const STOP = `(() => {
  const a = document.activeElement; if (!a || a === document.body) return null;
  const s = getComputedStyle(a); const r = a.getBoundingClientRect();
  const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
  const shadow = s.boxShadow && s.boxShadow !== 'none';
  const name = (a.getAttribute('aria-label') || a.innerText || a.getAttribute('placeholder') || a.value || a.tagName).toString().replace(/\\s+/g, ' ').trim().slice(0, 28);
  return { tag: a.tagName.toLowerCase(), role: a.getAttribute('role'), name, ring: outline || !!shadow || a.matches('input, textarea, select') && !!(a.closest('[class*=focus-within], label, div')), outline, shadow: !!shadow, w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0, inView: r.top >= -2 && r.bottom <= innerHeight + 2 };
})()`;
for (const width of [1280, 390]) {
  const b = await Browser.launch({ width, height: width < 600 ? 844 : 800 });
  try {
    if (!paths.includes('/login')) await b.signedIn();
    for (const p of paths) {
      if (p === '/login') await b.cookie('');
      else await b.signedIn();
      await b.goto(p, p.includes('workspaces') ? 6000 : 3000);
      await b.eval('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
      const stops = [];
      for (let i = 0; i < 40; i++) {
        await b.key('Tab');
        const s = await b.eval(STOP);
        if (!s) break;
        if (stops.length && stops.at(-1).name === s.name && stops.at(-1).tag === s.tag && i > 3 && stops.filter((x) => x.name === s.name).length > 1) break; // wrapped around
        stops.push(s);
      }
      const noRing = stops.filter((s) => !s.ring && s.visible);
      const hidden = stops.filter((s) => !s.visible);
      console.log(`${String(width).padEnd(5)} ${p.padEnd(28)} stops=${stops.length} noVisibleRing=${noRing.length} ${JSON.stringify(noRing.map((s) => `${s.tag}:${s.name}`).slice(0, 6))} invisibleStops=${hidden.length}`);
    }
  } finally {
    await b.close();
  }
}
