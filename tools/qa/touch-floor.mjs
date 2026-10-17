// T-449: the global 44 px floor (index.css, below 600 px) on every page that has a Segmented control or a Menu. For each page, width and theme:
// sideways scroll, the size of every radio / menu button / menu item, icon-only menu buttons that lost their shape, and each open menu
// (does it stay inside the viewport, how tall is it). Screenshots of the page and of each open menu go to QA_SHOTS.
// usage: tools/qa/with-portal.sh 3471 env QA_SHOTS=dir node tools/qa/touch-floor.mjs [prefix]
import { Browser, SHOTS } from './browser.mjs';
import { api, login, sleep } from './lib.mjs';

const prefix = process.argv[2] ?? 'floor';
const call = api(await login());
const sessions = (await call('GET', '/api/chat/sessions?limit=100')).data?.items ?? [];
const ws = (await call('GET', '/api/workspaces')).data ?? [];
const pages = [
  ['home', '/admin/home'],
  ['sessions', '/admin/sessions'],
  ['usage', '/admin/usage'],
  ['usage-attr', '/admin/usage?tab=attribution'],
  ['usage-claudes', '/admin/usage?tab=claudes'],
  ['usage-budgets', '/admin/usage?tab=budgets'],
  ['tickets', '/admin/tickets'],
  ['workspaces', '/admin/workspaces'],
  ['knowledge', '/admin/knowledge'],
  ['pools-accounts', '/admin/pools?tab=accounts'],
  ['pools-skills', '/admin/pools?tab=skills'],
  ['pools-personas', '/admin/pools?tab=personas'],
  ['pools-mcp', '/admin/pools?tab=mcp'],
  ['access', '/admin/access'],
  ['ci', '/admin/ci'],
  ...(sessions[0] ? [['session', `/admin/sessions/${sessions[0].id}`]] : []),
  ...(ws[0] ? [['workspace-shell', `/admin/workspaces/${ws[0].id}/shell`]] : []),
];
const MEASURE = `(() => {
  const vw = innerWidth;
  const r = (e) => { const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; };
  const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const label = (e) => ((e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 24));
  const radios = [...document.querySelectorAll('[role=radiogroup] > [role=radio]')].filter(vis);
  const menuBtns = [...document.querySelectorAll('button[aria-haspopup=menu]')].filter(vis);
  const groups = [...document.querySelectorAll('[role=radiogroup]')].filter(vis).map((g) => ({ ...r(g), n: g.children.length, over: g.scrollWidth > g.clientWidth + 1, label: g.getAttribute('aria-label') || '' }));
  const offscreen = [...document.querySelectorAll('button, a, [role=radio], [role=tab], input, select')].filter(vis).filter((e) => { const b = e.getBoundingClientRect(); return b.right > vw + 1 || b.left < -1; }).filter((e) => !e.closest('[class*=overflow-x-auto], [class*=overflow-auto]')).map((e) => label(e) + ' ' + JSON.stringify(r(e))).slice(0, 6);
  return {
    hscroll: [document.documentElement.scrollWidth, document.body.scrollWidth, vw],
    radios: radios.length, radiosUnder44: radios.map((e) => ({ l: label(e), ...r(e) })).filter((x) => x.h < 44 || x.w < 44).slice(0, 6),
    groups, groupOverflow: groups.filter((g) => g.over || g.r > vw + 1).length,
    menuBtns: menuBtns.length, menuBtnsUnder44: menuBtns.map((e) => ({ l: label(e) || e.getAttribute('aria-label'), ...r(e) })).filter((x) => x.h < 44 || x.w < 44).slice(0, 6),
    menuBtnShapes: menuBtns.map((e) => ({ l: label(e) || e.getAttribute('aria-label'), w: r(e).w, h: r(e).h, text: !!(e.innerText || '').trim() })).slice(0, 12),
    offscreen,
  };
})()`;
const MENU = `(() => {
  const m = document.querySelector('[role=menu]'); if (!m) return null;
  const b = m.getBoundingClientRect(); const items = [...m.querySelectorAll('[role=menuitem]')].map((i) => Math.round(i.getBoundingClientRect().height));
  return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), vw: innerWidth, vh: innerHeight, items, scrollable: m.scrollHeight > m.clientHeight + 1 };
})()`;
let fails = 0;
for (const [width, height, dark] of [
  [390, 844, false],
  [390, 844, true],
  [1280, 800, false],
]) {
  const tag = `${width}-${dark ? 'dark' : 'light'}`;
  console.log(tag);
  const b = await Browser.launch({ width, height, dark, mobile: width < 600 });
  await b.signedIn();
  for (const [name, path] of pages) {
    await b.goto(path, name === 'workspaces' ? 5000 : 2500);
    const m = await b.eval(MEASURE);
    const file = await b.shot(`${prefix}-${name}-${tag}`);
    const hs = m.hscroll[0] > m.hscroll[2] || m.hscroll[1] > m.hscroll[2];
    const bad = [];
    if (width < 600) {
      if (hs) bad.push(`hscroll ${m.hscroll}`);
      if (m.radiosUnder44.length) bad.push(`radios<44 ${JSON.stringify(m.radiosUnder44)}`);
      if (m.menuBtnsUnder44.length) bad.push(`menuBtn<44 ${JSON.stringify(m.menuBtnsUnder44)}`);
      if (m.groupOverflow) bad.push(`radiogroup overflows ${m.groupOverflow}`);
      if (m.offscreen.length) bad.push(`offscreen ${JSON.stringify(m.offscreen)}`);
    }
    // icon-only menu buttons should stay about square
    const stretched = m.menuBtnShapes.filter((s) => !s.text && (s.w > 64 || s.h > 64 || Math.abs(s.w - s.h) > 12));
    if (stretched.length) bad.push(`icon menu button not square ${JSON.stringify(stretched)}`);
    // open the first few menus
    const menus = [];
    for (let i = 0; i < Math.min(m.menuBtns, 3); i++) {
      try {
        await b.eval(`document.querySelectorAll('button[aria-haspopup=menu]')[${i}]?.scrollIntoView({block:'center'})`);
        await b.eval(
          `(() => { const e = [...document.querySelectorAll('button[aria-haspopup=menu]')].filter((x) => x.getBoundingClientRect().width > 0)[${i}]; e?.click(); })()`,
        );
        await sleep(500);
        const mm = await b.eval(MENU);
        if (mm) {
          menus.push(mm);
          const out = mm.l < -1 || mm.r > mm.vw + 1 || mm.t < -1 || mm.b > mm.vh + 1;
          if (width < 600 && out) bad.push(`menu ${i} leaves the viewport ${JSON.stringify(mm)}`);
          if (width < 600 && mm.items.some((h) => h < 44)) bad.push(`menu ${i} item<44 ${mm.items}`);
          await b.shot(`${prefix}-${name}-menu${i}-${tag}`);
        }
        await b.key('Escape');
        await sleep(250);
      } catch (e) {
        bad.push(`menu ${i} error ${e.message}`);
      }
    }
    if (bad.length) fails++;
    console.log(
      `  ${bad.length ? 'FAIL' : 'ok  '} ${name}: radios=${m.radios} menuBtns=${m.menuBtns} menus=${menus.length}${menus.length ? ' items=' + JSON.stringify(menus.map((x) => x.items.slice(0, 6))) : ''} ${bad.join(' | ')} ${file}`,
    );
  }
  await b.close();
}
console.log(fails ? `\n${fails} page/preset(s) with findings; screenshots in ${SHOTS}` : `\nno findings; screenshots in ${SHOTS}`);
