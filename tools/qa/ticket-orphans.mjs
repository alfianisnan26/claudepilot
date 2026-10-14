// Orphan tickets (tickets PRD FR18b, T-270) in a real browser and through the API: a ticket whose session ended shows "Its session ended"
// with its time and an ⓘ on the ticket, a red badge on its row, and the "Orphans" chip on the Tickets page; at 390 px (touch) and 1280 px,
// light and dark. Checks: no horizontal scroll, the ⓘ and the chip are tap targets, no page errors. Then the sweep itself: with the delay
// at 1 minute, the track's tickets go to the live session with the same title prefix and the lone one back to the queue (open).
//   PORTAL_LOCAL_ENABLED=true scripts/scratch-portal.sh start 3491
//   QA_PORT=3491 QA_CODE=24681372 QA_SHOTS=/tmp/qa-shots/orphans node tools/qa/ticket-orphans.mjs
//   scripts/scratch-portal.sh stop 3491
import { Browser, SHOTS } from './browser.mjs';
import { api, login, sleep } from './lib.mjs';

const results = [];
const check = (cfg, name, ok, detail = '') => {
  results.push({ cfg, name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${cfg} / ${name}${ok ? '' : ` ${detail}`}`);
};

const cookie = await login();
const call = api(cookie);
const made = async (method, path, body) => {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${path}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.data;
};
await call('POST', '/api/workspaces/local/local/start');
await made('PUT', '/api/settings/tickets.orphanAfterMin', { value: 60 });
const ws = 'local/local';
const track = await made('POST', '/api/chat/sessions', { workspaceId: ws, title: 'Worker: QA track' });
const lone = await made('POST', '/api/chat/sessions', { workspaceId: ws, title: 'Lone' });
const ticket = (summary, sessionId, status) =>
  made('POST', '/api/tickets', { summary, type: 'task', priority: 'high', workspaceId: ws, assignee: { kind: 'session', sessionId } }).then((t) => made('PATCH', `/api/tickets/${t.id}`, { status }));
const t1 = await ticket('Fix the login redirect after a password reset, a summary long enough to wrap on a phone', track.id, 'in_progress');
const t2 = await ticket('Review the redirect fix', track.id, 'in_review');
const t3 = await ticket('Lone work', lone.id, 'in_progress');
await made('POST', `/api/tickets`, { summary: 'A ticket nobody lost', workspaceId: ws });
await made('POST', `/api/chat/sessions/${track.id}/end`);
await made('POST', `/api/chat/sessions/${lone.id}/end`);
await sleep(500);
const seeded = await made('GET', '/api/tickets?orphan=1');
check('api', 'three orphans listed and counted', seeded.items.length === 3 && seeded.counts.orphans === 3, JSON.stringify(seeded.counts));
check('api', 'the orphan names its session and when', seeded.items.every((t) => t.orphan?.why === 'ended' && !!t.orphan.since), JSON.stringify(seeded.items.map((t) => t.orphan)));

const MATRIX = [
  { name: 'phone-390-light', width: 390, height: 844, mobile: true },
  { name: 'phone-390-dark', width: 390, height: 844, mobile: true, dark: true },
  { name: 'desktop-1280-light', width: 1280, height: 800 },
  { name: 'desktop-1280-dark', width: 1280, height: 800, dark: true },
];

for (const cfg of MATRIX) {
  const b = await Browser.launch({ width: cfg.width, height: cfg.height, mobile: !!cfg.mobile, dark: !!cfg.dark });
  const seen = (expr, ms = 8000) => b.waitFor(expr, ms).then(() => true, () => false);
  try {
    await b.cookie(cookie);
    await b.goto(`/admin/tickets/${t1.id}`, 2500);
    check(cfg.name, 'the ticket says its session ended', await seen(`document.body.innerText.includes('Its session ended')`, 30000));
    check(cfg.name, 'with its time', await b.eval(`/Its session ended\\s*·\\s*\\S/.test(document.querySelector('[role=status]')?.innerText ?? '')`));
    check(cfg.name, 'the row badge', await b.eval(`document.body.innerText.includes('Session ended')`));
    const tip = await b.eval(`(() => { const e = document.querySelector('[role=status] button'); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    check(cfg.name, 'the ⓘ is a tap target', !!tip && (cfg.mobile ? tip.w >= 44 && tip.h >= 44 : tip.w >= 24), JSON.stringify(tip));
    check(cfg.name, 'ticket: no horizontal scroll', await b.eval(`document.scrollingElement.scrollWidth <= innerWidth + 1`));
    await b.shot(`${cfg.name}-1-ticket`);
    await b.clickSel('[role=status] button');
    await sleep(400);
    check(cfg.name, 'the ⓘ explains the fallback', await b.eval(`document.body.innerText.includes('moves it by itself')`));
    await b.shot(`${cfg.name}-2-infotip`);
    await b.key('Escape');

    await b.goto('/admin/tickets?view=list', 2500);
    check(cfg.name, 'the Orphans chip with its count', await seen(`[...document.querySelectorAll('button')].some((e) => /^Orphans\\s*3$/.test(e.innerText.trim()))`));
    check(cfg.name, 'the chip is in view without scrolling the row', await b.eval(`(() => { const e = [...document.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith('Orphans')); const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`));
    check(cfg.name, 'list: no horizontal scroll', await b.eval(`document.scrollingElement.scrollWidth <= innerWidth + 1`));
    await b.shot(`${cfg.name}-3-list`, { full: true });
    await b.clickText('Orphans', { selector: 'button' });
    check(cfg.name, 'the chip filters to the orphans', await seen(`location.search.includes('orphan=1') && document.querySelectorAll('main ul > li').length === 3`));
    const chip = await b.eval(`(() => { const e = [...document.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith('Orphans')); const r = e.getBoundingClientRect(); return { h: Math.round(r.height), pressed: e.getAttribute('aria-pressed') }; })()`);
    check(cfg.name, 'the chip is pressed', chip.pressed === 'true', JSON.stringify(chip));
    check(cfg.name, 'filtered: no horizontal scroll', await b.eval(`document.scrollingElement.scrollWidth <= innerWidth + 1`));
    await b.shot(`${cfg.name}-4-orphans`, { full: true });
    check(cfg.name, 'no page errors', (b.errors ?? []).length === 0, (b.errors ?? []).join(' | ').slice(0, 300));
  } catch (e) {
    check(cfg.name, 'scenario ran', false, String(e.message ?? e).slice(0, 300));
    await b.shot(`${cfg.name}-x-error`).catch(() => undefined);
  } finally {
    await b.close();
  }
}

// The sweep: a live session of the same track appears, the delay goes to 1 minute; within about two minutes everything is resolved.
const again = await made('POST', '/api/chat/sessions', { workspaceId: ws, title: 'Worker: QA again' });
await made('PUT', '/api/settings/tickets.orphanAfterMin', { value: 1 });
let left = 3;
for (let i = 0; i < 40 && left; i++) {
  await sleep(5000);
  left = (await made('GET', '/api/tickets?orphan=1')).items.length;
}
check('sweep', 'no orphan left', left === 0, `left ${left}`);
const [a, r2, q] = await Promise.all([t1, t2, t3].map((t) => made('GET', `/api/tickets/${t.id}`)));
check('sweep', 'the track’s tickets went to its live session', a.ticket.assignee?.sessionId === again.id && r2.ticket.assignee?.sessionId === again.id, JSON.stringify([a.ticket.assignee, r2.ticket.assignee]));
check('sweep', 'statuses kept on the successor', a.ticket.status === 'in_progress' && r2.ticket.status === 'in_review');
check('sweep', 'the lone one is back in the queue, open, with the comment', q.ticket.assignee === null && q.ticket.status === 'open' && q.events.some((e) => e.kind === 'comment' && e.actor === 'system' && /back in the queue/.test(e.body ?? '')));
const ev = a.events.filter((e) => e.kind === 'assigned').at(-1);
check('sweep', 'the move is on the timeline', ev?.actor === 'system' && ev?.data?.fallback === true && ev?.data?.reason === 'title', JSON.stringify(ev?.data));
const b = await Browser.launch({ width: 390, height: 844, mobile: true });
try {
  await b.cookie(cookie);
  await b.goto(`/admin/tickets/${t3.id}`, 2500);
  check('sweep', 'the timeline reads the move as a sentence', await b.waitFor(`document.body.innerText.includes('Portal put it back in the queue')`, 15000).then(() => true, () => false));
  check('sweep', 'no orphan line after the move', await b.eval(`!document.querySelector('[role=status]')?.innerText.includes('Its session ended')`));
  await b.shot('phone-390-light-5-after-sweep', { full: true });
} finally {
  await b.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed; shots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
