// Colour contrast audit of the text on a page: foreground against the colour actually behind it (alpha-composited up the tree).
// Exposes CONTRAST, an expression to evaluate in the page; node tools/qa/contrast.mjs prints a summary for the main pages.
export const CONTRAST = `(() => {
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const page = parse(getComputedStyle(document.documentElement).backgroundColor);
  const base = page && page.a > 0 ? { ...page, a: 1 } : (parse(getComputedStyle(document.body).backgroundColor)?.a ? parse(getComputedStyle(document.body).backgroundColor) : { r: 255, g: 255, b: 255, a: 1 });
  const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); const c = parse(s.backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a === 1) break; } if (s.backgroundImage !== 'none') return null; } let acc = base; for (const c of stack.reverse()) acc = over(c, acc); return acc; };
  const opacityOf = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const out = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; let checked = 0;
  while ((n = walker.nextNode())) {
    const text = n.textContent.replace(/\\s+/g, ' ').trim();
    if (!text) continue;
    const el = n.parentElement; if (!el) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
    if (el.closest('[aria-hidden=true], script, style, svg, [disabled], [aria-disabled=true]')) continue;
    const fg = parse(s.color); const bg = bgOf(el); if (!fg || !bg) continue;
    const eff = over({ ...fg, a: fg.a * opacityOf(el) }, bg);
    const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const cr = ratio(eff, bg); checked++;
    if (cr < need) { const key = s.color + '|' + JSON.stringify([Math.round(bg.r), Math.round(bg.g), Math.round(bg.b)]) + '|' + size; const o = out.get(key) ?? { ratio: cr.toFixed(2), need, size, fg: s.color, bg: 'rgb(' + [Math.round(bg.r), Math.round(bg.g), Math.round(bg.b)] + ')', count: 0, sample: [] }; o.count++; if (o.sample.length < 3) o.sample.push(text.slice(0, 40)); out.set(key, o); }
  }
  return { checked, failing: [...out.values()].sort((a, b) => b.count - a.count).slice(0, 12) };
})()`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const { Browser } = await import('./browser.mjs');
  const { sleep } = await import('./lib.mjs');
  const width = Number(process.argv[2] ?? 1280);
  const paths = process.argv.slice(3).length ? process.argv.slice(3) : ['/admin/workspaces', '/admin/sessions', '/admin/usage', '/admin/pools?tab=accounts', '/admin/pools?tab=secrets', '/admin/access'];
  for (const dark of [false, true]) {
    const b = await Browser.launch({ width, height: width < 600 ? 844 : 800, dark });
    try {
      await b.signedIn();
      for (const p of paths) {
        await b.goto(p, 3000);
        const r = await b.eval(CONTRAST);
        console.log(`\n${dark ? 'DARK ' : 'LIGHT'} ${p}  checked=${r.checked} failing groups=${r.failing.length}`);
        for (const f of r.failing) console.log(`   ${f.ratio}:1 (need ${f.need}) ${f.fg} on ${f.bg} ${f.size}px x${f.count}  ${JSON.stringify(f.sample)}`);
      }
    } finally {
      await b.close();
    }
  }
}
