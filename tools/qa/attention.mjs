// Needs you (docs/prd/attention.md, T-146) in a real browser: the empty state, the rows appearing live after items are seeded through the
// API (an MCP proposal over the Portal MCP, a skill upload, an approval ticket for a person), one row anatomy (title, why chip, who, age,
// risk, the primary action), the nav badge (and on a phone the More button's), and the deep links landing on the exact item (the MCP
// version preselected). At 390 px with touch and 1280 px, light and dark: no sideways scroll, 44 px targets on the phone, every control named.
// Slice 2: the swipe deck (one card per item; a touch swipe left puts it off for an hour and lists it under Later, Back now returns it; a
// short or vertical drag decides nothing; the arrow keys do the same; a swipe right opens the item's own page; `?item=` opens at that card),
// the list marking what is put off, and Home's Review card (count by source, the newest item opening its card in the deck).
// usage: QA_PORT=3531 QA_CODE=24681372 QA_SHOTS=<dir> node tools/qa/attention.mjs   (a scratch portal; it mints a token there, never prints it)
import { AUDIT, Browser, SHOTS } from './browser.mjs';
import { api, BASE, login, sleep } from './lib.mjs';

const cookie = await login();
const call = api(cookie);
const fails = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
const must = async (p, what) => {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.body?.error?.code ?? ''} ${r.body?.error?.message ?? ''}`);
  return r;
};

/* ---------- The empty state, before anything waits ---------- */

const first = (await must(call('GET', '/api/attention'), 'list')).data;
check(first.total === 0, `a clean portal has nothing waiting (${first.total})`);
{
  const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
  try {
    await b.goto('/admin/attention', 2500);
    await b.waitFor(`document.body.innerText.includes('Nothing needs you')`, 10_000, 'the empty state');
    await b.shot('attention-empty-390');
    check(true, 'the empty state says "Nothing needs you"');
  } finally {
    await b.close();
  }
}

/* ---------- Seed what waits, while a page watches: the rows arrive live ---------- */

const watcher = await Browser.launch({ width: 1280, height: 800, cookie });
await watcher.goto('/admin/attention?view=list', 2500);
await watcher.waitFor(`document.body.innerText.includes('Nothing needs you')`, 10_000, 'the empty state (watcher)');

// An approval ticket for a person.
const ticket = (await must(call('POST', '/api/tickets', { summary: 'May the agent rotate the staging deploy key?', type: 'approval', priority: 'high', assignee: { kind: 'user' } }), 'ticket')).data;

// A skill upload (a folder of one SKILL.md): undecided, so it waits.
{
  const form = new FormData();
  form.set('paths', JSON.stringify(['qa-attention-skill/SKILL.md']));
  form.append('files', new Blob(['---\nname: qa-attention-skill\ndescription: A skill the Needs you check uploads.\n---\n\nSay hello.\n'], { type: 'text/markdown' }), 'SKILL.md');
  const r = await fetch(`${BASE}/api/skills/import`, { method: 'POST', headers: { Cookie: `portal_session=${cookie}`, Origin: BASE }, body: form });
  if (r.status >= 300) throw new Error(`skill import: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

// An MCP proposal over the Portal MCP, with an admin token minted for this check (kept in memory, never printed).
let proposedEntry = null;
let proposedVersion = null;
{
  await must(call('PUT', '/api/portal-mcp/settings', { enabled: true }), 'enable the Portal MCP');
  const minted = (await must(call('POST', '/api/portal-mcp/tokens', { label: 'qa-attention', scope: 'admin', expiresIn: '15m', addAnother: true }), 'mint a token')).data;
  const bearer = minted?.secret;
  if (!bearer) throw new Error('the minted token has no value field');
  const rpc = async (id, method, params) => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await r.text();
    const json = text.trimStart().startsWith('{') ? JSON.parse(text) : JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? 'null');
    if (!json || json.error) throw new Error(`${method}: ${r.status} ${JSON.stringify(json?.error ?? text.slice(0, 200))}`);
    return json.result;
  };
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa-attention', version: '1' } });
  const res = await rpc(2, 'tools/call', {
    name: 'mcp_propose_entry',
    arguments: {
      key: 'qa-everything',
      display_name: 'QA everything server',
      kind: 'npm',
      version: '1.0.0',
      spec: { package: '@modelcontextprotocol/server-everything' },
      slots: [{ name: 'EVERYTHING_TOKEN', secret: true, required: true, description: 'A token' }],
      reason: 'The Needs you check proposes it.',
    },
  });
  const out = res.structuredContent ?? JSON.parse(res.content?.[0]?.text ?? '{}');
  proposedEntry = out.proposal?.entry_id;
  proposedVersion = out.proposal?.version_id;
  check(!!proposedEntry && !!proposedVersion, `the MCP proposal was made (${proposedEntry ? 'entry' : 'no entry'}, ${proposedVersion ? 'version' : 'no version'})`);
}

