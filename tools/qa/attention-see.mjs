// Needs you, slice 3 (docs/prd/attention.md §9, T-146): the persona proposal source and the coordinator's "see" view, on a scratch portal.
// - A persona proposal (an agent's change to its persona's instructions) waits: the API lists it once (gate, the size of the change, never
//   its text); the deck opens at its card from `?item=`; the card's action lands on the Personas tab with the proposals dialog open and that
//   proposal marked; closing the dialog drops `?proposal=`; rejecting it on the module's own route resolves it. At 390 px with touch and
//   1280 px, light and dark: no sideways scroll, every control named, 44 px targets on the phone.
// - `attention_list` over the Portal MCP: an admin token decides no approval ticket (absent with the default scope), and sees it with
//   `scope: "see"`; the summary names the scope.
// The proposal is written straight into the portal's database (an agent's proposal needs an agent token bound to a live session, which a
// scratch portal has none of); the portal reads the registry fresh on each request, so the row is listed at once.
// usage: QA_PORT=3532 QA_CODE=24681372 QA_SHOTS=<dir> node tools/qa/attention-see.mjs   (data dir /tmp/scratch-portal-<port>/data)
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AUDIT, Browser, SHOTS } from './browser.mjs';
import { api, BASE, login, PORT, sleep } from './lib.mjs';

