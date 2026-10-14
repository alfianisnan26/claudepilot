// Needs you (docs/prd/attention.md, T-146) in a real browser: the empty state, the rows appearing live after items are seeded through the
// API (an MCP proposal over the Portal MCP, a skill upload, an approval ticket for a person), one row anatomy (title, why chip, who, age,
// risk, the primary action), the nav badge (and on a phone the More button's), and the deep links landing on the exact item (the MCP
// version preselected). At 390 px with touch and 1280 px, light and dark: no sideways scroll, 44 px targets on the phone, every control named.
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
await watcher.goto('/admin/attention', 2500);
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
      await b.goto('/admin/attention', 2500);
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
        await b.goto('/admin/attention', 2000);
        await b.waitFor(`document.querySelectorAll('[data-attention-item]').length >= 3`, 10_000, 'the rows again');
        await b.clickSel(`[data-attention-item="ticket_approval:${ticket.id}"] > a:last-child`);
        await b.waitFor(`location.pathname === '/admin/tickets/${ticket.id}'`, 8000, 'the ticket page');
        check(true, `${tag}: the ticket deep link lands on ${ticket.id}`);
        await b.goto('/admin/attention', 2000);
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

/* ---------- Resolved: the ticket closed, the row leaves ---------- */

await must(call('POST', `/api/tickets/${ticket.id}/close`, { outcome: 'done', summary: 'Decided by the check.' }), 'close the ticket');
const after = (await must(call('GET', '/api/attention'), 'list')).data;
check(after.counts.ticket_approval === 0 && after.total === seeded.total - 1, `closing the ticket resolves its item (${after.total})`);

console.log(fails.length ? `\n${fails.length} failed; screenshots in ${SHOTS}` : `\nall passed; screenshots in ${SHOTS}`);
process.exit(fails.length ? 1 : 0);
