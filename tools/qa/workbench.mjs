// The Workbench layout on the Tickets page (T-158 slice 1; the owner's screenshot of the board in a centred 1,120 px column on a ~2,380 px
// desktop). Over 390 (a phone, touch, the iPhone's safe areas), 768, 1280, 1920, 2560, 3840 and 3440 x 1440, light and dark, against a
// scratch portal seeded with tickets in every board column (a long title, an unbroken one). It asserts:
//   - the page never scrolls sideways (document.scrollingElement.scrollWidth <= the window's width, and the phone's layout viewport is not
//     widened: a priority's screen-reader text hanging off a far board column made it 1216 px at 390), with the board, the list and a ticket;
//   - the board's fully visible columns never fall as the window widens, and at 1920 px and wider every column shows with no sideways
//     scroll inside the board; at 3840 the board spans at least 80 % of the screen;
//   - expanded and wider (1024+), the page is pinned: it does not scroll down, the board fills the panel to the window's bottom;
//   - a phone and a tablet keep one panel at a time (an open ticket in the queue's place, with Back), not pinned;
//   - expanded and wider, a ticket opens BESIDE the board (two panels, no overlap, the board still there, the keyboard moved to the
//     ticket), its card is marked, and Close returns to the same queue (view and filters kept in the address);
//   - 44 px touch targets at 390 px for every control of the queue (list and board) and for Back.
// usage: scripts/scratch-portal.sh start 3461 && QA_PORT=3461 QA_CODE=24681372 QA_SHOTS=/tmp/t158-shots node tools/qa/workbench.mjs
//   Screenshots go to $QA_SHOTS (browser.mjs), one per size, theme and state. The seeded tickets ("QA wb …") stay: the portal is a scratch one.
import { Browser } from './browser.mjs';
import { api, login } from './lib.mjs';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};

// --- seed -------------------------------------------------------------------------------------------------------------------------------
const cookie = await login();
const call = api(cookie);
const have = await call('GET', '/api/tickets?q=QA%20wb&includeClosed=1&limit=100');
if ((have.data?.items?.length ?? 0) < 16) {
  const seed = [
    ['open', 'QA wb the board shows every column on a wide screen'],
    ['open', 'QA wb a ticket with a long title that has to wrap inside its card on a phone and still read well beside the open one'],
    ['open', `QA wb ${'unbroken'.repeat(12)}`],
    ['open', 'QA wb short'],
    ['open', 'QA wb another open one'],
    ['in_progress', 'QA wb in progress, one'],
    ['in_progress', 'QA wb in progress, two'],
    ['in_progress', 'QA wb in progress, three'],
    ['blocked', 'QA wb blocked on a person'],
    ['blocked', 'QA wb blocked on CI'],
    ['in_review', 'QA wb in review, one'],
    ['in_review', 'QA wb in review, two'],
    ['in_review', 'QA wb in review, three'],
    ['done', 'QA wb done, one'],
    ['done', 'QA wb done, two'],
    ['done', 'QA wb done, three'],
  ];
  for (const [status, summary] of seed) {
    const made = await call('POST', '/api/tickets', { summary, type: status === 'blocked' ? 'bug' : 'task', priority: status === 'open' ? 'high' : 'normal', tags: ['qa-wb'], description: '## What\n\nA seeded ticket for the Workbench check. '.repeat(3) });
    if (made.status !== 201) throw new Error(`seed failed: ${made.status} ${made.text}`);
    if (status !== 'open') {
      const r = await call('PATCH', `/api/tickets/${made.data.id}`, { status });
      if (r.status !== 200) throw new Error(`status ${status} failed: ${r.status} ${r.text}`);
    }
  }
}

// --- the browser --------------------------------------------------------------------------------------------------------------------------
const NONE = { top: 0, bottom: 0, left: 0, right: 0 };
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: { top: 59, bottom: 34, left: 0, right: 0 } },
  { name: '768', w: 768, h: 1024 },
  { name: '1280', w: 1280, h: 800 },
  { name: '1920', w: 1920, h: 1080 },
  { name: '2560', w: 2560, h: 1440 },
  { name: '3440x1440', w: 3440, h: 1440 },
  { name: '3840', w: 3840, h: 2160 },
];
const EXPANDED = 1024;