const cookie = await login();
const call = api(cookie);
const fails = [];
let checks = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
const must = async (p, what) => {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.body?.error?.code ?? ''} ${r.body?.error?.message ?? ''}`);
  return r;
};
const waiting = async () => (await must(call('GET', '/api/attention'), 'list')).data;

/* ---------- The coordinator's view: attention_list scope see ---------- */

const ticket = (await must(call('POST', '/api/tickets', { summary: 'May the agent rotate the staging deploy key?', type: 'approval', priority: 'high', assignee: { kind: 'user' } }), 'ticket')).data;
{
  await must(call('PUT', '/api/portal-mcp/settings', { enabled: true }), 'enable the Portal MCP');
  const minted = (await must(call('POST', '/api/portal-mcp/tokens', { label: 'qa-attention-see', scope: 'admin', expiresIn: '15m', addAnother: true }), 'mint a token')).data;
  const bearer = minted?.secret;
  if (!bearer) throw new Error('the minted token has no value field');
  let n = 0;
  const rpc = async (method, params) => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
    });
    const text = await r.text();
    const json = text.trimStart().startsWith('{') ? JSON.parse(text) : JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? 'null');
    if (!json || json.error) throw new Error(`${method}: ${r.status} ${JSON.stringify(json?.error ?? text.slice(0, 200))}`);
    return json.result;
  };
  const tool = async (args) => {
    const res = await rpc('tools/call', { name: 'attention_list', arguments: args });
    // The summary is the text's first line; structuredContent carries the rest (portalmcp/server.ts).
    const text = res.content?.[0]?.text ?? '';
    const nl = text.indexOf('\n');
    return { ...(res.structuredContent ?? JSON.parse(nl < 0 ? '{}' : text.slice(nl + 1))), summary: nl < 0 ? text : text.slice(0, nl) };
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa-attention-see', version: '1' } });
  const key = `ticket_approval:${ticket.id}`;
  const decide = await tool({});
  check(decide.scope === 'decide' && !decide.items.some((i) => i.item === key), `attention_list: a token decides no approval ticket (scope ${decide.scope}, ${decide.items.length} rows)`);
  check(/scope see/.test(decide.summary ?? '') || decide.items.length > 0, `attention_list: an empty decide view points to scope see (${decide.summary})`);
  const see = await tool({ scope: 'see' });
  check(see.scope === 'see' && see.items.some((i) => i.item === key), `attention_list scope see: the token sees the approval ticket that blocks it (${see.items.map((i) => i.item).join(', ')})`);
  check(see.counts?.ticket_approval === 1, `attention_list scope see: counted once (${JSON.stringify(see.counts)})`);
  const one = await tool({ scope: 'see', item: key, full: true });
  check(one.item?.page === `/admin/tickets/${ticket.id}`, `attention_list scope see: one item with its page (${one.item?.page})`);
}

/* ---------- A persona proposal waits ---------- */

const persona = (await must(call('POST', '/api/pools/persona', { name: 'QA persona', content: { instructions: 'Be careful.', styles: [], defaultStyle: null, agents: [], model: null, effort: null, chatPrompt: '', contexts: [] } }), 'persona')).data;
const proposalId = randomUUID();
{
  const db = new DatabaseSync(`/tmp/scratch-portal-${PORT}/data/portal.db`, { timeout: 10_000 });
  const marker = `QA-PROPOSED-TEXT-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO persona_proposals (id, pool_id, kind, status, actor, workspace_id, session_id, reason, payload, fingerprint, base_revision, created_at)
     VALUES (?, ?, 'instructions', 'pending', 'session:qa-agent', 'docker/qa', 'qa-agent', 'clearer rules', ?, ?, 1, ?)`,
  ).run(proposalId, persona.id, JSON.stringify({ edits: { append: `\n${marker}` }, after: `Be careful.\n${marker}` }), `qa-${proposalId}`, new Date(Date.now() - 5 * 60_000).toISOString());
  db.close();
  const list = await waiting();
  const item = list.items.find((i) => i.kind === 'persona_proposal');
  check(list.counts.persona_proposal === 1 && item?.id === proposalId, `the API lists the persona proposal once (${JSON.stringify(list.counts)})`);
  check(item?.why === 'gate' && /^instructions · adds \d+ chars/.test(item?.risk ?? ''), `the item says why and what changes (${item?.why}; ${item?.risk})`);
  check(!JSON.stringify(list).includes(marker), 'the proposed text itself is not in the list');
  check(item?.link === `/admin/pools?tab=personas&proposal=${proposalId}`, `the item links to the proposal (${item?.link})`);
}

/* ---------- The deck and the deep link, every width and theme ---------- */

const cardKey = `document.querySelector('[data-attention-card]')?.dataset.attentionCard ?? null`;
const deckPath = `/admin/attention?item=${encodeURIComponent(`persona_proposal:${proposalId}`)}`;
for (const [width, height] of [[390, 844], [1280, 800]]) {
  for (const dark of [false, true]) {
    const tag = `${width}-${dark ? 'dark' : 'light'}`;
    const b = await Browser.launch({ width, height, dark, mobile: width < 600, cookie });
    try {
      await b.goto(deckPath, 2500);
      await b.waitFor(`!!document.querySelector('[data-attention-card]')`, 10_000, 'the deck');
      await sleep(400);
      check((await b.eval(cardKey)) === `persona_proposal:${proposalId}`, `${tag}: ?item= opens the deck at the persona card`);
      const card = await b.eval(`(() => { const c = document.querySelector('[data-attention-card]'); return { title: c.querySelector('h2')?.innerText.trim(), kind: c.innerText.includes('Personas') }; })()`);
      check(card.title === 'QA persona: new instructions' && card.kind, `${tag}: the card says what and its kind (${JSON.stringify(card)})`);
      const a = await b.eval(AUDIT);
      check(!a.hscroll && a.overflowing.length === 0, `${tag}: deck, no sideways scroll ${a.hscroll ? JSON.stringify(a.hscroll) : ''} ${a.overflowing.join('; ')}`);
      check(a.unnamed.length === 0, `${tag}: deck, every control named ${a.unnamed.join('; ')}`);
      await b.shot(`see-deck-${tag}`);

      await b.clickSel('[data-deck-act]');
      await b.waitFor(`location.pathname === '/admin/pools' && !!document.querySelector('[role=dialog] #proposal-${proposalId}')`, 10_000, 'the proposals dialog');
      await sleep(500);
      const at = await b.eval(`(() => { const p = new URLSearchParams(location.search); const li = document.getElementById('proposal-${proposalId}'); return { tab: p.get('tab'), proposal: p.get('proposal'), current: li?.getAttribute('aria-current'), seen: !!li && li.getBoundingClientRect().bottom <= innerHeight && li.getBoundingClientRect().top >= 0 }; })()`);
      check(at.tab === 'personas' && at.proposal === proposalId && at.current === 'true' && at.seen, `${tag}: the action lands on Personas with that proposal open, marked and in view (${JSON.stringify(at)})`);
      const d = await b.eval(AUDIT);
      check(!d.hscroll && d.overflowing.length === 0, `${tag}: dialog, no sideways scroll ${d.hscroll ? JSON.stringify(d.hscroll) : ''} ${d.overflowing.join('; ')}`);
      check(d.unnamed.length === 0, `${tag}: dialog, every control named ${d.unnamed.join('; ')}`);
      if (width === 390) {
        const small = await b.eval(`[...document.querySelectorAll('#proposal-${proposalId} button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 44 || r.width < 44); }).map((e) => (e.getAttribute('aria-label') || e.innerText).slice(0, 30) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))`);
        check(small.length === 0, `${tag}: 44 px targets on the proposal's buttons ${small.join('; ')}`);
      }
      await b.shot(`see-proposal-${tag}`);
      await b.key('Escape', { code: 'Escape' });
      await b.waitFor(`!document.querySelector('[role=dialog] #proposal-${proposalId}')`, 5000, 'the dialog closing');
      await sleep(300);
      const left = await b.eval(`new URLSearchParams(location.search).get('proposal')`);
      check(left === null, `${tag}: closing the dialog drops ?proposal= (${left})`);
      if (b.errors.length) check(false, `${tag}: page errors ${b.errors.slice(0, 3).join(' | ')}`);
    } finally {
      await b.close();
    }
  }
}

/* ---------- Decided on the module's own route: the item leaves ---------- */

await must(call('POST', `/api/personas/proposals/${proposalId}/reject`), 'reject the proposal');
const after = await waiting();
check(after.counts.persona_proposal === 0 && !after.items.some((i) => i.kind === 'persona_proposal'), `rejecting it on the persona route resolves it (${after.counts.persona_proposal})`);

console.log(fails.length ? `\n${fails.length} of ${checks} failed; screenshots in ${SHOTS}` : `\nall ${checks} passed; screenshots in ${SHOTS}`);
process.exit(fails.length ? 1 : 0);
