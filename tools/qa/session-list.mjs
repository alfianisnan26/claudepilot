// The Sessions list as a card (T-100, 2026-10-13, the owner's iPhone): over 360, 390, 430 and 1280 px, light and dark, with the iPhone's safe areas
// emulated and touch on the phones, against a scratch portal seeded with sessions in every group (a long title, a long branch, Pinned, Needs you,
// Working with Bypass, Idle, Ended for safety). It asserts:
//   - no row paints outside its rounded card, at rest and mid-swipe: every painted layer of a row (the row, the swipe panes, a selection) lies
//     inside the card, one that reaches a corner is clipped to the curve, one as wide as the card paints the card's colour; a pixel check at the
//     four corners of each card (just outside the curve) finds the page behind it, not a row;
//   - the chips run Needs you, In progress, Idle, Pinned, Ended (each only when not empty), All last; the page opens on the first chip with rows;
//   - in All the rows sit under headings in that order, each with its count; Needs you has no fold;
//   - a row's ⋯ menu opens past its row and card with every item reachable (nothing clips it at rest);
//   - nothing scrolls sideways (only the chip row does); 44 px targets for the chips and the group headings on touch screens.
// usage: scripts/scratch-portal.sh start 3461 && QA_PORT=3461 QA_CODE=24681372 node tools/qa/session-list.mjs [--shots dir] [--seed-only]
//   It seeds /tmp/scratch-portal-$QA_PORT/data/portal.db (SL_DB overrides) with rows titled "QA list …" and removes them again at the end.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const dbPath = process.env.SL_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`;
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};

// --- seed -------------------------------------------------------------------------------------------------------------------------------
const db = new DatabaseSync(dbPath, { timeout: 10000 });
const purge = () => db.exec("DELETE FROM chat_requests WHERE session_id LIKE 'qalist-%'; DELETE FROM chat_sessions WHERE id LIKE 'qalist-%'");
purge();
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ins = db.prepare(`INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, process, model, mode, cost_est_usd, launch, created_at,
  last_activity_at, ended_reason, pinned_at, worktree_path, worktree_branch, worktree_repo) VALUES (?, 'docker/qa-list', ?, ?, 'ui', ?, ?, 'gone', 'claude-opus-5-5', ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)`);
const LONG_BRANCH = 'dev/t100-a-very-long-branch-name-that-does-not-fit-on-a-phone-at-all';
const seed = [
  { title: 'QA list approval waits on an answer for the release of the portal', state: 'waiting', ask: true },
  { title: 'QA list working with Bypass on', state: 'working', mode: 'bypassPermissions', cost: 1.24 },
  { title: 'QA list pinned and idle with a very long title that has to wrap or truncate on a narrow phone screen', state: 'idle', pinned: true, branch: LONG_BRANCH },
  { title: 'QA list pinned, ended', state: 'ended', pinned: true },
  { title: 'QA list idle', state: 'idle' },
  { title: 'QA list idle, a worktree', state: 'idle', branch: 'dev/short' },
  { title: 'QA list ended for safety', state: 'ended', ended: 'credential: a key showed up in a tool result' },
  { title: 'QA list ended', state: 'ended', ended: 'ended by you' },
];
seed.forEach((s, i) => {
  const id = `qalist-${i}-${randomUUID().slice(0, 8)}`;
  const at = iso(now - i * 60_000);
  ins.run(id, s.branch ? `/home/node/work/x.worktrees/${s.branch.replaceAll('/', '-')}` : '/home/node', s.title, s.state, at, s.mode ?? 'default', s.cost ?? 0, at, at, s.ended ?? null,
    s.pinned ? at : null, s.branch ? `/home/node/work/x.worktrees/${s.branch.replaceAll('/', '-')}` : null, s.branch ?? null, s.branch ? '/home/node/work/x' : null);
  if (s.ask)
    db.prepare(`INSERT INTO chat_requests (session_id, request_id, kind, tool_name, title, detail, created_at) VALUES (?, 'r1', 'tool', 'Bash', 'Run a command', 'npm run deploy', ?)`).run(id, at);
});
if (args.includes('--seed-only')) process.exit(0);

