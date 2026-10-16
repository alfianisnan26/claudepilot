#!/usr/bin/env node
// T-286: fidelity of rtk output. Diffs the SETS of failing test names, error messages and file:line between a plain and an rtk output.
//   node tools/qa/rtk-fidelity.mjs <plain.txt> <rtk.txt> [--json]     exit 0 when every item of plain is in rtk, 1 otherwise
// T-306 (step 2, item 1): fidelity PER COMMAND CLASS for read-only, high-volume commands.
//   node tools/qa/rtk-fidelity.mjs <plain.txt> <rtk.txt> --class <class> [--json]     exit 0 at 95 percent or more, 1 below
// Classes: git-log-meta ls-meta (T-341: the facts left out of the main classes) git-status git-log git-diff-stat git-diff-names ls find tree grep-lines grep-list grep-count. The facts an agent acts on are
// parsed from the PLAIN output in its known format (paths, line numbers, names, states, counts, hashes, subjects and message lines), then each
// is looked up in the rtk output, whatever its layout (rtk groups paths under a directory, rewrites git status in short form, and so on).
// Not scored, on purpose: ls owner, group, date and exact byte size (rtk shows a rounded size), git log dates and e-mail addresses, full
// 40-character hashes (the 7-character prefix is the fact). Lookup of a grouped path is by suffix ("coord/PLAN.md" under a search root
// counts for "docs/coord/PLAN.md"), which could over-count only when two plain paths share that whole suffix.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
const norm = (s) => s.replace(/\s+/g, " ").replace(/\s*\(?\d+(\.\d+)?\s*ms\)?$/, "").trim();
const FILE = /((?:[A-Za-z0-9_.@~-]+\/)*[A-Za-z0-9_.@-]+\.(?:ts|tsx|mts|js|mjs|cjs|json|sh|md|yml|yaml)):(\d+)(?::(\d+))?|((?:[A-Za-z0-9_.@~-]+\/)*[A-Za-z0-9_.@-]+\.(?:ts|tsx|mts|js|mjs|cjs|sh))\((\d+),(\d+)\)/g;
export function extract(text) {
  const lines = strip(text).split("\n");
  const names = new Set(), messages = new Set(), locs = new Set();
  for (const raw of lines) {
    const l = raw.trim();
    let m;
    if ((m = /^(?:✖|✗|×|not ok \d+ -)\s+(.+)$/.exec(l))) { const n = norm(m[1]); if (!/^(failing tests?:?|\d+)/i.test(n)) names.add(n); continue; }
    if ((m = /error (TS\d+): (.+)$/.exec(l))) messages.add(`${m[1]}: ${norm(m[2])}`);
    if ((m = /^(?:error|message|AssertionError(?: \[[A-Z_]+\])?|Error|TypeError|ReferenceError):\s*'?(.+?)'?,?$/.exec(l)) && m[1].length > 3) messages.add(norm(m[1]));
    FILE.lastIndex = 0;
    while ((m = FILE.exec(l))) {
      const file = (m[1] || m[4]).replace(/^\.\//, "").replace(/^.*?(apps\/|src\/)/, "$1"), line = m[2] || m[5];
      if (!/node_modules|node:internal/.test(file)) locs.add(`${file}:${line}`);
    }
  }
  return { names, messages, locs };
}

// ---------- per command class (T-306) ----------
const ws = (s) => s.replace(/\s+/g, " ").trim();
const linesOf = (t) => strip(t).split("\n").map((l) => l.replace(/\s+$/, ""));
const relp = (p) => p.replace(/^(\.\/)+/, "");
const LONG_CODE = { modified: "M", deleted: "D", "new file": "A", renamed: "R", copied: "C", typechange: "T" };

function branchShort(s, out) {
  let m;
  if (/^HEAD \(no branch\)/.test(s)) { out.add("branch:(detached)"); return; }
  if ((m = /^(?:No commits yet on|Initial commit on) (\S+)/.exec(s))) { out.add(`branch:${m[1]}`); return; }
  if ((m = /^HEAD detached (?:at|from) (\S+)/.exec(s))) { out.add("branch:(detached)"); out.add(`detached-ref:${m[1]}`); return; }
  if (!(m = /^(\S+?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/.exec(s))) return;
  out.add(`branch:${m[1]}`);
  for (const [, k, n] of (m[3] ?? "").matchAll(/(ahead|behind) (\d+)/g)) out.add(`${k}:${n}`);
}
/** git status, long or short (-s, -sb, rtk's form), to a set of facts: "S<X>:path" staged, "W<Y>:path" worktree, "??:path", "U:path", branch. */
export function gitStatusSet(text) {
  const out = new Set();
  let section = null, m;
  for (const raw of linesOf(text)) {
    const l = raw.trim();
    if (!l) continue;
    if (/^Changes to be committed/.test(l)) { section = "S"; continue; }
    if (/^Changes not staged/.test(l)) { section = "W"; continue; }
    if (/^Untracked files/.test(l)) { section = "?"; continue; }
    if (/^Unmerged paths/.test(l)) { section = "U"; continue; }
    if (/^\(use "git/.test(l) || /^(nothing|no changes)/.test(l)) continue;
    if ((m = /^On branch (\S+)/.exec(l))) { out.add(`branch:${m[1]}`); continue; }
    if ((m = /^(?:\* )?\(?HEAD detached (?:at|from) ([^)\s]+)\)?/.exec(l))) { out.add("branch:(detached)"); out.add(`detached-ref:${m[1]}`); continue; }
    if ((m = /^## (.+)$/.exec(l))) { branchShort(m[1], out); continue; }
    if ((m = /^Your branch is (ahead of|behind) '[^']+' by (\d+) commit/.exec(l))) { out.add(`${m[1] === "ahead of" ? "ahead" : "behind"}:${m[2]}`); continue; }
    if ((m = /have (\d+) and (\d+) different commits each/.exec(l))) { out.add(`ahead:${m[1]}`); out.add(`behind:${m[2]}`); continue; }
    if (/^Your branch is up to date/.test(l)) continue;
    if ((m = /^\* (.+)$/.exec(l))) { branchShort(m[1], out); continue; }
    if (section && /^\t/.test(raw)) {
      if (section === "?") { out.add(`??:${l}`); continue; }
      if ((m = /^(both modified|both added|both deleted|added by us|added by them|deleted by us|deleted by them):\s+(.+)$/.exec(l))) { out.add(`U:${m[2]}`); continue; }
      if ((m = /^(modified|deleted|new file|renamed|copied|typechange):\s+(.+)$/.exec(l))) { out.add(`${section === "U" ? "U" : section + LONG_CODE[m[1]]}:${ws(m[2])}`); continue; }
    }
    if ((m = /^([ MADRCTU?!])([ MADRCTU?!]) (.+)$/.exec(raw))) {
      const [, x, y, p] = m, path = ws(p);
      if (x === "!") continue;
      if (x === "?") { out.add(`??:${path}`); continue; }
      if (x === "U" || y === "U" || (x === y && (x === "A" || x === "D"))) { out.add(`U:${path}`); continue; }
      if (x !== " ") out.add(`S${x}:${path}`);
      if (y !== " ") out.add(`W${y}:${path}`);
    }
  }
  return out;
}
function statLine(raw, f) {
  let m;
  if ((m = /^ (\S.*?)\s+\|\s+(\d+|Bin\b.*?)(?:\s+[+-]*)?$/.exec(raw))) { f.push(["text", `${ws(m[1])} | ${ws(m[2])}`]); return true; }
  if (/^ \d+ files? changed/.test(raw)) {
    for (const r of [/\d+ files? changed/, /\d+ insertions?\(\+\)/, /\d+ deletions?\(-\)/]) { const x = r.exec(raw); if (x) f.push(["text", x[0]]); }
    return true;
  }
  return false;
}
/** The facts of the plain output of one class: [kind, value] pairs (kinds: status hash text path loc name dir). */
export function plainFacts(cls, text) {
  const f = [];
  const lines = linesOf(text);
  let m;
  switch (cls) {
    case "git-status":
      for (const v of gitStatusSet(text)) f.push(["status", v]);
      break;
    case "git-log":
      for (const raw of lines) {
        if ((m = /^commit ([0-9a-f]{7,40})/.exec(raw))) { f.push(["hash", m[1].slice(0, 7)]); continue; }
        if ((m = /^Author:\s+(.+?)\s*(?:<.*>)?$/.exec(raw))) { f.push(["text", m[1]]); continue; }
        if (/^(Date|Merge|AuthorDate|Commit|CommitDate):/.test(raw)) continue;
        if ((m = /^([0-9a-f]{7,40}) (.+)$/.exec(raw))) { f.push(["hash", m[1].slice(0, 7)]); f.push(["text", m[2]]); continue; }
        if (statLine(raw, f)) continue;
        if (/^ {4}\S/.test(raw)) f.push(["text", raw.trim()]);
      }
      break;
    case "git-log-meta": // T-341 B: what the main class leaves out on purpose: the e-mail of every Author and the whole Date line
      for (const raw of lines) {
        if ((m = /^Author:\s+.*<(.+)>\s*$/.exec(raw))) f.push(["text", m[1]]);
        else if ((m = /^Date:\s+(.+?)\s*$/.exec(raw))) f.push(["text", m[1]]);
      }
      break;
    case "ls-meta": // T-341 B: owner+group, exact size and the date of each long-format entry
      for (const raw of lines) {
        const l = raw.trim();
        if ((m = /^[-dlcbps][rwxsStT-]{9}[.+@]?\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/.exec(l))) {
          f.push(["text", `${m[1]} ${m[2]}`]); f.push(["text", m[3]]); f.push(["text", ws(m[4])]);
        }
      }
      break;
    case "git-diff-stat":
      for (const raw of lines) statLine(raw, f);
      break;
    case "git-diff-names":
      for (const raw of lines) {
        if (!raw.trim()) continue;
        if ((m = /^([ACDMRTUXB])\d*\t(.+)$/.exec(raw))) f.push(["text", `${m[1]} ${ws(m[2])}`]);
        else f.push(["path", relp(raw.trim())]);
      }
      break;
    case "ls":
      for (const raw of lines) {
        const l = raw.trim();
        if (!l || /^total \d/.test(l)) continue;
        if ((m = /^([-dlcbps])[rwxsStT-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+[\d,.]+[KMGTPkB]?\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(l))) {
          const name = m[2].replace(/ -> .*$/, "");
          if (name !== "." && name !== "..") f.push([m[1] === "d" ? "dir" : "name", name]);
          continue;
        }
        if (/:$/.test(l)) continue; // "dir:" header when ls lists several folders
        f.push(["name", l]);
      }
      break;
    case "find":
      for (const raw of lines) { const l = raw.trim(); if (l && !/^find: /.test(l)) f.push(["path", relp(l)]); }
      break;
    case "tree":
      for (const raw of lines) {
        const l = raw.replace(/^[\s│├└─|`-]+/u, "").trim();
        if (!l) continue;
        if ((m = /^(\d+ director(?:y|ies))(?:, (\d+ files?))?$/.exec(l))) { f.push(["text", m[1]]); if (m[2]) f.push(["text", m[2]]); continue; }
        f.push(["name", l.replace(/\/$/, "")]);
      }
      break;
    case "grep-lines":
      for (const raw of lines) {
        if (!raw.trim()) continue;
        if ((m = /^([^:\s][^:]*):(\d+):(.*)$/.exec(raw))) { f.push(["loc", `${relp(m[1])}:${m[2]}`]); if (m[3].trim()) f.push(["text", ws(m[3])]); continue; }
        if ((m = /^(\d+):(.*)$/.exec(raw))) { f.push(["text", `${m[1]}:${ws(m[2])}`]); continue; }
        if ((m = /^(?:Binary file|grep:) (\S+) matches$/.exec(raw))) { f.push(["path", relp(m[1])]); continue; }
      }
      break;
    case "grep-list":
      for (const raw of lines) if (raw.trim()) f.push(["path", relp(raw.trim())]);
      break;
    case "grep-count":
      for (const raw of lines) if ((m = /^(.+):(\d+)$/.exec(raw.trim()))) f.push(["text", `${relp(m[1])}:${m[2]}`]);
      break;
    default:
      throw new Error(`unknown class ${cls}`);
  }
  const seen = new Set();
  return f.filter(([k, v]) => { const key = `${k}\u0000${v}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
/** What the rtk output holds, whatever its layout. */
export function rtkIndex(text) {
  const lines = linesOf(text);
  const flat = lines.map(ws).join("\n");
  const tokens = new Set(flat.split(/\s+/).filter(Boolean));
  const paths = new Set(), locs = new Set();
  let prefix = null, curFile = null, m;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if ((m = /^(\S+\/)\s+\((\d+) (?:files?|matches?)\)$/.exec(l))) { prefix = m[1]; continue; } // rtk grep -l: "apps/server/src/ (43 files)"
    if ((m = /^(\S*\/)\s+(\S.*)$/.exec(l)) && !/:\d+:/.test(l) && !/^\d+$/.test(m[1])) { // rtk find: "coord/ a.md b.md"
      const d = m[1] === "./" ? "" : m[1];
      for (const n of m[2].split(/\s+/)) if (!/^\+\d+$/.test(n)) paths.add(relp(d + n));
    }
    if ((m = /^(\S+\.\w+):?\s*(?:\(\d+[^)]*\))?$/.exec(l)) && !/:\d+/.test(l)) curFile = relp(m[1]); // a grouped grep header
    if (curFile && (m = /^(\d+)[:-]\s?/.exec(l))) locs.add(`${curFile}:${m[1]}`);
    for (const mm of l.matchAll(/(?:^|\s)((?:\.\/)?[^\s:]+):(\d+)(?=:|\s|$)/g)) locs.add(`${relp(mm[1])}:${mm[2]}`);
    if (/^\S+$/.test(l)) { paths.add(relp(l)); if (prefix) paths.add(relp(prefix + l)); }
    for (const t of l.split(/\s+/)) if (/[/.]/.test(t)) paths.add(relp(t.replace(/:\d+(:.*)?$/, "")));
  }
  return { flat, tokens, paths, locs, status: gitStatusSet(text) };
}
const bySuffix = (set, v) => set.has(v) || [...set].some((r) => r && v.endsWith("/" + r));
export function present([kind, v], ix) {
  switch (kind) {
    case "status": return ix.status.has(v);
    case "hash": return new RegExp(`\\b${v}`).test(ix.flat);
    case "text": return ix.flat.includes(ws(v));
    case "path": return bySuffix(ix.paths, v) || bySuffix(ix.paths, v.replace(/\/$/, ""));
    case "loc": return bySuffix(ix.locs, v);
    case "dir": return ix.tokens.has(v + "/");
    case "name": return [v, v + "/", v + "*", v + "@"].some((x) => ix.tokens.has(x)) || ix.flat.split("\n").some((l) => l === v || l.endsWith(" " + v));
    default: return false;
  }
}
export function scoreClass(cls, plainText, rtkText) {
  const facts = plainFacts(cls, plainText), ix = rtkIndex(rtkText);
  const by_kind = {};
  let missing = 0;
  for (const fact of facts) {
    const k = (by_kind[fact[0]] ??= { plain: 0, missing: [] });
    k.plain++;
    if (!present(fact, ix)) { k.missing.push(fact[1]); missing++; }
  }
  return { class: cls, items: facts.length, missing_items: missing, parity_percent: facts.length ? +(100 * (facts.length - missing) / facts.length).toFixed(1) : null, by_kind };
}

function main(argv) {
  const pos = [], flags = new Set();
  let cls = null;
  for (let i = 0; i < argv.length; i++) { if (argv[i] === "--class") cls = argv[++i]; else if (argv[i].startsWith("--")) flags.add(argv[i]); else pos.push(argv[i]); }
  const [plainP, rtkP] = pos;
  if (!plainP || !rtkP) { console.error("usage: rtk-fidelity.mjs plain.txt rtk.txt [--class <class>] [--json]"); process.exit(2); }
  if (cls) {
    const r = scoreClass(cls, readFileSync(plainP, "utf8"), readFileSync(rtkP, "utf8"));
    if (flags.has("--json")) console.log(JSON.stringify(r));
    else {
      console.log(`${cls}: items ${r.items} missing ${r.missing_items} parity ${r.parity_percent}%`);
      for (const [k, v] of Object.entries(r.by_kind)) { console.log(`${k}: plain ${v.plain} missing ${v.missing.length}`); for (const x of v.missing.slice(0, 8)) console.log("  MISSING " + x.slice(0, 160)); }
    }
    process.exit(r.parity_percent === null || r.parity_percent >= 95 ? 0 : 1);
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
  if (flags.has("--json")) console.log(JSON.stringify(report));
  else {
    console.log(`items ${total} missing ${missing} parity ${report.parity_percent}%`);
    for (const k of ["names", "messages", "locs"]) { console.log(`${k}: plain ${report[k].plain} rtk ${report[k].rtk} missing ${report[k].missing.length}`); for (const x of report[k].missing.slice(0, 12)) console.log("  MISSING " + x.slice(0, 160)); }
  }
  process.exit(missing ? 1 : 0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
