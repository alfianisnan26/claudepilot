// T-515 on the REAL Workspaces page of a scratch portal: a workspace whose target's API did not answer shows as "Unavailable", its ⓘ says
// the reason and "last seen", and its sheet still lists its Claudes. A scratch portal has no Kubernetes, so the list is the portal's own with
// two stand-in workspaces added, one unavailable and one running (`fetch` of `/api/workspaces` answered in the page, as the server serves it during an outage); everything
// else is the portal's own. At 390 px (touch) and 1280 px, light and dark: no horizontal scroll, the ⓘ is a 44 px target on touch.
// usage: tools/qa/with-portal.sh 3523 node tools/qa/workspace-unavailable.mjs [--shots dir]
import { Browser } from './browser.mjs';
import { sleep } from './lib.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) process.env.QA_SHOTS = shots;

const seen = new Date(Date.now() - 4 * 60_000).toISOString();
const kohi = {
  id: 'kubernetes/kohi-event', name: 'kohi-event', stableId: 'ws_515515515515', target: 'kubernetes', image: 'workspace', status: 'unavailable',
  detail: 'Timed out', lastSeenAt: seen, createdAt: '2026-09-01T00:00:00.000Z',
};
// A scratch portal starts with no workspace: one running beside it, as another target answers during the outage.
const other = { id: 'docker/api', name: 'api', target: 'docker', image: 'workspace', status: 'running', createdAt: '2026-09-01T00:00:00.000Z' };
const claude = { id: 'c515', workspaceId: kohi.id, name: 'Default', directory: '', removedAt: null, createdAt: '2026-09-01T00:00:00.000Z' };
const STUB = `(() => {
  const kohi = ${JSON.stringify(kohi)};
  const other = ${JSON.stringify(other)};
  const claudes = ${JSON.stringify([{ claude, auth: null, terminals: 0 }])};
  const real = window.fetch.bind(window);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    if (path === '/api/workspaces') {
      const body = await (await real(input, init)).json();
      return json({ ...body, data: [...(body.data ?? []).filter((w) => w.id !== kohi.id && w.id !== other.id), other, kohi] });
    }
    if (path === '/api/workspaces/' + kohi.id + '/claudes') {
      const body = await (await real('/api/workspaces')).json();
      return json({ ...body, data: claudes });
    }
    if (path.startsWith('/api/workspaces/' + kohi.id)) return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
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
      await b.goto('/admin/workspaces', 2500);
      try {
        await b.waitFor(`[...document.querySelectorAll('button')].some((x) => /Details for kohi-event/.test(x.getAttribute('aria-label') ?? ''))`, 15000, 'the kohi-event row');
      } catch (e) {
        await b.shot(`workspace-unavailable-${tag}-timeout`);
        console.log('page:', JSON.stringify(await b.eval(`({ url: location.href, text: document.body.innerText.slice(0, 600) })`)));
        console.log('errors:', b.errors.slice(0, 3));
        throw e;
      }
      const r = await b.eval(`(() => {
        const row = [...document.querySelectorAll('li')].find((li) => li.querySelector('button[aria-label^="Details for kohi-event"]'));
        const tip = row?.querySelector('button[aria-label="Why kohi-event is unavailable"]')?.getBoundingClientRect();
        const rows = [...document.querySelectorAll('li')].filter((li) => li.querySelector('button[aria-label^="Details for "]')).length;
        return {
          text: row?.innerText ?? '', rows,
          scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          tip: tip ? [Math.round(tip.width), Math.round(tip.height)] : null,
        };
      })()`);
      check(/Unavailable/.test(r.text), `${tag}: the row says "Unavailable"`);
      check(/Last seen 4 minutes ago/.test(r.text), `${tag}: the row says when it was last seen (${JSON.stringify(r.text.replace(/\s+/g, ' ').slice(0, 120))})`);
      check(!/Timed out/.test(r.text), `${tag}: the reason is in the ⓘ, not on the row (text diet)`);
      check(r.rows >= 2, `${tag}: the other workspaces are listed beside it (${r.rows} rows)`);
      check(!r.scroll, `${tag}: no horizontal scroll`);
      check(!!r.tip && (size.w >= 600 || (r.tip[0] >= 44 && r.tip[1] >= 44)), `${tag}: the ⓘ is there${size.w < 600 ? ', a 44 px target on touch' : ''} (${JSON.stringify(r.tip)})`);
      await b.shot(`workspace-unavailable-${tag}`);

      // The ⓘ: one line, the reason and "last seen".
      await b.clickSel('button[aria-label="Why kohi-event is unavailable"]');
      await sleep(400);
      const body = await b.eval(`document.body.innerText`);
      check(/Timed out · last seen 4 minutes ago/.test(body), `${tag}: the ⓘ says "Timed out · last seen 4 minutes ago"`);
      await b.shot(`workspace-unavailable-${tag}-tip`);
      await b.key('Escape');
      await sleep(300);

      // The sheet: its Claudes stay listed, and Last seen.
      await b.clickSel('button[aria-label^="Details for kohi-event"]');
      await sleep(1200);
      const sheet = await b.eval(`(() => { const d = document.querySelector('[role=dialog]'); return { text: d?.innerText ?? '', scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
      check(/Default/.test(sheet.text) && /Claude/.test(sheet.text), `${tag}: the sheet lists its Claude (${JSON.stringify(sheet.text.replace(/\s+/g, ' ').slice(0, 160))})`);
      check(/Last seen/.test(sheet.text), `${tag}: the sheet says Last seen`);
      check(!sheet.scroll, `${tag}: no horizontal scroll with the sheet open`);
      await b.shot(`workspace-unavailable-${tag}-sheet`);
      await b.key('Escape');
      await sleep(400);
    }
  }
  check(b.errors.length === 0, `no page errors (${b.errors.slice(0, 2).join(' | ')})`);
} finally {
  await b.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