// --- the browser --------------------------------------------------------------------------------------------------------------------------
const IPHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const SIZES = [
  { name: '360', w: 360, h: 740, mobile: true, insets: { top: 24, bottom: 16, left: 0, right: 0 } },
  { name: '390', w: 390, h: 844, mobile: true, insets: IPHONE },
  { name: '430', w: 430, h: 932, mobile: true, insets: IPHONE },
  { name: '1280', w: 1280, h: 900, mobile: false, insets: { top: 0, bottom: 0, left: 0, right: 0 } },
];
const ORDER = ['Needs you', 'In progress', 'Idle', 'Pinned', 'Ended'];
const cookie = await login();
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);

/**
 * Every card of session rows and what paints inside it. A painted layer (a background of its own) must lie inside the card; one that reaches a
 * corner must be clipped to the curve there (its own radius, or an ancestor inside the card that clips with one); one as wide as the card must
 * paint the card's own colour (else the row shows as a band of another colour: the pin and chips "on a different background").
 */
const GEOMETRY = `(() => {
  const out = [];
  for (const ul of document.querySelectorAll('ul[data-session-rows]')) {
    const box = ul.parentElement;
    const r = box.getBoundingClientRect(); const cs = getComputedStyle(box);
    const R = parseFloat(cs.borderTopLeftRadius), bw = parseFloat(cs.borderLeftWidth);
    const corners = [['TopLeft', 'l', 't'], ['TopRight', 'r', 't'], ['BottomLeft', 'l', 'b'], ['BottomRight', 'r', 'b']];
    const layers = [];
    for (const el of ul.querySelectorAll('li, li *')) {
      const s = getComputedStyle(el);
      const paints = (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') || s.backgroundImage !== 'none';
      if (!paints) continue;
      const q = el.getBoundingClientRect();
      if (q.width === 0 || q.height === 0) continue;
      // What it paints: its box, cut by every ancestor inside the card that clips (the swipe box while the row moves).
      const qq = { l: q.left, t: q.top, r: q.right, b: q.bottom };
      for (let p = el.parentElement; p && p !== box; p = p.parentElement) {
        if (getComputedStyle(p).overflow === 'visible') continue;
        const c = p.getBoundingClientRect();
        qq.l = Math.max(qq.l, c.left); qq.t = Math.max(qq.t, c.top); qq.r = Math.min(qq.r, c.right); qq.b = Math.min(qq.b, c.bottom);
      }
      if (qq.r <= qq.l || qq.b <= qq.t) continue;
      const unclipped = [];
      for (const [name, x, y] of corners) {
        // The layer's point nearest the card's corner (its own corner, moved in along the diagonal by its own radius) must lie inside the
        // card's inner curve: the circle of radius R - bw about the curve's centre. A layer far enough in (an icon) passes on its own.
        const rho = parseFloat(s['border' + name + 'Radius']) || 0;
        const k = rho * (1 - Math.SQRT1_2);
        const px = x === 'l' ? qq.l + k : qq.r - k, py = y === 't' ? qq.t + k : qq.b - k;
        const cx = x === 'l' ? r.left + R : r.right - R, cy = y === 't' ? r.top + R : r.bottom - R;
        const inCorner = (x === 'l' ? px < cx : px > cx) && (y === 't' ? py < cy : py > cy);
        if (!inCorner || Math.hypot(px - cx, py - cy) <= R - bw + 0.75) continue;
        let ok = false;
        for (let p = el.parentElement; !ok && p && p !== box; p = p.parentElement) {
          const ps = getComputedStyle(p);
          ok = ps.overflow !== 'visible' && parseFloat(ps['border' + name + 'Radius']) >= R - bw - 1;
        }
        if (!ok) unclipped.push(name);
      }
      const wide = q.width >= r.width - 2 * bw - 1;
      layers.push({ ...qq, unclipped, wide, bg: s.backgroundColor, cls: String(el.className).slice(0, 50) });
    }
    out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom, R, bw, bg: cs.backgroundColor, layers });
  }
  return out;
})()`;

/** The colours at the four corners of each container, just outside the curve, and just outside the box (the page behind it), from a real screenshot. */
async function cornerPixels(boxes) {
  const shot = await b.send('Page.captureScreenshot', { format: 'png' });
  const pts = boxes.flatMap((x, i) => {
    const k = 3; // 3 px in from the box's corner: outside a 24 px curve, inside the box
    return [
      { i, at: 'top left', x: x.l + k, y: x.t + k, bx: x.l + k, by: x.t - 3 },
      { i, at: 'top right', x: x.r - k - 1, y: x.t + k, bx: x.r - k - 1, by: x.t - 3 },
      { i, at: 'bottom left', x: x.l + k, y: x.b - k - 1, bx: x.l + k, by: x.b + 2 },
      { i, at: 'bottom right', x: x.r - k - 1, y: x.b - k - 1, bx: x.r - k - 1, by: x.b + 2 },
    ];
  });
  return b.eval(`(async () => {
    const img = new Image(); img.src = 'data:image/png;base64,${shot.data}'; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const px = (x, y) => (x < 0 || y < 0 || x >= c.width || y >= c.height) ? null : [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
    return ${JSON.stringify(pts)}.map((p) => ({ ...p, in: px(p.x, p.y), behind: px(p.bx, p.by) }));
  })()`);
}

