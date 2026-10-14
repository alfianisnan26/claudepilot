// T-126 items 1 and 2 on a REAL scratch portal. (1) "Alert when idle too" in a Claude's alert menu (Usage, Claudes tab) turns the person's
// watch on and off through the real `/api/notify/quota-watch` route, and the menu says the state it is in. (2) The Inbox shows a quota alert
// as one row naming who it concerns ("· 1 chat") and a closed one as Recovered. The usage report and the Inbox page are stand-ins (`fetch`
// answered in the page: a scratch portal has no plan readings); the watch route and everything else are the portal's own.
// At 390 px (touch) and 1280 px, light and dark; no horizontal scroll.
// usage: QA_PORT=3403 QA_CODE=24681372 [QA_SHOTS=dir] node tools/qa/notify-quota.mjs
import { Browser } from './browser.mjs';
import { sleep } from './lib.mjs';

const now = Date.now();
const iso = (min) => new Date(now + min * 60_000).toISOString();
const none = { value: null, basis: 'unavailable', reason: 'no_reading' };
const claude = {
  claudeId: 'qa_c1', claudeName: 'fadlilah', workspaceId: 'docker/api', workspaceName: 'api', runsOn: 'plan', state: 'near', plan: 'max', extra: null,
  windows: [{ key: 'session', label: 'Session', usedPct: 96, resetsAt: iso(240), level: 'critical' }, { key: 'week', label: 'Week', usedPct: 30, resetsAt: iso(3000), level: 'ok' }],
  checkedAt: iso(-1), source: 'probe', stale: false, workspaceRunning: true, problem: null, unavailable: null, limitReport: null, snoozedUntil: null,
  projectionSnoozedUntil: null, slot: null, outlook: { status: none, window: null, etaAt: none, projectedPct: none }, trend: null,
};
const report = { claudes: [claude], alerts: [], thresholds: { warn: 80, critical: 95 }, intervalMs: 600000, now: new Date(now).toISOString() };
const row = (id, ago, body, over = {}) => ({
  id, kind: 'quota_low', at: new Date(now - ago * 60_000).toISOString(), title: 'Quota low', body, path: '/admin/usage?claude=qa_c1',
  subject: { type: 'claude', id: 'qa_c1' }, readAt: null, resolvedAt: null, resolution: null, muted: false, ...over,
});
const inbox = {
  items: [
    row('nh_1', 2, 'fadlilah · Session · 4 % left · resets 19:40 UTC · 1 chat'),
    row('nh_2', 400, 'fadlilah · Week · 5 % left · resets 08:00 UTC · 2 chats', { readAt: iso(-300), resolvedAt: iso(-200), resolution: 'Recovered' }),
  ],
  next: null,
  unread: 1,
};
const STUB = `(() => {
  const answer = (v) => Promise.resolve(new Response(JSON.stringify({ data: v }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const report = ${JSON.stringify(report)};
  const inbox = ${JSON.stringify(inbox)};
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const path = new URL(url, location.href).pathname;
    if (path === '/api/claude-usage') return answer(report);
    if (path === '/api/notify/history' && (!init || !init.method || init.method === 'GET')) return answer(inbox);
    return real(input, init);
  };
})();`;

const SIZES = [
  { name: 'phone-390', w: 390, h: 844 },
  { name: 'desktop-1280', w: 1280, h: 800 },
];
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const watchNow = (b) => b.eval(`fetch('/api/notify/quota-watch/qa_c1').then((r) => r.json()).then((j) => j.data ? j.data.watch : 'status ' + JSON.stringify(j))`);
const menuItems = (b) => b.eval(`[...document.querySelectorAll('[role=menuitem]')].map((x) => x.innerText.trim())`);
const openMenu = async (b) => {
  const ok = await b.eval(`(() => { const t = document.querySelector('button[aria-label^="Snooze fadlilah"]'); t?.click(); return !!t; })()`);
  await sleep(300);
  return ok;
};

const b = await Browser.launch();
try {
  await b.signedIn();
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  for (const size of SIZES) {
    for (const dark of [false, true]) {
      const tag = `${size.name}-${dark ? 'dark' : 'light'}`;
      await b.setViewport(size.w, size.h);
      await b.media({ dark });

      // (1) the Claude's alert menu
      await b.goto('/admin/usage?tab=claudes&claude=qa_c1', 2500);
      await b.waitFor(`document.getElementById('qa_c1')`, 15000, 'the Claudes tab');
      if (!(await b.eval(`!!document.querySelector('button[aria-label^="Snooze fadlilah"]')`))) {
        await b.eval(`document.getElementById('qa_c1').querySelector('button[aria-expanded]')?.click()`);
        await sleep(600);
      }
      await b.waitFor(`!!document.querySelector('button[aria-label^="Snooze fadlilah"]')`, 8000, 'the alert menu');
      const target = await b.eval(`(() => { const r = document.querySelector('button[aria-label^="Snooze fadlilah"]').getBoundingClientRect(); return [r.width, r.height]; })()`);
      // Known and not this ticket's: every @isnanme/ui Menu trigger is size-9 (36 px), so this one is too. Said, not counted, until the
      // library's trigger grows (reported on T-126).
      if (size.w < 600 && !(target[0] >= 44 && target[1] >= 44)) console.log(`WARN ${tag}: the alert menu's trigger is ${JSON.stringify(target)} px, under 44 (the shared Menu's size-9)`);
      check((await watchNow(b)) === false, `${tag}: the watch starts off (the real route)`);
      await openMenu(b);
      let items = await menuItems(b);
      check(items.includes('Alert when idle too') && !items.includes('Alert only with a chat'), `${tag}: the menu offers "Alert when idle too" (${JSON.stringify(items)})`);
      await b.shot(`notify-quota-menu-${tag}`);
      await b.clickText('Alert when idle too', { exact: true });
      await sleep(500);
      check((await watchNow(b)) === true, `${tag}: choosing it turns the watch on`);
      await openMenu(b);
      items = await menuItems(b);
      check(items.includes('Alert only with a chat') && !items.includes('Alert when idle too'), `${tag}: the menu now offers "Alert only with a chat"`);
      await b.clickText('Alert only with a chat', { exact: true });
      await sleep(500);
      check((await watchNow(b)) === false, `${tag}: and that turns it off again`);
      check(!(await b.eval(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)), `${tag}: Usage, no horizontal scroll`);

      // (2) the Inbox
      await b.goto('/admin/notifications', 2500);
      await b.waitFor(`document.body.innerText.includes('fadlilah')`, 15000, 'the Inbox rows');
      const r = await b.eval(`({ text: document.body.innerText, scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth })`);
      check(/fadlilah · Session · 4\s?% left · resets 19:40 UTC · 1 chat/.test(r.text), `${tag}: the open row names who it concerns ("· 1 chat")`);
      check(/Recovered/.test(r.text), `${tag}: the closed row says Recovered`);
      check(!r.scroll, `${tag}: Inbox, no horizontal scroll`);
      await b.shot(`notify-quota-inbox-${tag}`);
    }
  }
  check(b.errors.length === 0, `no page errors (${b.errors.slice(0, 2).join(' | ')})`);
} finally {
  await b.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
