// T-576 QA: CI > Runners (T-557 S4): empty state, Add runner sheet, label chips, the row, Drain / Resume, Remove confirm, at 390 and 1280 px, light and dark.
// Checks per view: no sideways scroll, controls >= 44 px on phone, label chips wrap (no overflow), the InfoTip opens, keyboard reaches the actions menu.
// usage: tools/qa/with-portal.sh 3474 env QA_SHOTS=job-out/qa-t576 node tools/qa/runners.mjs
import { Browser } from './browser.mjs';
import { api, login, sleep } from './lib.mjs';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra.slice(0, 400)}` : ''}`);
  if (!ok) failed++;
};

const METRICS = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const doc = document.scrollingElement;
  const scope = document.querySelector('[role=dialog]') ?? document.querySelector('main') ?? document.body;
  const small = [...scope.querySelectorAll('button, a, [role=tab], [role=menuitem], input, select, textarea, [role=switch]')].filter(vis)
    .map((e) => { const r = e.getBoundingClientRect(); return { t: (e.getAttribute('aria-label') || e.innerText || e.placeholder || e.tagName).slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((x) => x.w < 43.5 || x.h < 43.5);
  const over = [...scope.querySelectorAll('*')].filter((e) => vis(e) && e.getBoundingClientRect().right > innerWidth + 1).length;
  return { scroll: [doc.scrollWidth, doc.clientWidth], small, over, text: scope.innerText.slice(0, 600), bad: /\\b(NaN|undefined|null)\\b/.test(scope.innerText) };
})()`;

const cookie = await login();
const call = api(cookie);
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
try {
  for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
    for (const dark of [false, true]) {
      const tag = `${w}-${dark ? 'dark' : 'light'}`;
      console.log(tag);
      // start clean: no runners
      const list = await call('GET', '/api/ci/runners');
      for (const r of list.data ?? []) await call('DELETE', `/api/ci/runners/${encodeURIComponent(r.workspaceId)}`);
      await b.setViewport(w, h, mobile);
      await b.media({ dark });
      await b.goto('/admin/ci?tab=runners', 2500);
      let m = await b.eval(METRICS);
      check(`${tag}: empty state reads "No runners" with how to add`, /No runners/.test(m.text) && /runs-on/.test(m.text), m.text.replace(/\s+/g, ' '));
      check(`${tag}: no sideways scroll (empty)`, m.scroll[0] <= m.scroll[1] + 1 && m.over === 0, JSON.stringify([m.scroll, m.over]));
      if (mobile) check(`${tag}: controls >= 44 px (empty)`, m.small.length === 0, JSON.stringify(m.small));
      await b.shot(`runners-empty-${tag}`);

      // InfoTip
      await b.clickSel('button[aria-label="About runners"]');
      await sleep(300);
      const tip = await b.eval(`[...document.querySelectorAll('[role=note]')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.innerText)`);
      check(`${tag}: InfoTip explains runs-on and the risk`, tip.some((t) => /runs-on/.test(t) && /secrets/.test(t)), JSON.stringify(tip));
      await b.shot(`runners-tip-${tag}`);
      await b.key('Escape');

      // Add sheet
      await b.clickText('Add runner');
      await sleep(600);
      m = await b.eval(METRICS);
      check(`${tag}: Add runner sheet opens`, /Add runner/.test(m.text) && /Labels/.test(m.text), m.text.replace(/\s+/g, ' '));
      check(`${tag}: sheet no sideways scroll`, m.scroll[0] <= m.scroll[1] + 1 && m.over === 0, JSON.stringify([m.scroll, m.over]));
      if (mobile) check(`${tag}: sheet controls >= 44 px`, m.small.length === 0, JSON.stringify(m.small));
      await b.focusSel('input[placeholder="gpu"]');
      await b.type('gpu,');
      await b.type('a-rather-long-label-that-must-wrap-or-truncate-somewhere-sensible,');
      await sleep(300);
      const chips = await b.eval(`[...document.querySelectorAll('ul[aria-label=Labels] button')].map((e) => { const r = e.getBoundingClientRect(); return { t: e.getAttribute('aria-label'), r: Math.round(r.right), h: Math.round(r.height) }; })`);
      check(`${tag}: two label chips, inside the screen, >= 44 px tall`, chips.length === 2 && chips.every((c) => c.r <= w && c.h >= 43.5), JSON.stringify(chips));
      await b.shot(`runners-sheet-${tag}`);
      await b.clickText('Save');
      await sleep(1200);
      m = await b.eval(METRICS);
      check(`${tag}: saved: a runner row with its labels and 0/1`, /gpu/.test(m.text) && /0\/1/.test(m.text), m.text.replace(/\s+/g, ' '));
      check(`${tag}: row no sideways scroll`, m.scroll[0] <= m.scroll[1] + 1 && m.over === 0, JSON.stringify([m.scroll, m.over]));
      if (mobile) check(`${tag}: row controls >= 44 px`, m.small.length === 0, JSON.stringify(m.small));
      await b.shot(`runners-row-${tag}`);

      // Menu by keyboard: Drain
      await b.focusSel('button[aria-label$=" actions"]');
      await b.key('Enter');
      await sleep(300);
      const items = await b.eval(`[...document.querySelectorAll('[role=menuitem]')].map((e) => e.innerText.trim())`);
      check(`${tag}: menu by keyboard: Edit, Drain, Remove`, ['Edit', 'Drain', 'Remove'].every((x) => items.includes(x)), JSON.stringify(items));
      await b.shot(`runners-menu-${tag}`);
      await b.clickText('Drain', { selector: '[role=menuitem]' });
      await sleep(1000);
      m = await b.eval(METRICS);
      check(`${tag}: drained shows a Drained mark`, /Drained/i.test(m.text), m.text.replace(/\s+/g, ' '));
      await b.shot(`runners-drained-${tag}`);

      // Remove confirm
      await b.focusSel('button[aria-label$=" actions"]');
      await b.key('Enter');
      await sleep(300);
      await b.clickText('Remove', { selector: '[role=menuitem]' });
      await sleep(500);
      m = await b.eval(METRICS);
      check(`${tag}: Remove asks first`, /It stops being a runner/.test(m.text), m.text.replace(/\s+/g, ' '));
      if (mobile) check(`${tag}: confirm controls >= 44 px`, m.small.length === 0, JSON.stringify(m.small));
      await b.shot(`runners-remove-${tag}`);
      await b.clickText('Remove', { selector: 'button', nth: 0 });
      await sleep(300);
    }
  }
} finally {
  const list = await call('GET', '/api/ci/runners').catch(() => ({ data: [] }));
  for (const r of list.data ?? []) await call('DELETE', `/api/ci/runners/${encodeURIComponent(r.workspaceId)}`);
  await b.close?.();
}
console.log(failed ? `${failed} FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
