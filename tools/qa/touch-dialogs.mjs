// T-1859: every visible interactive element in five shared dialogs is a 44 x 44 tap target at 390 px (QA-STANDARDS A5): the New ticket
// sheet (TextField, Select, tag picks, Segmented, the sheet's Close), the Bump sheet on a ticket page, and the session info sheet (its
// ticket chip, Rename, Keep going, limits), a glance widget (sheet on a phone, popover from 640 px), and the quick search, whose field
// must start below the top safe-area inset (the phone runs emulate an iPhone's 59 / 34 px insets). An element counts with its label when it is a visually hidden input inside one. Light and dark
// at 390 x 844, plus 1280 x 800 to show the desktop sizes (reported, not failed: the floor is for phones). Screenshots go to QA_SHOTS.
// Against a scratch portal with "This machine" and a signed-in-looking Claude (a session needs one; it does not need to answer):
//   node tools/qa/mock-anthropic.mjs 4627 /tmp/cp-t1859-mock.jsonl &
//   PORTAL_LOCAL_ENABLED=true scripts/scratch-portal.sh start 3427
//   printf '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4627","ANTHROPIC_API_KEY":"fake-mock-key"}}' > /tmp/scratch-portal-3427/home/.claude/settings.json
//   QA_PORT=3427 QA_CODE=24681372 QA_SHOTS=/tmp/qa-shots/t1859 node tools/qa/touch-dialogs.mjs
//   scripts/scratch-portal.sh stop 3427
import { Browser, SHOTS } from './browser.mjs';
import { api, login, sleep } from './lib.mjs';

