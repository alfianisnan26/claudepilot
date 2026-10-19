// Ticket Bump (tickets PRD FR28 to FR31) in a real browser: the ticket page's Bump button and dialog (picker, the two ways, the note), a
// bumped entry on the timeline, the list row's ⋯, at 390 px and 1280 px, light and dark. Checks: no horizontal scroll, the picker's rows
// are 44 px, the dialog fits the screen, no page errors. Against a scratch portal with "This machine" (two sessions on local/local), whose
// Claude Code talks to the stand-in Messages API:
//   node tools/qa/mock-anthropic.mjs 4623 /tmp/cp-bump-mock.jsonl &
//   PORTAL_LOCAL_ENABLED=true scripts/scratch-portal.sh start 3423
//   printf '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4623","ANTHROPIC_API_KEY":"fake-mock-key"}}' > /tmp/scratch-portal-3423/home/.claude/settings.json
//   QA_PORT=3423 QA_CODE=24681372 QA_SHOTS=/tmp/qa-shots/bump node tools/qa/ticket-bump.mjs
//   scripts/scratch-portal.sh stop 3423
import { Browser, SHOTS } from './browser.mjs';
import { api, login, sleep } from './lib.mjs';

const results = [];
const check = (cfg, name, ok, detail = '') => {
  results.push({ cfg, name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${cfg} / ${name}${ok ? '' : ` ${detail}`}`);
};

const cookie = await login();
const call = api(cookie);
await call('POST', '/api/workspaces/local/local/start');
const made = async (path, body) => {
  const r = await call('POST', path, body);
  if (r.status >= 300) throw new Error(`${path}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.data;
};
const worker = await made('/api/chat/sessions', { workspaceId: 'local/local', title: 'Worker' });
await made('/api/chat/sessions', { workspaceId: 'local/local', title: 'Reviewer of the login flow and its redirects, with a title long enough to wrap' });
const t = await made('/api/tickets', { summary: 'Fix the login redirect after a password reset', type: 'bug', priority: 'high', workspaceId: 'local/local', assignee: { kind: 'session', sessionId: worker.id } });
// One Ask with a note, so the timeline has a bumped entry (the send may fail without a Claude: the entry is written first).
const asked = await call('POST', `/api/tickets/${t.id}/bump`, { sessionId: worker.id, mode: 'ask', note: 'Does this also happen on the mobile app?' });
console.log(`ask bump: ${asked.status}`);

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
    await b.goto(`/admin/tickets/${t.id}`, 2500);
    // The first load waits longer: the dev server compiles the app then.
    check(cfg.name, 'the bumped entry reads as a sentence', await seen(`document.body.innerText.includes('bumped it into “Worker” (Ask)')`, 30000));
    check(cfg.name, 'the note shows under it', await b.eval(`document.body.innerText.includes('Does this also happen on the mobile app?')`));
    check(cfg.name, 'page: no horizontal scroll', await b.eval(`document.scrollingElement.scrollWidth <= innerWidth + 1`));
    const actions = await b.eval(`(() => { const tops = ['Start agent', 'Bump', 'Close', 'More'].map((n) => [...document.querySelectorAll('main button')].find((e) => (e.textContent.trim() || e.getAttribute('aria-label')) === n)?.getBoundingClientRect().top); return tops.every((t) => t !== undefined && Math.abs(t - tops[0]) < 4); })()`);
    check(cfg.name, 'the actions keep to one line', actions);
    await b.shot(`${cfg.name}-1-ticket`, { full: true });

    await b.clickText('Bump', { exact: true, selector: 'button' });
    check(cfg.name, 'the dialog opens with the sessions', await seen(`!!document.querySelector('[role=radiogroup] label')`));
    const pick = await b.eval(`(() => {
      const rows = [...document.querySelectorAll('[role=radiogroup] label')];
      const dlg = document.querySelector('[role=dialog]')?.getBoundingClientRect();
      return { rows: rows.map((r) => ({ text: r.innerText.replace(/\\s+/g, ' ').trim(), h: Math.round(r.getBoundingClientRect().height) })), checked: document.querySelector('[role=radiogroup] input:checked')?.closest('label')?.innerText ?? '', fits: !!dlg && dlg.left >= -1 && dlg.right <= innerWidth + 1, hscroll: document.scrollingElement.scrollWidth > innerWidth + 1 };
    })()`);
    check(cfg.name, 'the assigned session is first and picked', /Worker/.test(pick.rows[0]?.text ?? '') && /Assigned/.test(pick.rows[0]?.text ?? '') && /Worker/.test(pick.checked), JSON.stringify(pick.rows));
    check(cfg.name, 'picker rows are 44 px or more', pick.rows.length >= 2 && pick.rows.every((r) => r.h >= 44), JSON.stringify(pick.rows));
    check(cfg.name, 'the dialog fits the screen', pick.fits && !pick.hscroll);
    await b.shot(`${cfg.name}-2-dialog`);
    await b.clickText('Ask', { exact: true, selector: 'button, [role=radio], [role=tab]' }).catch(() => undefined);
    await sleep(300);
    await b.shot(`${cfg.name}-3-dialog-ask`);
    await b.key('Escape');
    await sleep(400);

    await b.goto('/admin/tickets?view=list', 2500);
    check(cfg.name, 'the row has a ⋯', await seen(`!!document.querySelector('[aria-label="More for ${t.id}"]')`));
    check(cfg.name, 'list: no horizontal scroll', await b.eval(`document.scrollingElement.scrollWidth <= innerWidth + 1`));
    await b.clickSel(`[aria-label="More for ${t.id}"]`);
    await sleep(400);
    await b.shot(`${cfg.name}-4-row-menu`);
    check(cfg.name, 'no page errors', (b.errors ?? []).length === 0, (b.errors ?? []).join(' | ').slice(0, 300));
  } catch (e) {
    check(cfg.name, 'scenario ran', false, String(e.message ?? e).slice(0, 300));
    await b.shot(`${cfg.name}-x-error`).catch(() => undefined);
  } finally {
    await b.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed; shots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
