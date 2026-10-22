// T-1988: the Timeline's time axis has labels right after a fresh load, at every scale, at 390 and 1280 px, light and dark (they were
// blank until the 60 s refresh: the axis read the box's ref before it was set). Also: every label shown is wholly inside the visible part
// of the chart (not under the sticky label column, not past the box's edge), and neighbouring labels never touch.
// usage: tools/qa/with-portal.sh 3471 env QA_SHOTS=dir node tools/qa/timeline-axis.mjs
import { Browser, SHOTS } from './browser.mjs';
import { api, login } from './lib.mjs';

const call = api(await login());
await call('POST', '/api/tickets', { summary: 'Timeline axis check', type: 'task', priority: 'normal' }).catch(() => undefined);

const MEASURE = `(() => {
  const box = document.querySelector('[data-timeline-box]');
  const axis = document.querySelector('[data-timeline-axis]');
  const column = document.querySelector('[data-timeline-labels]');
  if (!box || !axis || !column) return { missing: true };
  const b = box.getBoundingClientRect();
  const left = column.getBoundingClientRect().right;
  const right = b.left + box.clientLeft + box.clientWidth;
  const spans = [...axis.querySelectorAll('span')].map((s) => s.getBoundingClientRect()).sort((x, y) => x.left - y.left);
  const cut = spans.filter((r) => r.left < left - 0.5 || r.right > right + 0.5).length;
  let touching = 0;
  for (let i = 1; i < spans.length; i++) if (spans[i].left - spans[i - 1].right < 2) touching++;
  return { labels: spans.length, cut, touching };
})()`;

let fails = 0;
for (const [width, height, dark] of [
  [390, 844, false],
  [390, 844, true],
  [1280, 800, false],
  [1280, 800, true],
]) {
  const tag = `${width}-${dark ? 'dark' : 'light'}`;
  const b = await Browser.launch({ width, height, dark, mobile: width < 600 });
  await b.signedIn();
  for (const scale of ['minute', 'hour', 'day']) {
    // A fresh load each time: the bug was on first render, so a switch inside one page would not show it.
    await b.goto(`/admin/tickets?view=timeline&scale=${scale}`, 2500);
    const m = await b.eval(MEASURE);
    const file = await b.shot(`timeline-axis-${scale}-${tag}`);
    const bad = [];
    if (m.missing) bad.push('no chart');
    else {
      if (m.labels < 3) bad.push(`${m.labels} labels`);
      if (m.cut) bad.push(`${m.cut} cut`);
      if (m.touching) bad.push(`${m.touching} touching`);
    }
    if (bad.length) fails++;
    console.log(`${bad.length ? 'FAIL' : 'ok  '} ${scale} ${tag}: ${JSON.stringify(m)} ${bad.join(' | ')} ${file}`);
  }
  await b.close();
}
console.log(fails ? `\n${fails} finding(s); screenshots in ${SHOTS}` : `\nno findings; screenshots in ${SHOTS}`);
process.exit(fails ? 1 : 0);