const seeded = (await must(call('GET', '/api/attention'), 'list')).data;
check(seeded.counts.mcp_version === 1 && seeded.counts.skill_version === 1 && seeded.counts.ticket_approval === 1, `the API counts one of each (${JSON.stringify(seeded.counts)})`);
check(seeded.total === seeded.items.length, `the total equals the rows (${seeded.total}/${seeded.items.length})`);
check(!JSON.stringify(seeded).includes(String(cookie)), 'no session value in the list');

try {
  await watcher.waitFor(`document.querySelectorAll('[data-attention-item]').length === ${seeded.total}`, 15_000, 'the rows arriving live');
  check(true, 'the open page updated live, without a reload');
} catch (e) {
  check(false, `the open page updated live: ${e.message}`);
}
await watcher.close();

/* ---------- Every width and theme ---------- */

for (const [width, height] of [[390, 844], [1280, 800]]) {
  for (const dark of [false, true]) {
    const tag = `${width}-${dark ? 'dark' : 'light'}`;
    const b = await Browser.launch({ width, height, dark, mobile: width < 600, cookie });
    try {
      await b.goto('/admin/attention?view=list', 2500);
      await b.waitFor(`document.querySelectorAll('[data-attention-item]').length >= 3`, 10_000, 'the rows');
      await sleep(500);
      const rows = await b.eval(`[...document.querySelectorAll('[data-attention-item]')].map((e) => ({ id: e.dataset.attentionItem, text: e.innerText.replace(/\\s+/g, ' ').slice(0, 160), links: e.querySelectorAll('a[href]').length }))`);
      check(rows.length === seeded.total, `${tag}: one row per item (${rows.length})`);
      check(rows.every((r) => r.links >= 2), `${tag}: every row has its title link and its action`);
      const groups = await b.eval(`[...document.querySelectorAll('section h2')].map((h) => h.innerText.replace(/\\s+/g, ' ').trim())`);
      check(groups.length >= 2 && /^Outside code/.test(groups[0]) && groups.some((g) => /^Question/.test(g)), `${tag}: grouped by why, outside code before a question (${groups.join(' | ')})`);
      const a = await b.eval(AUDIT);
      check(!a.hscroll && a.overflowing.length === 0, `${tag}: no sideways scroll ${a.hscroll ? JSON.stringify(a.hscroll) : ''} ${a.overflowing.join('; ')}`);
      check(a.unnamed.length === 0, `${tag}: every control named ${a.unnamed.join('; ')}`);
      if (width === 390) {
        const small = await b.eval(`[...document.querySelectorAll('[data-attention-item] a[href]:last-child, [role=group][aria-label=Kind] button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 44 || r.width < 44); }).map((e) => (e.getAttribute('aria-label') || e.innerText).slice(0, 40) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))`);
        check(small.length === 0, `${tag}: 44 px targets for the actions and the filter ${small.join('; ')}`);
        const iconOnly = await b.eval(`[...document.querySelectorAll('[data-attention-item] > a:last-child')].every((e) => e.innerText.trim() === '')`);
        check(iconOnly, `${tag}: the primary action is icon-only on a phone`);
        const more = await b.eval(`document.querySelector('[data-tabbar] button[aria-label=More] [data-attention-badge]')?.innerText ?? null`);
        check(more === String(seeded.total), `${tag}: the More button carries the count (${more})`);
      } else {
        const side = await b.eval(`document.querySelector('aside a[href="/admin/attention"] [data-attention-badge]')?.innerText ?? null`);
        check(side === String(seeded.total), `${tag}: the nav item carries the count (${side})`);
      }
      await b.shot(`attention-${tag}`, { full: true });
      if (dark === false) {
        // The filter: one kind only.
        await b.clickSel('[role=group][aria-label=Kind] button', 1);
        await sleep(400);
        const shown = await b.eval(`document.querySelectorAll('[data-attention-item]').length`);
        check(shown === 1, `${tag}: the kind filter keeps one kind (${shown})`);
        await b.shot(`attention-filter-${tag}`);
        await b.clickSel('[role=group][aria-label=Kind] button', 0);
        await sleep(300);
        // Deep links: the MCP row lands on its entry with the version preselected; the ticket row on the ticket.
        await b.clickSel(`[data-attention-item="mcp_version:${proposedVersion}"] > a:last-child`);
        await b.waitFor(`location.pathname.startsWith('/admin/pools/mcp/catalog/')`, 8000, 'the MCP entry page');
        await b.waitFor(`!!document.querySelector('[data-selected]')`, 8000, 'the preselected version');
        const at = await b.eval(`({ path: location.pathname, version: new URLSearchParams(location.search).get('version'), selected: document.querySelector('[data-selected]')?.id })`);
        check(at.path === `/admin/pools/mcp/catalog/${proposedEntry}` && at.selected === `version-${proposedVersion}`, `${tag}: the MCP deep link lands on the entry with that version marked (${at.path} ${at.selected})`);
        await sleep(500);
        await b.shot(`attention-deeplink-mcp-${tag}`);
        await b.goto('/admin/attention?view=list', 2000);
        await b.waitFor(`document.querySelectorAll('[data-attention-item]').length >= 3`, 10_000, 'the rows again');
        await b.clickSel(`[data-attention-item="ticket_approval:${ticket.id}"] > a:last-child`);
        await b.waitFor(`location.pathname === '/admin/tickets/${ticket.id}'`, 8000, 'the ticket page');
        check(true, `${tag}: the ticket deep link lands on ${ticket.id}`);
        await b.goto('/admin/attention?view=list', 2000);
        await b.waitFor(`document.querySelectorAll('[data-attention-item]').length >= 3`, 10_000, 'the rows again');
        await b.clickSel(`[data-attention-item^="skill_version:"] > a:last-child`);
        await b.waitFor(`location.pathname.startsWith('/admin/pools/skills/review/')`, 8000, 'the skill review page');
        check(true, `${tag}: the skill deep link lands on its review page`);
      }
      if (b.errors.length) check(false, `${tag}: page errors ${b.errors.slice(0, 3).join(' | ')}`);
    } finally {
      await b.close();
    }
  }
}