const STATE = `(() => {
  const r = (e) => e && e.getBoundingClientRect();
  const board = document.querySelector('[data-board]');
  const b = r(board);
  const cols = [...document.querySelectorAll('[data-column]')].map((c) => r(c));
  const wb = document.querySelector('[data-workbench]');
  const panels = [...document.querySelectorAll('[data-workbench] > [data-panel]')].map((p) => ({ id: p.dataset.panel, l: r(p).left, r: r(p).right, w: r(p).width }));
  const doc = document.scrollingElement;
  return {
    path: location.pathname + location.search,
    vw: innerWidth, vh: innerHeight,
    docW: doc.scrollWidth, docH: doc.scrollHeight,
    size: wb?.dataset.size ?? null, pinned: wb?.hasAttribute('data-pinned') ?? false, split: wb?.hasAttribute('data-split') ?? false,
    panels,
    board: b ? { l: b.left, r: b.right, w: b.width, bottom: b.bottom, scrolls: board.scrollWidth > board.clientWidth + 1 } : null,
    columns: cols.length,
    visible: b ? cols.filter((c) => c.left >= b.left - 1 && c.right <= b.right + 1).length : 0,
    colW: cols.map((c) => Math.round(c.width)),
    col0: cols[0] ? Math.round(cols[0].left) : null,
    search: Math.round(r(document.querySelector('input[type=search]'))?.left ?? -1),
    active: document.activeElement?.closest('[data-panel]')?.dataset.panel ?? null,
    marked: document.querySelectorAll('[data-board] [aria-current="true"], [data-workbench] ul [aria-current="true"]').length,
    back: !!document.querySelector('[data-panel="detail"] a[href^="/admin/tickets"]:not([aria-label="Close panel"])'),
    close: !!document.querySelector('[data-panel="detail"] a[aria-label="Close panel"]'),
  };
})()`;

/** Controls under 44 px in either direction, inside `scope` (visible ones; scrolled-away board columns count too). */
const SMALL = (scope) => `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const els = [...document.querySelectorAll(${JSON.stringify(scope)})].flatMap((s) => [...s.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button]')]).filter(vis);
  return els.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 44 - 0.5 || r.height < 44 - 0.5; })
    .map((e) => (e.getAttribute('aria-label') || e.innerText || e.tagName).replace(/\\s+/g, ' ').trim().slice(0, 40) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height));
})()`;

const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
const settle = async (sel) => {
  await b.waitFor(`document.querySelector(${JSON.stringify(sel)})`, 10000, sel);
  // The panel's enter animation (0.22 s) and a frame for the layout effects.
  await new Promise((r) => setTimeout(r, 450));
};