const MIN = 44;
const cookie = await login();
const call = api(cookie);
const made = async (path, body) => {
  const r = await call('POST', path, body);
  if (r.status >= 300) throw new Error(`${path}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.data;
};
await call('POST', '/api/workspaces/local/local/start');
// A tagged ticket (so New ticket shows tag picks) and a session that works on it (so its info shows the ticket chip).
const t = await made('/api/tickets', { summary: 'Touch targets on a phone', type: 'task', priority: 'normal', tags: ['frontend', 'ui'], workspaceId: 'local/local' });
const s = await made('/api/chat/sessions', { workspaceId: 'local/local', title: 'Touch check', ticketId: t.id });

// Every visible interactive element inside the open dialog, with its tap box (an sr-only input's label stands in for it).
const MEASURE = `(() => {
  const d = [...document.querySelectorAll('[role=dialog]')].pop();
  if (!d) return null;
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=radio], [role=switch], [role=checkbox], [role=tab], [tabindex]:not([tabindex="-1"])';
  const out = [];
  for (const e of d.querySelectorAll(SEL)) {
    if (e === d) continue;
    let b = e.getBoundingClientRect();
    const st = getComputedStyle(e);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    // A checkbox or radio is tapped through the label around it; a visually hidden input too.
    const l = e.closest('label');
    if (l && (b.width <= 2 || b.height <= 2 || /^(checkbox|radio)$/.test(e.type))) b = l.getBoundingClientRect();
    else if (b.width <= 2 || b.height <= 2) continue;
    if (b.width === 0 || b.height === 0) continue;
    const name = (e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.innerText || e.getAttribute('placeholder') || e.getAttribute('name') || e.tagName).trim().replace(/\\s+/g, ' ').slice(0, 28);
    out.push({ name, tag: e.tagName.toLowerCase(), w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 });
  }
  const field = d.querySelector('input:not([type=hidden])')?.getBoundingClientRect();
  return { items: out, hscroll: document.scrollingElement.scrollWidth > innerWidth + 1, top: Math.round(d.getBoundingClientRect().top), fieldTop: field ? Math.round(field.top) : null };
})()`;

const SHEETS = [
  {
    name: 'new-ticket',
    async open(b) {
      await b.goto('/admin/tickets', 2500);
      await b.waitFor(`[...document.querySelectorAll('main button')].some((e) => /^New( ticket)?$/.test(e.innerText.trim()))`, 30000);
      await b.eval(`[...document.querySelectorAll('main button')].find((e) => /^New( ticket)?$/.test(e.innerText.trim()) && e.getBoundingClientRect().width > 0).click()`);
      await b.waitFor(`!!document.querySelector('[role=dialog] input')`);
      // The tag picks load after the dialog opens.
      await b.waitFor(`[...document.querySelectorAll('[role=dialog] button')].some((e) => e.innerText.trim().startsWith('+ '))`).catch(() => undefined);
    },
    must: ['Summary', 'Tags', '+ frontend', 'Close'],
  },
  {
    name: 'bump-sheet',
    async open(b) {
      await b.goto(`/admin/tickets/${t.id}`, 2500);
      await b.waitFor(`[...document.querySelectorAll('main button')].some((e) => e.innerText.trim() === 'Bump')`, 30000);
      await b.clickText('Bump', { exact: true, selector: 'button' });
      await b.waitFor(`!!document.querySelector('[role=dialog]')`);
      await sleep(600);
    },
    must: ['Close'],
  },
  {
    name: 'session-info',
    async open(b) {
      await b.goto(`/admin/sessions/${s.id}`, 2500);
      await b.waitFor(`!!document.querySelector('button[aria-label$="agent info"]:not([disabled])')`, 30000);
      await b.clickSel('button[aria-label$="agent info"]');
      await b.waitFor(`!!document.querySelector('[role=dialog] a[href*="/admin/tickets/${t.id}"]')`);
      await sleep(400);
    },
    must: [t.id, 'Rename', 'Close'],
  },
  {
    // A glance widget's full form from the app bar's first chip: the kit's sheet on a phone, a popover with FullHeader (Open, Close) from
    // 640 px, 32 px with a mouse (the 1280 run reports it) and 44 px with a coarse pointer, which headless Chromium cannot emulate (its
    // pointer is always `none`).
    name: 'glance',
    async open(b) {
      await b.goto('/admin/home', 2500);
      const chip = 'ul[aria-label="At a glance"] button[aria-haspopup=dialog]';
      await b.waitFor(`[...document.querySelectorAll('${chip}')].some((e) => e.getBoundingClientRect().width > 0)`, 30000);
      await b.eval(`[...document.querySelectorAll('${chip}')].find((e) => e.getBoundingClientRect().width > 0).click()`);
      await b.waitFor(`!!document.querySelector('[role=dialog]')`);
      await sleep(600);
    },
    must: ['Close'],
  },
  {
    // The quick search (Ctrl+K): a panel at the top of the screen, so on a phone its field must clear the status bar and the notch.
    name: 'palette',
    async open(b) {
      await b.goto('/admin/home', 2500);
      await b.waitFor(`!!document.querySelector('main')`, 30000);
      await b.key('k', { modifiers: 2, code: 'KeyK' });
      await b.waitFor(`!!document.querySelector('[role=dialog][aria-label=Search] input')`);
      await sleep(400);
    },
    must: ['Search', 'Close search'],
    clearsTop: true,
  },
];

// An iPhone with a notch, installed edge to edge: the insets the phone runs emulate.
const PHONE_INSETS = { top: 59, bottom: 34, left: 0, right: 0 };

let fails = 0;
for (const cfg of [
  { tag: '390-light', width: 390, height: 844, mobile: true },
  { tag: '390-dark', width: 390, height: 844, mobile: true, dark: true },
  { tag: '1280-light', width: 1280, height: 800 },
]) {
  const phone = cfg.width < 600;
  const b = await Browser.launch({ width: cfg.width, height: cfg.height, mobile: cfg.mobile, dark: !!cfg.dark });
  try {
    await b.cookie(cookie);
    await b.send('Emulation.setSafeAreaInsetsOverride', { insets: phone ? PHONE_INSETS : { top: 0, bottom: 0, left: 0, right: 0 } });
    for (const sheet of SHEETS) {
      const bad = [];
      let m = null;
      try {
        await sheet.open(b);
        m = await b.eval(MEASURE);
      } catch (e) {
        bad.push(`did not open: ${String(e.message ?? e).slice(0, 160)}`);
      }
      const file = await b.shot(`t1859-${sheet.name}-${cfg.tag}`).catch(() => '');
      if (m) {
        const small = m.items.filter((x) => x.w < MIN || x.h < MIN);
        if (phone && small.length) bad.push(`under ${MIN}: ${JSON.stringify(small)}`);
        if (phone && m.hscroll) bad.push('horizontal scroll');
        if (phone && sheet.clearsTop && !(m.fieldTop >= PHONE_INSETS.top)) bad.push(`field top ${m.fieldTop} under the ${PHONE_INSETS.top} px top inset`);
        for (const want of sheet.must) if (!m.items.some((x) => x.name.includes(want))) bad.push(`missing "${want}"`);
      }
      if (phone && bad.length) fails++;
      const sizes = m ? m.items.map((x) => `${x.name} ${x.w}x${x.h}`).join('; ') : '';
      console.log(`${phone ? (bad.length ? 'FAIL' : 'ok  ') : 'info'} ${cfg.tag} ${sheet.name}: ${m?.items.length ?? 0} targets, top ${m?.top}${m?.fieldTop != null ? `, field top ${m.fieldTop}` : ''} ${bad.join(' | ')}`);
      if (!phone || bad.length) console.log(`     ${sizes}`);
      if (file) console.log(`     ${file}`);
      await b.key('Escape');
      await sleep(400);
    }
  } finally {
    await b.close();
  }
}
console.log(fails ? `\n${fails} sheet/preset(s) with findings (a target under ${MIN} px, sideways scroll, a field under the top inset); screenshots in ${SHOTS}` : `\nevery target is ${MIN} px or more at 390 and clears the top inset; screenshots in ${SHOTS}`);
process.exit(fails ? 1 : 0);
