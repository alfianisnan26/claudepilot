// T-126 item 5 on the REAL Inbox of a scratch portal: a quota row's times are on the device's own clock, by the same formatter as the Quota
// sheet ("Tue 02:40" across the day boundary), never the server's UTC; the same row in a browser set to UTC reads UTC times. The history is
// a stand-in (`fetch` of `/api/notify/history` answered in the page, with marks as the server writes them); everything else is the portal's
// own. At 390 px (touch) and 1280 px, light and dark; no horizontal scroll.
// usage: QA_PORT=3403 QA_CODE=24681372 node tools/qa/notify-zone.mjs [--shots dir]
import { Browser } from './browser.mjs';

const args = process.argv.slice(2);
if (args.includes('--shots')) process.env.QA_SHOTS = args[args.indexOf('--shots') + 1];

const now = Date.now();
const mark = (ms) => `⟦t:${new Date(ms).toISOString()}⟧`;
const eta = now + 3 * 3_600_000 + 26 * 60_000;
const reset = now + 4 * 3_600_000 + 7 * 60_000;
const item = (id, title, body, bodyMarked, ago) => ({
  id, kind: 'quota_low', at: new Date(now - ago * 60_000).toISOString(), title, body, ...(bodyMarked ? { bodyMarked } : {}),
  path: '/admin/usage?claude=c1', subject: { type: 'claude', id: 'c1' }, readAt: null, resolvedAt: null, resolution: null, muted: false,
});
const page = {
  items: [
    item('nh_1', 'Quota low', 'fadlilah · Session · out by (utc) est. · resets (utc)', `fadlilah · Session · out by ${mark(eta)} est. · resets ${mark(reset)}`, 19),
    item('nh_2', 'Quota low', 'an older row · resets 19:40', null, 90),
  ],
  next: null,
  unread: 2,
};
const STUB = `(() => {
  const body = ${JSON.stringify(JSON.stringify({ data: page }))};
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url, location.href).pathname === '/api/notify/history') return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    return real(input, init);
  };
})();`;

/** What the shared formatter says for `ms` in `tz` (the same rules as zonedTime, worked out here, outside the page). */
function expected(ms, tz) {
  const day = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  if (day(ms) === day(now)) return clock;
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(ms)} ${clock}`;
}

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const b = await Browser.launch();
try {
  await b.signedIn();
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  for (const tz of ['Asia/Jakarta', 'UTC']) {
    await b.send('Emulation.setTimezoneOverride', { timezoneId: tz });
    for (const size of [{ name: 'phone-390', w: 390, h: 844 }, { name: 'desktop-1280', w: 1280, h: 800 }]) {
      for (const dark of [false, true]) {
        const tag = `${tz.replace('/', '-')}-${size.name}-${dark ? 'dark' : 'light'}`;
        await b.setViewport(size.w, size.h);
        await b.media({ dark });
        await b.goto('/admin/notifications', 2500);
        await b.waitFor(`document.body.innerText.includes('fadlilah')`, 15000, 'the Inbox row');
        const r = await b.eval(`({ text: document.body.innerText, scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth })`);
        const want = `fadlilah · Session · out by ${expected(eta, tz)} est. · resets ${expected(reset, tz)}`;
        check(r.text.includes(want), `${tag}: the row reads "${want}"`);
        check(!r.text.includes('(utc)') && !r.text.includes('⟦t:'), `${tag}: no UTC fallback text and no raw mark on screen`);
        check(r.text.includes('an older row · resets 19:40'), `${tag}: a row stored before the change shows its text as it was`);
        check(!r.scroll, `${tag}: no horizontal scroll`);
        await b.shot(`notify-zone-${tag}`);
      }
    }
  }
  check(b.errors.length === 0, `no page errors (${b.errors.slice(0, 2).join(' | ')})`);
} finally {
  await b.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