try {
  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light';
    let lastVisible = 0;
    for (const size of SIZES) {
      console.log(`\n${size.name} ${theme}`);
      await b.setViewport(size.w, size.h, !!size.mobile);
      await b.send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets ?? NONE }).catch(() => {});
      await b.media({ dark });
      const wide = size.w >= EXPANDED;
      const tag = `${size.name}-${theme}`;

      // The board, nothing open.
      await b.goto('/admin/tickets?view=board', 300);
      await settle('[data-board] [data-column]');
      let s = await b.eval(STATE);
      check('no sideways page scroll (board)', s.docW <= size.w && s.vw === size.w, `${s.docW} <= ${size.w} (layout viewport ${s.vw})`);
      check(`size class ${s.size}`, s.size === (size.w < 600 ? 'compact' : size.w < 1024 ? 'medium' : size.w < 1600 ? 'expanded' : size.w < 2560 ? 'large' : 'xlarge'));
      check(wide ? 'pinned: the page does not scroll down' : 'not pinned (the page scrolls as before)', wide ? s.pinned && s.docH <= s.vh : !s.pinned, `docH ${s.docH} vh ${s.vh}`);
      if (wide) check('the board reaches the window bottom (less the frame padding)', s.board.bottom >= s.vh - 40, `bottom ${Math.round(s.board.bottom)} of ${s.vh}`);
      check('visible columns do not fall as the window widens', s.visible >= lastVisible, `${s.visible} (was ${lastVisible}) of ${s.columns}; widths ${s.colW.join('/')}`);
      lastVisible = s.visible;
      if (size.w >= 600) {
        const even = Math.max(...s.colW) - Math.min(...s.colW);
        check('the columns share the width evenly (a long title never widens its column)', even <= 2, s.colW.join('/'));
      }
      if (size.w >= 1920) {
        check('every column shows, no sideways scroll inside the board', s.visible === s.columns && !s.board.scrolls, `${s.visible}/${s.columns}`);
        check('each column within its min and max (256-640)', s.colW.every((w) => w >= 255 && w <= 641), s.colW.join('/'));
      }
      if (size.w >= 3840) check('the board spans at least 80 % of the screen', s.board.w / s.vw >= 0.8, `${Math.round((s.board.w / s.vw) * 100)} %`);
      await b.shot(`${tag}-board`);
      if (size.mobile) {
        const small = await b.eval(SMALL('[data-panel="queue"]'));
        check('44 px targets on the board (touch)', small.length === 0, small.join(', '));
        check('the first column snaps to the page gutter, in line with the search', Math.abs(s.col0 - s.search) <= 1, `column ${s.col0}, search ${s.search}`);
      }

      // Open the first card of Open.
      const href = await b.eval(`document.querySelector('[data-column="open"] a[href^="/admin/tickets/T-"]')?.getAttribute('href')`);
      await b.clickSel('[data-column="open"] a[href^="/admin/tickets/T-"]');
      await settle('[data-panel="detail"] h1');
      s = await b.eval(STATE);
      check('the address keeps the queue view', s.path.startsWith(href.split('?')[0]) && s.path.includes('view=board'), s.path);
      check('no sideways page scroll (ticket open)', s.docW <= size.w && s.vw === size.w, `${s.docW} <= ${size.w} (layout viewport ${s.vw})`);
      if (wide) {
        const q = s.panels.find((p) => p.id === 'queue');
        const d = s.panels.find((p) => p.id === 'detail');
        check('the ticket opens beside the board', s.split && !!q && !!d && !!s.board, JSON.stringify(s.panels.map((p) => `${p.id}:${Math.round(p.w)}`)));
        check('panels do not overlap', q && d && q.r <= d.l + 0.5, q && d ? `${Math.round(q.r)} <= ${Math.round(d.l)}` : '');
        check('the open card is marked', s.marked === 1, String(s.marked));
        check('the keyboard moved to the ticket', s.active === 'detail', String(s.active));
        check('Close, not Back, beside the board', s.close && !s.back);
        check('still pinned with the ticket open', s.pinned && s.docH <= s.vh, `docH ${s.docH} vh ${s.vh}`);
      } else {
        check('one panel at a time: the ticket in the queue\'s place', !s.split && s.panels.length === 1 && s.panels[0].id === 'detail', JSON.stringify(s.panels.map((p) => p.id)));
        check('Back to the queue', s.back && !s.close);
      }
      await b.shot(`${tag}-ticket`);
      if (size.mobile) {
        const small = await b.eval(SMALL('[data-panel="detail"] header, [data-panel="detail"] > a'));
        check('44 px targets on the ticket header and Back (touch)', small.length === 0, small.join(', '));
      }

      // Back to the queue: Close beside it, Back on a phone or a tablet.
      await b.clickSel(wide ? '[data-panel="detail"] a[aria-label="Close panel"]' : '[data-panel="detail"] a[href^="/admin/tickets"]');
      await settle('[data-board] [data-column]');
      s = await b.eval(STATE);
      check('back on the same queue', s.path === '/admin/tickets?view=board' && !s.panels.some((p) => p.id === 'detail'), s.path);

      // The list.
      await b.goto('/admin/tickets?view=list', 300);
      await settle('[data-panel="queue"] ul li button');
      s = await b.eval(STATE);
      check('no sideways page scroll (list)', s.docW <= size.w && s.vw === size.w, `${s.docW} <= ${size.w} (layout viewport ${s.vw})`);
      if (wide) check('pinned list: the page does not scroll down', s.pinned && s.docH <= s.vh, `docH ${s.docH} vh ${s.vh}`);
      await b.shot(`${tag}-list`);
      if (size.mobile) {
        const small = await b.eval(SMALL('[data-panel="queue"]'));
        check('44 px targets on the list (touch)', small.length === 0, small.join(', '));
      }
    }
  }
} finally {
  await b.close();
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
