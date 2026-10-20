// The Agents tree (T-1710, docs/design/agent-tree-reference.png) in a real browser, against a scratch portal seeded here with three crews
// (rows whose ids start "qtree-"): a lead with 5 workers (one has 2 workers; one failed, one waiting, some running, some done, a title with no
// spaces), a lead with 1 worker, a lead with 12 workers. Over 390 px with touch and the iPhone's safe areas, then 1024 and 1280 px, light and
// dark, it asserts:
//   - the page never scrolls sideways and no card overflows (a long title breaks);
//   - from 1024 px a lead stays in view when its row of workers is wider than the page (the row scrolls inside its box, starting on the lead);
//   - a card is a link all over (a 44 px target on a phone), the collapse, "N failed" and the popover's buttons are 44 px on a phone;
//   - "N failed" opens a popover inside the viewport, focus moves into it, Escape closes it and gives focus back;
//   - T-1853: Active is the default (idle and ended agents fold behind "+N"); then it shows All, and the leads stay in view after that switch;
//   - with prefers-reduced-motion the spinner stands still and a collapse is instant (no height tween); without it the tween runs.
// usage: tools/qa/with-portal.sh 3405 node tools/qa/agent-tree.mjs [--shots dir]   (it removes its rows at the end)
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};

// --- seed -------------------------------------------------------------------------------------------------------------------------------
const db = new DatabaseSync(process.env.SL_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`, { timeout: 10000 });
const purge = () => db.exec("DELETE FROM chat_requests WHERE session_id LIKE 'qtree-%'; DELETE FROM chat_sessions WHERE id LIKE 'qtree-%'");
purge();
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ins = db.prepare(`INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, process, model, mode, cost_est_usd, turns, launch,
  created_at, last_activity_at, ended_reason, parent_id, claude_id, started_by, agent, ticket_id, last_seq, context_used, context_window)
  VALUES (?, 'docker/qa-tree', '/home/node', ?, 'ui', ?, ?, ?, ?, 'default', ?, 3, '{}', ?, ?, ?, ?, '', ?, ?, NULL, 0, 20000, 1000000)`);
let k = 0;
const add = (id, title, state, o = {}) => {
  const born = now - (o.mins ?? 10) * 60000 + k++ * 1000;
  ins.run(`qtree-${id}`, title, state, iso(born), state === 'waiting' ? 'live' : 'gone', o.model ?? 'claude-sonnet-5-5', o.cost ?? 0.1, iso(born),
    iso(born + 45000), state === 'ended' ? 'ended by you' : null, o.parent ? `qtree-${o.parent}` : null, o.parent ? `session:qtree-${o.parent}` : 'ui', o.agent ?? null);
};
add('orch', 'Launch the new pricing page by Friday', 'working', { agent: 'orchestrator', model: 'claude-opus-5-5', cost: 1.52, mins: 30 });
add('res', 'Compare the pricing of five competitors', 'ended', { parent: 'orch', agent: 'researcher', cost: 0.29 });
add('scr', 'Read the pricing pages of Linear, Notion and three more', 'ended', { parent: 'res', agent: 'scraper', cost: 0.03 });
add('ana', 'Summarize 120 G2 reviews that mention price', 'ended', { parent: 'res', agent: 'analyst', cost: 0.08 });
add('wri', 'Write the copy for the three plans', 'working', { parent: 'orch', agent: 'writer', cost: 0.14 });
add('cod', 'Build the page and wire up checkout', 'working', { parent: 'orch', agent: 'coder', cost: 0.36 });
add('tf', 'Write and run the checkout tests: 2 of 14 fail, coupon codes are not applied and the totals round wrong', 'interrupted', { parent: 'cod', agent: 'tester', cost: 0.04 });
add('tr', 'Fix the coupon test and run all again', 'working', { parent: 'cod', agent: 'tester', cost: 0.01 });
add('rev', 'Review the pricing page copy and layout against the brand guide before it goes out on Friday morning', 'waiting', { parent: 'orch', agent: 'reviewer', cost: 0.05 });
add('lng', 'Averyveryveryveryveryveryveryveryveryverylongunbrokentitlewithnospacesatalltoseeifitwraps_and_more', 'idle', { parent: 'orch', cost: 0.02 });
add('l2', 'Fix the login redirect', 'idle', { agent: 'implementer', mins: 90, cost: 0.6, model: 'claude-opus-5-5' });
add('l2w', 'Add a regression test for the redirect', 'ended', { parent: 'l2', agent: 'qa-verifier', cost: 0.12 });
add('l3', 'Migrate the store layer', 'working', { agent: 'orchestrator', mins: 200, cost: 3.4, model: 'claude-opus-5-5' });
['working', 'ended', 'ended', 'interrupted', 'idle', 'working', 'ended', 'waiting', 'working', 'ended', 'ended', 'working'].forEach((s, i) =>
  add(`l3w${i}`, `Migrate table ${i + 1} of the store`, s, { parent: 'l3', agent: ['implementer', 'reviewer', 'explorer', 'scribe'][i % 4], cost: 0.05 + i / 50 }),
);
db.prepare(`INSERT INTO chat_requests (session_id, request_id, kind, tool_name, title, detail, created_at) VALUES (?, 'r1', 'tool', 'Bash', 'Run a command', 'npm test', ?)`).run('qtree-rev', iso(now));
db.prepare(`INSERT INTO chat_requests (session_id, request_id, kind, tool_name, title, detail, created_at) VALUES (?, 'r1', 'tool', 'Bash', 'Run a command', 'npm test', ?)`).run('qtree-l3w7', iso(now));

// --- browser ----------------------------------------------------------------------------------------------------------------------------
const SIZES = [
  { name: 'phone', w: 390, h: 844, mobile: true, insets: { top: 59, bottom: 34, left: 0, right: 0 } },
  { name: 'd1024', w: 1024, h: 800, mobile: false },
  { name: 'd1280', w: 1280, h: 900, mobile: false },
];
const cookie = await login();
const b = await Browser.launch({ cookie });
await b.cookie(cookie);
const active = `(() => { const e = document.activeElement; return e ? e.tagName + ':' + (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 24) : null })()`;
const showTree = async () => {
  await b.waitFor(`!!document.querySelector('button[aria-label="Tree"]')`, 60000, 'the Tree toggle');
  if ((await b.eval(`document.querySelector('button[aria-label="Tree"]').getAttribute('aria-pressed')`)) !== 'true') await b.clickSel('button[aria-label="Tree"]');
  // T-1853: Active is the default and folds idle and ended agents; this check is about every card, so it shows All (kept in the browser,
  // so only the first visit switches). The switch widens the rows after they opened: the leads must still be in view (T-1825 QA).
  await b.waitFor(`!!document.querySelector('[data-agent-filter="all"]')`, 10000, 'the filter');
  if (!filterChecked) {
    filterChecked = true;
    const d = await b.eval(`({ active: document.querySelector('[data-agent-filter="active"]').getAttribute('aria-pressed'), folded: [...document.querySelectorAll('[data-agent-folded]')].map((x) => x.textContent.trim()) })`);
    check('Active is the default and idle or ended agents fold behind a count', d.active === 'true' && d.folded.length > 0 && d.folded.every((t) => /^\+\d/.test(t)), JSON.stringify(d));
  }
  if ((await b.eval(`document.querySelector('[data-agent-filter="all"]').getAttribute('aria-pressed')`)) !== 'true') await b.clickSel('[data-agent-filter="all"]');
  await b.waitFor(`document.querySelectorAll('[data-agent-tree-root]').length === 3 && !document.querySelector('[data-agent-folded]')`, 10000, 'three trees, all shown');
  await sleep(600);
};
let filterChecked = false;
const open = async (s, dark, reducedMotion = false) => {
  await b.setViewport(s.w, s.h, s.mobile);
  await b.send('Emulation.setSafeAreaInsetsOverride', { insets: s.insets ?? { top: 0, bottom: 0, left: 0, right: 0 } }).catch(() => {});
  await b.media({ dark, reducedMotion });
  await b.goto('/admin/sessions', 3000);
  await showTree();
  await b.eval('window.scrollTo(0, 0)');
};

try {
  for (const s of SIZES)
    for (const dark of [false, true]) {
      const tag = `${s.name}-${dark ? 'dark' : 'light'}`;
      console.log(tag);
      await open(s, dark);
      if (shots) await b.shot(`${tag}-tree`);
      const m = await b.eval(`(() => {
        const vw = document.documentElement.clientWidth;
        const roots = [...document.querySelectorAll('[data-agent-tree-root]')];
        const lead = roots.map((r) => { const c = r.querySelector('[data-agent-card]').getBoundingClientRect(); const box = r.querySelector('[data-agent-card]').closest('.at-root').parentElement.getBoundingClientRect(); return { id: r.dataset.agentTreeRoot, ok: c.left >= box.left - 1 && c.right <= box.right + 1 }; });
        const over = [...document.querySelectorAll('[data-agent-card]')].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.dataset.agentCard);
        const small = [...document.querySelectorAll('[data-agent-tree-root] button, [data-agent-failed], button[aria-label="Tree"]')].filter((e) => !e.closest('[aria-label="About the cost"]') && e.getAttribute('aria-label') !== 'About the cost').map((e) => ({ e, r: e.getBoundingClientRect() })).filter((x) => x.r.width > 0 && (x.r.width < 43.5 || x.r.height < 43.5)).map((x) => (x.e.getAttribute('aria-label') || x.e.textContent).trim());
        const dead = [];
        for (const c of document.querySelectorAll('[data-agent-card]')) {
          c.scrollIntoView({ block: 'center', inline: 'center' });
          const r = c.getBoundingClientRect();
          for (const [fx, fy] of [[0.1, 0.12], [0.5, 0.5], [0.3, 0.85]]) {
            const a = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)?.closest('a[href^="/admin/sessions/"], button');
            if (!a || !c.contains(a)) dead.push(c.dataset.agentCard + '@' + fx + ',' + fy);
          }
        }
        window.scrollTo(0, 0);
        return { pageScroll: document.documentElement.scrollWidth > vw, lead, over, small, dead };
      })()`);
      check(`${tag}: no sideways page scroll`, !m.pageScroll);
      check(`${tag}: no card overflows (long titles break)`, m.over.length === 0, m.over.join());
      check(`${tag}: every lead is in view in its box`, m.lead.every((x) => x.ok), JSON.stringify(m.lead.filter((x) => !x.ok)));
      if (s.mobile) {
        check(`${tag}: collapse, "N failed" and the toggle are 44 px`, m.small.length === 0, m.small.join());
        check(`${tag}: a card is a link all over (nothing dead to touch)`, m.dead.length === 0, `${m.dead.length}: ${m.dead.slice(0, 3).join(' ')}`);
      }
      // the failed popover
      await b.eval(`document.querySelector('[data-agent-failed]').scrollIntoView({ block: 'center' })`);
      await b.clickSel('[data-agent-failed]');
      await sleep(700);
      const pop = await b.eval(`(() => { const d = document.querySelector('[role=dialog]'); if (!d) return null; const r = d.getBoundingClientRect(); return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, buttons: [...d.querySelectorAll('button')].map((x) => Math.round(x.getBoundingClientRect().height)), focus: ${active} } })()`);
      if (shots) await b.shot(`${tag}-failed`);
      check(`${tag}: "N failed" opens a popover inside the viewport, focus inside`, !!pop && pop.inside && /^(A|BUTTON):(?!.*failed)/.test(pop.focus), JSON.stringify(pop));
      if (pop && s.mobile) check(`${tag}: Dismiss and Retry are 44 px`, pop.buttons.every((h) => h >= 44), JSON.stringify(pop.buttons));
      await b.key('Escape');
      await sleep(500);
      const back = await b.eval(`({ open: !!document.querySelector('[role=dialog]'), focus: ${active} })`);
      check(`${tag}: Escape closes it and focus returns to "N failed"`, !back.open && /failed/.test(back.focus), JSON.stringify(back));
    }

  // reduced motion
  for (const reduced of [false, true]) {
    await open(SIZES[2], false, reduced);
    const r = await b.eval(`(async () => {
      const spin = getComputedStyle(document.querySelector('.at-spin')).animationName;
      const btn = document.querySelector('[data-agent-card="qtree-cod"] button[aria-expanded]');
      const t0 = performance.now();
      btn.click();
      while (document.querySelector('[data-agent-card="qtree-tr"]') && performance.now() - t0 < 2000) await new Promise((x) => requestAnimationFrame(x));
      const dt = performance.now() - t0;
      btn.click();
      return { spin, dt: Math.round(dt) };
    })()`);
    if (reduced) {
      check('reduced motion: the spinner stands still', r.spin === 'none', r.spin);
      check('reduced motion: a collapse is instant', r.dt < 120, `${r.dt} ms`);
    } else {
      check('motion on: the spinner spins and a collapse tweens', r.spin === 'at-spin' && r.dt > 120, `${r.spin} ${r.dt} ms`);
    }
  }
} finally {
  purge();
  await b.close();
}
console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