/* ---------- Slice 2: the deck, Later, and Home's Review card ---------- */

const cardKey = `document.querySelector('[data-attention-card]')?.dataset.attentionCard ?? null`;
const position = `document.querySelector('[data-deck-position]')?.innerText.trim() ?? ''`;
const centre = `(() => { const r = document.querySelector('[data-attention-card]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) }; })()`;
const touch = (b, type, x, y) => b.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
/** A one-finger drag from the card's centre by (dx, dy), in steps, as a thumb does it. */
const swipe = async (b, dx, dy = 0) => {
  const c = await b.eval(centre);
  await touch(b, 'touchStart', c.x, c.y);
  for (let i = 1; i <= 10; i++) {
    await touch(b, 'touchMove', c.x + (dx * i) / 10, c.y + (dy * i) / 10);
    await sleep(25);
  }
  await touch(b, 'touchEnd', 0, 0);
  await sleep(500);
};
const waiting = async () => (await must(call('GET', '/api/attention'), 'list')).data;

for (const [width, height] of [[390, 844], [1280, 800]]) {
  for (const dark of [false, true]) {
    const tag = `${width}-${dark ? 'dark' : 'light'}`;
    const b = await Browser.launch({ width, height, dark, mobile: width < 600, cookie });
    try {
      await b.goto('/admin/attention', 2500);
      await b.waitFor(`!!document.querySelector('[data-attention-card]')`, 10_000, 'the deck');
      await sleep(400);
      const first = await b.eval(cardKey);
      check(first === `${seeded.items[0].kind}:${seeded.items[0].id}`, `${tag}: the deck is the way in and opens at the first item (${first})`);
      check((await b.eval(position)).startsWith(`1 of ${seeded.total}`), `${tag}: the deck says where you are (${await b.eval(position)})`);
      const anatomy = await b.eval(`(() => { const c = document.querySelector('[data-attention-card]'); return { title: !!c.querySelector('h2')?.innerText.trim(), time: !!c.querySelector('time'), tip: !!c.querySelector('button[aria-label^="About"]'), touch: getComputedStyle(c).touchAction }; })()`);
      check(anatomy.title && anatomy.time && anatomy.tip, `${tag}: the card shows what, why (with its InfoTip) and how long (${JSON.stringify(anatomy)})`);
      check(anatomy.touch === 'pan-y', `${tag}: the card follows the finger sideways only (touch-action ${anatomy.touch})`);
      const a = await b.eval(AUDIT);
      check(!a.hscroll && a.overflowing.length === 0, `${tag}: deck, no sideways scroll ${a.hscroll ? JSON.stringify(a.hscroll) : ''} ${a.overflowing.join('; ')}`);
      check(a.unnamed.length === 0, `${tag}: deck, every control named ${a.unnamed.join('; ')}`);
      const rubber = await b.eval(`[getComputedStyle(document.documentElement).overscrollBehaviorY, getComputedStyle(document.body).overscrollBehaviorY]`);
      check(rubber.some((v) => v === 'none' || v === 'contain'), `${tag}: the page never rubber-bands (overscroll ${rubber.join('/')})`);
      if (width === 390) {
        const small = await b.eval(`[...document.querySelectorAll('[data-deck-later], [data-deck-act], [data-attention-deck] button[aria-label$="card"], [data-attention-view] button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 44 || r.width < 44); }).map((e) => (e.getAttribute('aria-label') || e.innerText).slice(0, 40) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))`);
        check(small.length === 0, `${tag}: 44 px targets for Later, the action, previous, next and the view switch ${small.join('; ')}`);
      }
      await b.shot(`deck-${tag}`);

      if (!dark && width === 390) {
        // A short drag snaps back, a vertical one is a scroll: neither decides.
        await swipe(b, 60);
        check((await b.eval(cardKey)) === first, `${tag}: a short swipe snaps back (${await b.eval(cardKey)})`);
        await swipe(b, 30, -220);
        check((await b.eval(cardKey)) === first && (await b.eval(`location.pathname`)) === '/admin/attention', `${tag}: a vertical drag decides nothing`);
        // Mid-swipe: the card follows the finger and shows what letting go would do.
        const c = await b.eval(centre);
        await touch(b, 'touchStart', c.x, c.y);
        for (let i = 1; i <= 5; i++) {
          await touch(b, 'touchMove', c.x - 16 * i, c.y);
          await sleep(25);
        }
        const mid = await b.eval(`document.querySelector('[data-attention-card]').style.transform`);
        check(/translateX\(-/.test(mid), `${tag}: the card follows the finger (${mid})`);
        await b.shot(`deck-midswipe-${tag}`);
        // Swipe left: Later, for an hour.
        for (let i = 6; i <= 12; i++) {
          await touch(b, 'touchMove', c.x - 16 * i, c.y);
          await sleep(25);
        }
        await touch(b, 'touchEnd', 0, 0);
        await b.waitFor(`!!document.querySelector('[data-attention-later]')`, 8000, 'the Later list');
        await sleep(400);
        const now1 = await waiting();
        const snoozed = now1.items.filter((i) => i.snoozedUntil);
        const mins = snoozed.length ? Math.round((Date.parse(snoozed[0].snoozedUntil) - Date.now()) / 60_000) : null;
        check(snoozed.length === 1 && `${snoozed[0].kind}:${snoozed[0].id}` === first && mins >= 58 && mins <= 60, `${tag}: a swipe left puts that item off for an hour (${snoozed.length}, ${mins} min)`);
        check(now1.total === seeded.total, `${tag}: put off, it still waits and is counted (${now1.total})`);
        check((await b.eval(cardKey)) !== first && (await b.eval(position)).startsWith(`1 of ${seeded.total - 1}`), `${tag}: the next card takes its place (${await b.eval(position)})`);
        check(/Until/.test(await b.eval(`document.querySelector('[data-attention-later="${first}"]')?.innerText ?? ''`)), `${tag}: Later lists it with the time it comes back`);
        await b.shot(`deck-later-${tag}`, { full: true });
        // The list marks it.
        await b.goto('/admin/attention?view=list', 2000);
        await b.waitFor(`document.querySelectorAll('[data-attention-item]').length >= 3`, 10_000, 'the rows');
        check(await b.eval(`!!document.querySelector('[data-attention-item="${first}"] [data-attention-snoozed]')`), `${tag}: the list marks the item put off`);
        await b.shot(`deck-list-later-${tag}`);
        // Back now.
        await b.goto('/admin/attention', 2000);
        await b.waitFor(`!!document.querySelector('[data-deck-unsnooze]')`, 8000, 'Back now');
        await b.clickSel('[data-deck-unsnooze]');
        await b.waitFor(`!document.querySelector('[data-attention-later]')`, 8000, 'the Later list emptied');
        check((await waiting()).items.every((i) => !i.snoozedUntil), `${tag}: Back now returns it to the deck`);
        // ?item= opens at that card (a push or the Home card); a swipe right opens the item's own page.
        const target = `ticket_approval:${ticket.id}`;
        await b.goto(`/admin/attention?item=${encodeURIComponent(target)}`, 2000);
        await b.waitFor(`!!document.querySelector('[data-attention-card]')`, 8000, 'the deck');
        check((await b.eval(cardKey)) === target, `${tag}: ?item= opens the deck at that card (${await b.eval(cardKey)})`);
        await swipe(b, 260);
        await b.waitFor(`location.pathname === '/admin/tickets/${ticket.id}'`, 8000, 'the ticket page');
        check(true, `${tag}: a swipe right opens the item's own page (/admin/tickets/${ticket.id})`);
      }
      if (!dark && width === 1280) {
        // The keyboard: the arrow keys do what the swipes do; the buttons are always there.
        const k = await b.eval(cardKey);
        await b.focusSel('[data-attention-card]');
        await b.key('ArrowLeft', { code: 'ArrowLeft' });
        await b.waitFor(`!!document.querySelector('[data-attention-later]')`, 8000, 'the Later list');
        check((await waiting()).items.some((i) => `${i.kind}:${i.id}` === k && i.snoozedUntil), `${tag}: the left arrow puts the card off`);
        await b.shot(`deck-later-${tag}`, { full: true });
        await b.clickSel('[data-deck-unsnooze]');
        await b.waitFor(`!document.querySelector('[data-attention-later]')`, 8000, 'the Later list emptied');
        await b.focusSel('[data-attention-card]');
        await b.key('ArrowRight', { code: 'ArrowRight' });
        await b.waitFor(`location.pathname !== '/admin/attention'`, 8000, 'the item page');
        check(true, `${tag}: the right arrow opens the item's own page (${await b.eval('location.pathname')})`);
      }

      // Home's Review card: the count by source, the newest item opening its card in the deck.
      await b.goto('/admin/home', 2500);
      await b.waitFor(`!!document.querySelector('[data-review]')`, 10_000, 'the Review card');
      await sleep(400);
      const review = await b.eval(`(() => { const r = document.querySelector('[data-review]'); return { stats: [...r.querySelectorAll('[aria-label*=":"]')].map((e) => e.getAttribute('aria-label')).filter((l) => !l.startsWith('Newest')), newest: r.querySelector('a[aria-label^="Newest"]')?.getAttribute('href') ?? null }; })()`);
      check(review.stats.includes('MCP: 1') && review.stats.includes('Skills: 1') && review.stats.includes('Tickets: 1'), `${tag}: Review counts by source (${review.stats.join(', ')})`);
      check(!!review.newest && review.newest.startsWith('/admin/attention?item='), `${tag}: the newest item links to its card (${review.newest})`);
      const ra = await b.eval(AUDIT);
      check(!ra.hscroll && ra.unnamed.length === 0, `${tag}: Home, no sideways scroll, every control named ${ra.unnamed.join('; ')}`);
      await b.eval(`document.querySelector('[data-review]').scrollIntoView({ block: 'center' })`);
      await sleep(300);
      await b.shot(`review-${tag}`);
      if (!dark) {
        await b.clickSel('[data-review] a[aria-label^="Newest"]');
        await b.waitFor(`location.pathname === '/admin/attention' && !!document.querySelector('[data-attention-card]')`, 8000, 'the deck from Home');
        const want = decodeURIComponent(review.newest.split('item=')[1]);
        check((await b.eval(cardKey)) === want, `${tag}: a tap on the newest opens the deck at its card (${want})`);
      }
      if (b.errors.length) check(false, `${tag}: page errors ${b.errors.slice(0, 3).join(' | ')}`);
    } finally {
      await b.close();
    }
  }
}

/* ---------- Resolved: the ticket closed, the row leaves ---------- */

await must(call('POST', `/api/tickets/${ticket.id}/close`, { outcome: 'done', summary: 'Decided by the check.' }), 'close the ticket');
const after = (await must(call('GET', '/api/attention'), 'list')).data;
check(after.counts.ticket_approval === 0 && after.total === seeded.total - 1, `closing the ticket resolves its item (${after.total})`);

console.log(fails.length ? `\n${fails.length} failed; screenshots in ${SHOTS}` : `\nall passed; screenshots in ${SHOTS}`);
process.exit(fails.length ? 1 : 0);
