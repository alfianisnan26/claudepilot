// Usage → Attribution tab (T-449: "via lead" and the Done filter), over 390 px (touch, safe areas) then 1280 px, light and dark, against a
// scratch portal seeded with a lead (no ticket, $10) whose workers carry tickets, a done ticket, an open ticket, a ticket the portal does not
// know, a long-named session and a solo session. It takes a screenshot of each view and asserts (QA-STANDARDS A1-A9, measured):
//   - A2: no horizontal scroll (document and the tab's own content: scrollWidth <= clientWidth + 1);
//   - A5: every visible control (button, link, tab, segmented option) is at least 44 px tall and wide AT 390 PX (a FAIL). At 1280 px the same
//     measure only warns (the lead's decision on T-449: the rule binds at the touch width). Inline InfoTips are counted, not failed;
//   - Group by Ticket shows its rows, with "via lead" on the lead-fed tickets and an InfoTip that explains it;
//   - the Done filter exists only under Ticket, switches to done tickets only (the open ticket and the unknown one drop out), shows the
//     "Done, per ticket" line, and returns to All;
//   - a figure that is missing reads as a named state ("unknown", "unavailable", "Not recorded"), never "NaN", "undefined" or "null", and
//     never a bare dash: the ticket the portal does not know (T-9199) must say so in words;
//   - the long text breaks or truncates inside its row (no row past the viewport's edge);
//   - keyboard: Tab onto a Tickets option (a real key press, so :focus-visible applies) shows a focus ring (outline or box-shadow).
// (screenshots go to QA_SHOTS, default /tmp/qa-shots; --out is created and named in the last line)
// usage: tools/qa/with-portal.sh 3471 env QA_SHOTS=dir node tools/qa/attribution-tab.mjs [--out dir] [--keep]
//   scripts/job-run.sh --ref <commit> --artifacts job-out/ux-t-449 --out job-out/ux-t-449-art/ -- 'npm run build -w @portal/web >/dev/null 2>&1 && tools/qa/with-portal.sh 3471 env QA_SHOTS=job-out/ux-t-449 node tools/qa/attribution-tab.mjs --out job-out/ux-t-449; exit $?'
//   Seeds /tmp/scratch-portal-$QA_PORT/data/portal.db (ATTR_DB overrides): sessions "qaattr-*", tickets 9101-9103; removes them at the end.
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'qa-shots/t449-attribution';
mkdirSync(out, { recursive: true });
mkdirSync(process.env.QA_SHOTS ?? '/tmp/qa-shots', { recursive: true });
const dbPath = process.env.ATTR_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`;
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};
// A5: a FAIL at the touch width, a note at 1280 px.
const sizes = (name, strict, list) =>
  strict
    ? check(name, list.length === 0, JSON.stringify(list))
    : console.log(`  warn ${name} (1280 px: a note, not a fail) ${list.length ? `${list.length} under 44 px, e.g. ${JSON.stringify(list.slice(0, 4))}` : 'ok'}`);

// --- seed -------------------------------------------------------------------------------------------------------------------------------
const db = new DatabaseSync(dbPath, { timeout: 10_000 });
const WS = 'docker/qa-attr';
const LONG = 'QA attribution session with a very long title that must break or truncate inside its row and never push the page sideways ' + 'x'.repeat(60);
const purge = () => {
  db.exec(`DELETE FROM chat_usage WHERE session_id LIKE 'qaattr-%'; DELETE FROM chat_sessions WHERE id LIKE 'qaattr-%';
    DELETE FROM tickets WHERE number IN (9101, 9102, 9103)`);
};
const seed = () => {
  purge();
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const tk = db.prepare(`INSERT INTO tickets (number, type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, closed_at)
    VALUES (?, ?, 'normal', 2, ?, ?, 'human', 'ui', 'owner', ?, ?, ?)`);
  tk.run(9101, 'feature', 'done', 'QA attribution done feature', iso(now), iso(now), iso(now - 3_600_000));
  tk.run(9102, 'bug', 'in_progress', 'QA attribution open bug', iso(now), iso(now), null);
  // T-9103 is a done chore closed in the window too, so Done has two types in "Done, per ticket".
  tk.run(9103, 'chore', 'done', 'QA attribution done chore', iso(now), iso(now), iso(now - 7_200_000));
  const ses = db.prepare(`INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, created_at, last_activity_at, claude_id, parent_id, ticket_id)
    VALUES (?, ?, ?, 'idle', ?, ?, ?, '', ?, ?)`);
  const at = iso(now);
  ses.run('qaattr-lead', WS, 'QA attribution lead', at, at, at, null, null);
  ses.run('qaattr-w1', WS, 'QA attribution worker one', at, at, at, 'qaattr-lead', 'T-9101');
  ses.run('qaattr-w2', WS, LONG, at, at, at, 'qaattr-lead', 'T-9101');
  ses.run('qaattr-w3', WS, 'QA attribution worker three', at, at, at, 'qaattr-lead', 'T-9102');
  ses.run('qaattr-w4', WS, 'QA attribution worker four', at, at, at, 'qaattr-lead', 'T-9103');
  ses.run('qaattr-unk', WS, 'QA attribution unknown ticket', at, at, at, null, 'T-9199');
  ses.run('qaattr-solo', WS, 'QA attribution solo', at, at, at, null, null);
  const use = db.prepare(`INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, agents, duration_ms, kind)
    VALUES (?, ?, ?, ?, '', 'claude-opus-5-5', 0, 0, 0, 0, ?, 1, 0, 0, 'turn')`);
  for (const [s, usd] of [['qaattr-lead', 10], ['qaattr-w1', 2], ['qaattr-w2', 1], ['qaattr-w3', 3], ['qaattr-w4', 1.5], ['qaattr-unk', 0.75], ['qaattr-solo', 4]]) {
    use.run(iso(now - 1_800_000), now - 1_800_000, s, WS, usd);
  }
};

// --- page measures ----------------------------------------------------------------------------------------------------------------------
const MEASURE = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const desc = (e) => e.tagName.toLowerCase() + ' "' + (e.getAttribute('aria-label') || e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) + '"';
  const root = document.querySelector('main') || document.body;
  const doc = document.scrollingElement;
  const ctl = [...root.querySelectorAll('a[href], button, [role=tab], [role=radio], [role=menuitem], input, select, summary')].filter(vis);
  const tip = (e) => /why|about|how cost|how this/i.test(e.getAttribute('aria-label') || '');
  const small = (e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; };
  const cardRight = Math.max(0, ...[...root.querySelectorAll('ul li')].map((e) => e.getBoundingClientRect().right));
  const bad = [...root.querySelectorAll('li, span, p')].filter((e) => vis(e) && e.children.length === 0 && /\\b(NaN|undefined|null)\\b/.test(e.textContent || '')).map(desc);
  const row = (id) => [...root.querySelectorAll('ul.divide-y > li')].find((li) => (li.innerText || '').includes(id));
  return {
    vw: innerWidth, docScroll: doc.scrollWidth, docClient: doc.clientWidth,
    rootScroll: root.scrollWidth, rootClient: root.clientWidth,
    controls: ctl.length,
    small: ctl.filter((e) => !tip(e) && small(e)).map((e) => { const r = e.getBoundingClientRect(); return desc(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }),
    smallTips: ctl.filter((e) => tip(e) && small(e)).length,
    rowsRight: Math.round(cardRight),
    bad,
    text: root.innerText,
    row9199: (row('T-9199')?.innerText || '').replace(/\\s+/g, ' ').trim(),
    hasDone: !!ctl.find((e) => /^Done$/.test((e.innerText || '').trim())),
    rows: root.querySelectorAll('ul.divide-y > li').length,
  };
})()`;
const m = async (b) => b.eval(MEASURE);
const clickLabel = (b, text) =>
  b.eval(`(() => { const e = [...document.querySelectorAll('button, [role=tab], [role=radio], label')].find((x) => (x.innerText || '').trim() === ${JSON.stringify(text)}); if (!e) return false; e.click(); return true; })()`);
