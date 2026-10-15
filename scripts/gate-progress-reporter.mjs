// A node:test reporter that streams the gate's progress (T-578), next to the TAP report the verdict reads (gate.sh passes both). One line each:
//   progress: start <file>                         the first time a test file reports anything
//   progress: FAIL <file> <test> <s>s              every failing test
//   progress: slow <file> <test> <s>s              every test of 5 s or more
//   progress: file <file> pass=<n> fail=<n> <s>s   at the end, one per file (first to last event of the file)
// The file is the test's own file relative to apps/server. Pure helpers are exported for the test.
import { relative } from 'node:path';

export const SLOW_MS = 5000;
const fileOf = (data) => (data.file ? relative(process.cwd(), data.file) || data.file : 'unknown');
const secs = (ms) => (ms / 1000).toFixed(1);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').slice(0, 100);

/** Lines for one event, and the per-file state it changes (`files`, a Map). `now` is the clock in ms. */
export function progressLines(event, files, now) {
  const { type, data } = event;
  if (type !== 'test:pass' && type !== 'test:fail') return [];
  const file = fileOf(data);
  const out = [];
  let f = files.get(file);
  if (!f) { f = { pass: 0, fail: 0, first: now, last: now }; files.set(file, f); out.push(`progress: start ${file}`); }
  f.last = now;
  const ms = data.details?.duration_ms ?? 0;
  if (type === 'test:fail') { f.fail++; out.push(`progress: FAIL ${file} ${oneLine(data.name)} ${secs(ms)}s`); }
  else { f.pass++; if (ms >= SLOW_MS) out.push(`progress: slow ${file} ${oneLine(data.name)} ${secs(ms)}s`); }
  return out;
}

export function summaryLines(files) {
  return [...files].map(([file, f]) => `progress: file ${file} pass=${f.pass} fail=${f.fail} ${secs(f.last - f.first)}s`);
}

export default async function* reporter(source) {
  const files = new Map();
  for await (const event of source) for (const l of progressLines(event, files, Date.now())) yield `${l}\n`;
  for (const l of summaryLines(files)) yield `${l}\n`;
}
