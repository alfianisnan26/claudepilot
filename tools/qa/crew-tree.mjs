// Every worker under its lead, at the owner's scale (T-378): on his iPhone the In progress chip listed the workers of an IDLE lead flat, each
// a row of its own with "from <lead>", and QA's near-empty portals never showed it. Against a scratch portal seeded by seed-scale.mjs (crew A:
// a WORKING lead with 40 workers; crew B: an IDLE lead whose workers work, one waits on you; crew C: an IDLE lead, a working worker and that
// worker's worker), at 390 px with touch, in All, every chip (Needs you, In progress, Idle, Ended) and a search that matches workers and no
// lead, it asserts per crew: every worker in sight is nested under its own lead, either the lead's row or a lead header (one line of
// context). A worker that is a row of its own (flat, "from <lead>") fails.
// One line per check; exit 1 on any FAIL. Screenshots per view go to --shots (default qa-shots/t378-crew).
// usage: tools/qa/with-portal.sh 3479 node tools/qa/crew-tree.mjs [--shots dir] [--keep]
//   scripts/job-run.sh --ref <branch> --artifacts qa-shots -- 'tools/qa/with-portal.sh 3479 node tools/qa/crew-tree.mjs'
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT, sleep } from './lib.mjs';
import { CREWS, purgeScale, seedScale } from './seed-scale.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : 'qa-shots/t378-crew';
mkdirSync(shots, { recursive: true });
const dbPath = process.env.SCALE_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`;
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};

const db = new DatabaseSync(dbPath, { timeout: 10_000 });
const seeded = seedScale(db);
console.log(`seeded ${seeded.sessions} sessions, ${CREWS.parentOf.size} workers in 3 crews`);
const crewOf = (id) => {
  for (let cur = id, hops = 0; cur && hops < 5; cur = CREWS.parentOf.get(cur), hops++) if (CREWS.leads.includes(cur)) return cur;
  return null;
};
const CREW_NAME = {
  'qascale-lead-a': 'crew A (lead working, 40 workers)',
  'qascale-lead-b': 'crew B (lead idle, workers working)',
  'qascale-lead-c': "crew C (lead idle, a worker's worker)",
};

// In the page: every seeded row in sight, the session it is nested under (null when it is a row of its own), and whether it says "from".
const TREE = `(() => {
  const ownId = (li) => {
    const h = li.querySelector(':scope > div a[data-crew-header]');
    if (h) return h.getAttribute('data-crew-header');
    const a = [...li.querySelectorAll('a[href^="/admin/sessions/"]')].find((x) => !x.matches('[data-crew-from]') && x.closest('li') === li);
    return a ? a.getAttribute('href').split('/').pop() : null;
  };
  const out = [];
  for (const li of document.querySelectorAll('ul[data-session-rows] li')) {
    const id = ownId(li);
    if (!id || !id.startsWith('qascale-')) continue;
    const ul = li.parentElement;
    const under = ul?.matches('ul[data-crew]') ? ownId(ul.closest('li')) : null;
    const title = li.querySelector(':scope > div p.font-semibold, :scope > div [data-header-title]')?.textContent?.trim() ?? id;
    out.push({ id, under, header: li.matches('[data-lead-header]'), from: !!li.querySelector(':scope > div a[data-crew-from]'), title });
  }
  return out;
})()`;

const IPHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const cookie = await login();
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
await b.setViewport(390, 844, true);
await b.send('Emulation.setSafeAreaInsetsOverride', { insets: IPHONE }).catch(() => {});
const shot = async (name) => {
  const r = await b.send('Page.captureScreenshot', { format: 'png' });
  const file = join(shots, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
};

const VIEWS = [
  { name: 'All', chip: 'all' },
  { name: 'Needs you', chip: 'attention' },
  { name: 'In progress', chip: 'working' },
  { name: 'Idle', chip: 'idle' },
  { name: 'Ended', chip: 'ended' },
  { name: 'search "worker"', chip: 'all', query: 'worker' },
];

for (const dark of [false, true]) {
  await b.media({ dark });
  for (const v of VIEWS) {
    // The tree's structure does not depend on the theme: dark is for the pictures of the views where it matters.
    if (dark && !['In progress', 'All'].includes(v.name)) continue;
    const tag = `390-${dark ? 'dark' : 'light'} ${v.name}:`;
    await b.goto('/admin/sessions', 2500);
    await b.waitFor(`!!document.querySelector('[data-chip=all]')`, 15_000, 'chips').catch(() => {});
    const has = await b.eval(`!!document.querySelector('[data-chip=${v.chip}]')`);
    if (!has) {
      check(`${tag} the chip is there`, false);
      continue;
    }
    await b.eval(`document.querySelector('[data-chip=${v.chip}]').click()`);
    if (v.query) {
      await b.focusSel('input[type=search]');
      await b.type(v.query);
    }
    await b.waitFor(`document.querySelectorAll('ul[data-session-rows] li').length > 0`, 15_000, 'rows').catch(() => {});
    await sleep(800);
    const rows = await b.eval(TREE);
    const workers = rows.filter((r) => !r.header && CREWS.parentOf.has(r.id));
    for (const lead of CREWS.leads) {
      const mine = workers.filter((r) => crewOf(r.id) === lead);
      const flat = mine.filter((r) => r.under !== CREWS.parentOf.get(r.id));
      check(`${tag} ${CREW_NAME[lead]}: every worker under its lead`, flat.length === 0,
        mine.length === 0 ? '(none in this view)' : `${mine.length - flat.length}/${mine.length} nested${flat[0] ? `; flat: "${flat[0].title}"${flat[0].from ? ' with "from"' : ''}${flat.length > 1 ? ` and ${flat.length - 1} more` : ''}` : ''}`);
    }
    // The picture: crew B (the idle lead) in view.
    await b.eval(`(() => { const a = document.querySelector('a[href="/admin/sessions/qascale-b-1"]'); a?.scrollIntoView({ block: 'center' }); })()`);
    await sleep(300);
    const file = await shot(`crew-${v.name.replace(/[^a-z]+/gi, '-').toLowerCase()}-${dark ? 'dark' : 'light'}`);
    console.log(`     shot ${file}`);
  }
}

await b.close();
if (!args.includes('--keep')) purgeScale(db);
db.close();
console.log(`${failed ? 'FAILED' : 'passed'}: ${failed} failing`);
process.exit(failed ? 1 : 0);