const noScroll = (s) => s.docScroll <= s.docClient + 1 && s.rootScroll <= s.rootClient + 1;

const cookie = await login();
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: { top: 47, left: 0, right: 0, bottom: 34 } },
  { name: '1280', w: 1280, h: 900, mobile: false, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
];
const LOAD_MS = 30_000;
try {
  for (const size of SIZES) {
    for (const dark of [false, true]) {
      const tag = `${size.name}-${dark ? 'dark' : 'light'}`;
      console.log(tag);
      seed();
      await b.setViewport(size.w, size.h, size.mobile);
      await b.send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets }).catch(() => {});
      await b.media({ dark });
      await b.goto('/admin/usage?tab=attribution', 2500);
      await b.waitFor(`document.body.innerText.includes('Group by')`, LOAD_MS, 'the Attribution tab').catch(() => {});
      await b.waitFor(`document.querySelectorAll('ul.divide-y > li').length > 0`, LOAD_MS, 'rows').catch(() => {});
      await sleep(500);

      // Session view (the default).
      let s = await m(b);
      check(`${tag}: session view lists rows`, s.rows >= 5, `rows=${s.rows}`);
      check(`${tag}: session view: the Done filter is absent (only under Ticket)`, !s.hasDone);
      check(`${tag}: session view: no sideways scroll`, noScroll(s), JSON.stringify([s.docScroll, s.docClient, s.rootScroll, s.rootClient]));
      sizes(`${tag}: session view: controls >= 44 px`, size.mobile, s.small);
      check(`${tag}: session view: the long title stays inside the viewport`, s.rowsRight <= s.vw + 1, `rowsRight=${s.rowsRight}`);
      console.log(`  info InfoTips under 44 px: ${s.smallTips}`);
      await b.shot(`attr-session-${tag}`, { full: true });

      // Ticket view.
      check(`${tag}: Group by Ticket clicks`, await clickLabel(b, 'Ticket'));
      await b.waitFor(`document.body.innerText.includes('via lead')`, LOAD_MS, 'via lead').catch(() => {});
      await sleep(400);
      s = await m(b);
      check(`${tag}: ticket view: "via lead" is shown`, /via lead/i.test(s.text));
      check(`${tag}: ticket view: the "About via lead" InfoTip is present`, await b.eval(`!!document.querySelector('[aria-label="About via lead"]')`));
      check(`${tag}: ticket view: the Done filter is present`, s.hasDone);
      check(`${tag}: ticket view: the open ticket and the unknown one are listed`, /T-9102/.test(s.text) && /T-9199/.test(s.text));
      check(`${tag}: ticket view: no NaN, undefined or null text`, s.bad.length === 0, JSON.stringify(s.bad));
      check(`${tag}: ticket view: the unknown ticket T-9199 names its missing type and status in words, not bare dashes`, /unknown|unavailable|not recorded/i.test(s.row9199), JSON.stringify(s.row9199));
      check(`${tag}: ticket view: no sideways scroll`, noScroll(s), JSON.stringify([s.docScroll, s.docClient, s.rootScroll, s.rootClient]));
      sizes(`${tag}: ticket view: controls >= 44 px`, size.mobile, s.small);
      console.log(`  info InfoTips under 44 px: ${s.smallTips}`);
      await b.shot(`attr-ticket-all-${tag}`, { full: true });

      // Done filter.
      check(`${tag}: Done clicks`, await clickLabel(b, 'Done'));
      await b.waitFor(`document.body.innerText.includes('Done, per ticket')`, LOAD_MS, 'Done, per ticket').catch(() => {});
      await sleep(400);
      s = await m(b);
      check(`${tag}: done view: done tickets T-9101 and T-9103 are listed`, /T-9101/.test(s.text) && /T-9103/.test(s.text));
      check(`${tag}: done view: the open ticket T-9102 and unknown T-9199 are gone`, !/T-9102/.test(s.text) && !/T-9199/.test(s.text));
      check(`${tag}: done view: "Done, per ticket" lists feature and chore`, /Done, per ticket/.test(s.text) && /feature/.test(s.text) && /chore/.test(s.text));
      check(`${tag}: done view: no NaN, undefined or null text`, s.bad.length === 0, JSON.stringify(s.bad));
      check(`${tag}: done view: no sideways scroll`, noScroll(s), JSON.stringify([s.docScroll, s.docClient, s.rootScroll, s.rootClient]));
      sizes(`${tag}: done view: controls >= 44 px`, size.mobile, s.small);
      await b.shot(`attr-ticket-done-${tag}`, { full: true });

      // Keyboard: focus the Ticket option, press Tab (a real key, so :focus-visible applies) onto the next option, read its ring.
      await b.eval(`(() => { const e = [...document.querySelectorAll('button, [role=radio], [role=tab]')].find((x) => (x.innerText || '').trim() === 'Ticket'); e?.focus(); })()`);
      await b.key('Tab');
      await sleep(200);
      const ring = await b.eval(`(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e); const vis = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0; return { el: e.tagName + ' "' + (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 20) + '"', focusVisible: e.matches(':focus-visible'), outline: cs.outlineStyle + ' ' + cs.outlineWidth, shadow: cs.boxShadow.slice(0, 60), ring: vis || cs.boxShadow !== 'none' }; })()`);
      check(`${tag}: keyboard: Tab lands on a control and shows a focus ring`, !!ring && ring.focusVisible && ring.ring, JSON.stringify(ring));
      await b.shot(`attr-focus-${tag}`);

      // Back to All; the persona view, where nothing was recorded, says so.
      await clickLabel(b, 'All');
      await sleep(300);
      check(`${tag}: Group by Persona clicks`, await clickLabel(b, 'Persona'));
      await sleep(1200);
      s = await m(b);
      check(`${tag}: persona view: not recorded is a state, not a number`, /not recorded|unavailable|unknown/i.test(s.text) && s.bad.length === 0, JSON.stringify(s.bad));
      check(`${tag}: persona view: the Done filter is gone again`, !s.hasDone);
      await b.shot(`attr-persona-${tag}`, { full: true });
    }
  }
} finally {
  if (!args.includes('--keep')) purge();
  await b.close();
}
console.log(failed ? `\n${failed} check(s) FAILED; screenshots in ${process.env.QA_SHOTS ?? '/tmp/qa-shots'}` : `\nall checks passed; screenshots in ${process.env.QA_SHOTS ?? '/tmp/qa-shots'}`);
process.exit(failed ? 1 : 0);