const chips = () => b.eval(`[...document.querySelectorAll('[data-chip]')].map((e) => ({ id: e.dataset.chip, label: e.getAttribute('aria-label') ?? e.textContent.trim(), on: e.getAttribute('aria-pressed') === 'true', h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width }))`);
const near = (a, c) => !!a && !!c && a.every((v, k) => Math.abs(v - c[k]) <= 6);

for (const size of SIZES)
  for (const dark of [false, true]) {
    const tag = `${size.name}-${dark ? 'dark' : 'light'}`;
    console.log(tag);
    await b.setViewport(size.w, size.h, size.mobile);
    await b.send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets }).catch(() => {});
    await b.media({ dark });
    await b.eval(`localStorage.removeItem('claudepilot.sessions-view')`).catch(() => {});
    await b.goto('/admin/sessions', 2500);
    await b.waitFor(`document.querySelectorAll('ul[data-session-rows] li').length > 0`, 8000, 'rows').catch(() => {});

    // The chips: in order, only the non-empty ones, All last; the page opens on the first.
    const c = await chips();
    const ids = c.map((x) => x.id);
    check(`${tag}: chips in the order of attention, All last`, JSON.stringify(ids) === JSON.stringify(['attention', 'working', 'idle', 'pinned', 'ended', 'all']), JSON.stringify(ids));
    check(`${tag}: opens on the first chip (Needs you)`, c[0]?.on === true, JSON.stringify(c.filter((x) => x.on).map((x) => x.id)));
    if (size.mobile) check(`${tag}: chips are 44 px targets`, c.every((x) => x.h >= 44 && x.w >= 44), JSON.stringify(c.map((x) => [x.id, Math.round(x.w), Math.round(x.h)])));
    check(`${tag}: In progress is named so`, c.find((x) => x.id === 'working')?.label.includes('In progress') === true, String(c.find((x) => x.id === 'working')?.label));

    const geometry = async (where, moving = false) => {
      const g = await b.eval(GEOMETRY);
      check(`${tag} ${where}: a card around the rows`, g.length > 0, String(g.length));
      for (const [i, x] of g.entries()) {
        const out = x.layers.filter((q) => q.l < x.l - 0.5 || q.r > x.r + 0.5 || q.t < x.t - 0.5 || q.b > x.b + 0.5);
        check(`${tag} ${where} #${i}: no painted layer outside the card`, out.length === 0, JSON.stringify(out.slice(0, 2)));
        const square = x.layers.filter((q) => q.unclipped.length);
        check(`${tag} ${where} #${i}: what reaches a corner follows its curve`, square.length === 0, JSON.stringify(square.slice(0, 2).map((q) => [q.cls, q.unclipped])));
        if (!moving) {
          const band = x.layers.filter((q) => q.wide && q.bg !== x.bg);
          check(`${tag} ${where} #${i}: rows show the card's own colour`, band.length === 0, JSON.stringify(band.slice(0, 2).map((q) => [q.cls, q.bg, x.bg])));
        }
      }
      const px = await cornerPixels(g.filter((x) => x.b <= size.h - 4 && x.t >= 4));
      const bad = px.filter((p) => p.behind && !near(p.in, p.behind));
      check(`${tag} ${where}: the corners show the page, not a row`, bad.length === 0, JSON.stringify(bad.slice(0, 2).map((p) => ({ i: p.i, at: p.at, in: p.in, behind: p.behind }))));
    };
    await geometry('Needs you');

    // Mid-swipe (the panes behind the row show): the first row of the first card, held 60 px to the right, still inside the curve.
    if (size.mobile) {
      const at = await b.eval(`(() => { const a = document.querySelector('ul[data-session-rows] > li a[href^="/admin/sessions/"]'); if (!a) return null; const r = a.getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + 12) }; })()`);
      if (at) {
        const touch = (type, x, y) => b.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
        await touch('touchStart', at.x, at.y);
        for (let k = 1; k <= 6; k++) {
          await touch('touchMove', at.x + k * 10, at.y);
          await sleep(30);
        }
        await sleep(150);
        check(`${tag}: the row moves under the finger`, (await b.eval(`!!document.querySelector('[data-swipe=moving]')`)) === true);
        await geometry('mid-swipe', true);
        // Back to where it started before letting go: nothing is pinned by the check.
        for (let k = 5; k >= 0; k--) {
          await touch('touchMove', at.x + k * 10, at.y);
          await sleep(30);
        }
        await touch('touchEnd', 0, 0);
        await sleep(400);
      }
    }

    // All: the rows under headings in the same order, each with its count; Needs you has no fold.
    await b.eval(`document.querySelector('[data-chip=all]')?.click()`);
    await sleep(600);
    const heads = await b.eval(`[...document.querySelectorAll('[data-status-group]')].map((e) => ({ id: e.dataset.statusGroup, title: e.querySelector('[data-group-title]')?.textContent.trim(), count: e.querySelector('[data-group-count]')?.textContent.trim(), fold: !!e.querySelector('[data-group-head]')?.matches('button[aria-expanded]'), h: e.querySelector('[data-group-head]')?.getBoundingClientRect().height ?? 0 }))`);
    check(`${tag} All: grouped under the headings in order`, JSON.stringify(heads.map((h) => h.title)) === JSON.stringify(ORDER), JSON.stringify(heads.map((h) => h.title)));
    check(`${tag} All: each heading has its count`, heads.every((h) => /^\d+$/.test(h.count ?? '')), JSON.stringify(heads.map((h) => h.count)));
    check(`${tag} All: Needs you has no fold, the others do`, heads.length > 0 && !heads[0].fold && heads.slice(1).every((h) => h.fold));
    if (size.mobile) check(`${tag} All: headings are 44 px targets`, heads.every((h) => h.h >= 44), JSON.stringify(heads.map((h) => Math.round(h.h))));
    // innerWidth too: a phone in emulation widens its layout to fit an overflow, so scrollWidth alone never sees it (T-288).
    check(`${tag}: no sideways scroll`, (await b.eval(`document.scrollingElement.scrollWidth <= innerWidth && innerWidth <= ${size.w}`)) === true, await b.eval('`${document.scrollingElement.scrollWidth}/${innerWidth}`'));
    await geometry('All');

    // A row's ⋯ menu opens past its row and its card: every item can be tapped (T-100: the swipe box's clip cut it to the first item).
    const menu = await b.eval(`(async () => {
      const t = document.querySelectorAll('ul[data-session-rows] li button[aria-haspopup=menu]')[1]; if (!t) return null;
      t.click(); await new Promise((r) => setTimeout(r, 400));
      const m = document.querySelector('[role=menu]'); if (!m) return { items: [] };
      const items = [...m.querySelectorAll('[role=menuitem]')].map((it) => { const q = it.getBoundingClientRect(); const e = document.elementFromPoint(q.left + 12, q.top + q.height / 2); return [it.textContent.trim(), !!e && m.contains(e)]; });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await new Promise((r) => setTimeout(r, 250));
      return { items };
    })()`);
    check(`${tag} All: a row's menu opens whole, every item reachable`, !!menu && menu.items.length > 0 && menu.items.every(([, hit]) => hit), JSON.stringify(menu));
    if (shots) {
      await b.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: Math.max(size.h, 1400), deviceScaleFactor: 1, mobile: size.mobile });
      await sleep(400);
      const r = await b.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(shots, `t100-${tag}.png`), Buffer.from(r.data, 'base64'));
      await b.setViewport(size.w, size.h, size.mobile);
    }

    // A heading folds and unfolds.
    await b.eval(`document.querySelector('[data-status-group=idle] button[data-group-head]')?.click()`);
    await sleep(300);
    check(`${tag} All: Idle folds`, (await b.eval(`!document.querySelector('[data-status-group=idle] ul[data-session-rows]')`)) === true);
    await b.eval(`document.querySelector('[data-status-group=idle] button[data-group-head]')?.click()`);
    await sleep(200);
  }

await b.close();
purge();
console.log(`${failed ? 'FAILED' : 'passed'}: ${failed} failing`);
process.exit(failed ? 1 : 0);
