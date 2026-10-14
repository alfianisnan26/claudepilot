// T-255 on the REAL Usage page (Claudes tab) of a scratch portal: a Claude whose usage is unknown says "Unavailable: <why>" and never 0 %, a limit
// a chat reported shows "Limit hit · until <time>" with its source in the ⓘ, a measured Claude shows its percent as before. The usage list is a
// stand-in (`fetch` of `/api/claude-usage` answered in the page: a scratch portal has no plan readings), everything else is the portal's own.
// At 390 px (touch, the iPhone's safe areas) and 1280 px, light and dark; no horizontal scroll; the ⓘ is a 44 px target on touch.
// usage: QA_PORT=3521 QA_CODE=24681372 node tools/qa/usage-unknown.mjs [--shots dir]
import { Browser } from './browser.mjs';
import { sleep } from './lib.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) process.env.QA_SHOTS = shots;

const now = Date.now();
const iso = (min) => new Date(now + min * 60_000).toISOString();
const none = { value: null, basis: 'unavailable', reason: 'no_reading' };
const base = (id, name, over) => ({
  claudeId: id, claudeName: name, workspaceId: 'docker/api', workspaceName: 'api', runsOn: 'plan', state: 'ok', plan: 'max', windows: [], extra: null,
  checkedAt: iso(-1), source: 'probe', stale: false, workspaceRunning: true, problem: null, unavailable: null, limitReport: null, snoozedUntil: null,
  projectionSnoozedUntil: null, slot: null, outlook: { status: none, window: null, etaAt: none, projectedPct: none }, trend: null, ...over,
});
const report = {
  claudes: [
    // one.claude on 2026-10-13: 0 % with no reset time.
    base('one', 'one.claude', { state: 'unknown', unavailable: 'no_reset_time', windows: [{ key: 'session', label: 'Session', usedPct: 0, resetsAt: null, level: 'ok' }, { key: 'week', label: 'Week', usedPct: 0, resetsAt: null, level: 'ok' }] }),
    // A chat said "You've hit your session limit · resets 11pm (UTC)".
    base('two', 'two.claude-with-a-rather-long-name-that-must-wrap', { state: 'exhausted', source: 'live', windows: [{ key: 'session', label: 'Session', usedPct: 100, resetsAt: iso(240), level: 'exhausted' }], limitReport: { window: 'session', label: 'Session', at: iso(-3), until: iso(240), guessed: false, sessionId: 's1' } }),
    base('three', 'regitha', { windows: [{ key: 'session', label: 'Session', usedPct: 41, resetsAt: iso(120), level: 'ok' }, { key: 'week', label: 'Week', usedPct: 22, resetsAt: iso(3000), level: 'ok' }] }),
    base('four', 'rossi', { state: 'unknown', runsOn: 'plan', checkedAt: null, source: null, problem: 'unavailable', unavailable: 'no_usage_endpoint' }),
  ],
  alerts: [],
  thresholds: { warn: 80, critical: 95 },
  intervalMs: 600000,
  now: new Date(now).toISOString(),
};
const STUB = `(() => {
  const body = ${JSON.stringify(JSON.stringify({ data: report }))};
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url, location.href).pathname === '/api/claude-usage') return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
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

const b = await Browser.launch();
try {
  await b.signedIn();
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  for (const size of SIZES) {
    for (const dark of [false, true]) {
      const tag = `${size.name}-${dark ? 'dark' : 'light'}`;
      await b.setViewport(size.w, size.h);
      await b.media({ dark });
      await b.goto('/usage?tab=claudes', 2500);
      try {
        await b.waitFor(`document.getElementById('one')`, 15000, 'the Claudes tab');
      } catch (e) {
        await b.shot(`usage-unknown-${tag}-timeout`);
        console.log('page:', JSON.stringify(await b.eval(`({ url: location.href, text: document.body.innerText.slice(0, 600) })`)));
        console.log('errors:', b.errors.slice(0, 3), 'requests:', b.requests.filter((r) => r.url.includes('/api/')).map((r) => r.url).slice(0, 15));
        throw e;
      }
      const r = await b.eval(`(() => {
        const row = (id) => document.getElementById(id);
        const text = (id) => row(id)?.innerText ?? '';
        const tips = [...row('one').querySelectorAll('button')].filter((x) => /why/i.test(x.getAttribute('aria-label') ?? ''));
        const tip = tips[0]?.getBoundingClientRect();
        return {
          one: text('one'), two: text('two'), three: text('three'), four: text('four'),
          scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          tip: tip ? [tip.width, tip.height] : null,
        };
      })()`);
      check(/Unavailable: no reset time/.test(r.one), `${tag}: one.claude says "Unavailable: no reset time"`);
      check(!/\b0 %/.test(r.one), `${tag}: one.claude shows no 0 % (${JSON.stringify(r.one.replace(/\s+/g, ' ').slice(0, 120))})`);
      check(/Limit hit · until \d{2}:\d{2}/.test(r.two), `${tag}: two.claude says "Limit hit · until <time>"`);
      check(/41 %/.test(r.three) && !/Unavailable/.test(r.three), `${tag}: a measured Claude shows its percent, no "Unavailable"`);
      check(/Unavailable: no usage endpoint/.test(r.four), `${tag}: a Claude with no usage endpoint says so`);
      check(!r.scroll, `${tag}: no horizontal scroll`);
      if (size.w < 600) check(!!r.tip && r.tip[0] >= 44 && r.tip[1] >= 44, `${tag}: the ⓘ is a 44 px target on touch (${JSON.stringify(r.tip)})`);
      // The ⓘ of the report says where it came from.
      const opened = await b.eval(`(() => { const t = [...document.getElementById('two').querySelectorAll('button')].find((x) => /where this comes from/i.test(x.getAttribute('aria-label') ?? '')); t?.click(); return !!t; })()`);
      await sleep(400);
      const tipText = opened ? await b.eval(`document.body.innerText`) : '';
      check(/Limit reported by a chat at \d{2}:\d{2}, until \d{2}:\d{2}/.test(tipText), `${tag}: the report's ⓘ names its source`);
      await b.key('Escape');
      await b.shot(`usage-unknown-${tag}`);
    }
  }
  check(b.errors.length === 0, `no page errors (${b.errors.slice(0, 2).join(' | ')})`);
} finally {
  await b.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
