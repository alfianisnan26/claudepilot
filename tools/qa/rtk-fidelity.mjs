#!/usr/bin/env node
// T-286: fidelity of rtk output. Diffs the SETS of failing test names, error messages and file:line between a plain and an rtk output.
//   node tools/qa/rtk-fidelity.mjs <plain.txt> <rtk.txt> [--json]     exit 0 when every item of plain is in rtk, 1 otherwise
import { readFileSync } from "node:fs";
const [plainP, rtkP, flag] = process.argv.slice(2);
if (!plainP || !rtkP) { console.error("usage: rtk-fidelity.mjs plain.txt rtk.txt [--json]"); process.exit(2); }
const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
const norm = (s) => s.replace(/\s+/g, " ").replace(/\s*\(?\d+(\.\d+)?\s*ms\)?$/, "").trim();
const FILE = /((?:[A-Za-z0-9_.@~-]+\/)*[A-Za-z0-9_.@-]+\.(?:ts|tsx|mts|js|mjs|cjs|json)):(\d+)(?::(\d+))?|((?:[A-Za-z0-9_.@~-]+\/)*[A-Za-z0-9_.@-]+\.(?:ts|tsx|mts|js|mjs|cjs))\((\d+),(\d+)\)/g;
export function extract(text) {
  const lines = strip(text).split("\n");
  const names = new Set(), messages = new Set(), locs = new Set();
  for (const raw of lines) {
    const l = raw.trim();
    let m;
    if ((m = /^(?:✖|✗|×|not ok \d+ -)\s+(.+)$/.exec(l))) { const n = norm(m[1]); if (!/^(failing tests?:?|\d+)/i.test(n)) names.add(n); continue; }
    if ((m = /error (TS\d+): (.+)$/.exec(l))) messages.add(`${m[1]}: ${norm(m[2])}`);
    if ((m = /^(?:error|message|AssertionError(?: \[[A-Z_]+\])?|Error|TypeError|ReferenceError):\s*'?(.+?)'?,?$/.exec(l)) && m[1].length > 3) messages.add(norm(m[1]));
    if (/^(?:\+|-) /.test(l) && !/^(?:\+|-) (?:'|\d|\[|\{|")/.test(l) === false) messages.add("diff: " + l);
    FILE.lastIndex = 0;
    while ((m = FILE.exec(l))) {
      const file = (m[1] || m[4]).replace(/^\.\//, "").replace(/^.*?(apps\/|src\/)/, "$1"), line = m[2] || m[5];
      if (!/node_modules|node:internal/.test(file)) locs.add(`${file}:${line}`);
    }
  }
  return { names, messages, locs };
}
const a = extract(readFileSync(plainP, "utf8")), b = extract(readFileSync(rtkP, "utf8"));
const report = {};
let total = 0, missing = 0;
for (const k of ["names", "messages", "locs"]) {
  const miss = [...a[k]].filter((x) => !b[k].has(x));
  report[k] = { plain: a[k].size, rtk: b[k].size, missing: miss };
  total += a[k].size; missing += miss.length;
}
report.parity_percent = total === 0 ? null : +(100 * (total - missing) / total).toFixed(1);
report.items = total; report.missing_items = missing;
if (flag === "--json") console.log(JSON.stringify(report));
else {
  console.log(`items ${total} missing ${missing} parity ${report.parity_percent}%`);
  for (const k of ["names", "messages", "locs"]) { console.log(`${k}: plain ${report[k].plain} rtk ${report[k].rtk} missing ${report[k].missing.length}`); for (const x of report[k].missing.slice(0, 12)) console.log("  MISSING " + x.slice(0, 160)); }
}
process.exit(missing ? 1 : 0);
