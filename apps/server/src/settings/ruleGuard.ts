import { ROOT, type DeliveredFile } from '../delivery/types.js';

/**
 * The rule-file guard (D-60, T-404; settings-policies PRD §22.6). A managed PreToolUse hook the portal delivers to every
 * workspace with the policy owner's drop-in (`10-claudepilot-policy.json`), so it binds every Claude Code session in the
 * workspace, Bypass included (hooks run in every permission mode, and exit 2 stops the tool call). It refuses a tool call
 * that would write a rule file: `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, a repository's
 * allow-list checker (`check-allowlist.*`) and Claude Code's own `.claude.json`, in any folder, by Edit, Write, MultiEdit,
 * NotebookEdit, an MCP tool's path argument, or a Bash command with a write form that names or could name one. Reads are
 * allowed. Every refusal appends one line to the outbox (`guard.jsonl`: session, tool, form, path; never content), which the
 * portal turns into a `guard.refused` audit row (`ruleGuardAudit.ts`).
 *
 * Two root-owned files outside every workspace folder: a POSIX sh wrapper that runs the Node half with a fixed `node` and no
 * NODE_OPTIONS (so nothing a session sets loads first), and the Node half. The hook command adds `|| exit 2`: a guard that
 * is missing, crashes or exits with anything but 0 refuses. Written as strings because the portal ships them into
 * workspaces; `ruleGuard.test.ts` runs the real thing against scratch folders.
 */
export const RULE_GUARD_PATH = '/etc/claudepilot/bin/policy-rule-guard';
export const RULE_GUARD_MESSAGE = 'rule files change only through the coordinator (D-60)';

export const RULE_GUARD_WRAPPER = `#!/bin/sh
# claudepilot: the rule-file guard (D-60, T-404), a managed PreToolUse hook. Root-owned. Runs its Node half ("$0.cjs") with
# a fixed node in an emptied environment (/usr/bin/env -i: only HOME, a fixed PATH and the Claude config folder pass), so
# nothing the session can set loads first (NODE_OPTIONS, NODE_PATH, a PATH with its own env). Exit 0 allows; any other
# exit refuses (the hook command adds "|| exit 2").
for n in /usr/local/bin/node /usr/bin/node; do
  if [ -x "$n" ]; then exec /usr/bin/env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" "$n" "$0.cjs"; fi
done
echo "${RULE_GUARD_MESSAGE}: the guard cannot find node, so this tool call is refused" >&2
exit 2
`;

/** The Node half. Plain JavaScript with no dependencies; no backticks and no dollar-brace inside (it is a String.raw). */
export const RULE_GUARD_SCRIPT = String.raw`'use strict';
// claudepilot: the rule-file guard (D-60, T-404). See /etc/claudepilot/bin/policy-rule-guard and the portal's
// docs/prd/settings-policies.md section 22.6. Reads the PreToolUse input on stdin; exit 0 allows, exit 2 refuses.
const fs = require('fs');
const path = require('path');
const os = require('os');

const MESSAGE = 'rule files change only through the coordinator (D-60)';
const OUTBOX_CAP = 1048576;
const HOME = os.homedir() || '/home/node';
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : '';

/* ---------- what a rule file is ---------- */

const SETTINGS_BASE = /^settings(\.local)?\.json$/;
const CHECKER_BASE = /^check-allowlist(\.[A-Za-z0-9]+)?$/;
const ANY_RULE_BASE = /^(settings(\.local)?\.json|\.mcp\.json|\.claude\.json|check-allowlist(\.[A-Za-z0-9]+)?)$/;
// A rule file named in text: the literal paths, a config folder's settings, or the variable that names one.
const MENTION = /\.mcp\.json|\.claude\.json|check-allowlist|\/etc\/+claude-code|\/etc\/+claudepilot|\.claude\/+(\.\/+)*settings(\.local)?\.json|claudes\/[^\s\/'"]+\/+settings(\.local)?\.json|CLAUDE_CONFIG_DIR/;
// Words that could be part of a rule file's name, for values the hook cannot see (a variable, a pipe).
const FRAGMENT_WORDS = /claude|settings|\.mcp|mcp\.json|allowlist/i;
const RULE_NAMES = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.claude.json', 'check-allowlist.mjs'];
// Path patterns compared segment by segment with a glob (the last one is the .claude folder itself).
const CANDIDATES = [['.mcp.json'], ['.claude.json'], ['.claude', 'settings.json'], ['.claude', 'settings.local.json'], ['check-allowlist.mjs'], ['.claude']];

function isConfigDir(dir) {
  if (path.basename(dir) === '.claude') return true;
  if (CONFIG_DIR && dir === CONFIG_DIR) return true;
  return /\/\.claudepilot\/claudes\/[^\/]+$/.test(dir);
}

// Folders whose every file is a rule file: managed settings and their drop-ins, and the guard's own files (B1).
const PROTECTED_ROOTS = ['/etc/claude-code', '/etc/claudepilot'];
const underProtected = (abs) => PROTECTED_ROOTS.some((r) => abs === r || abs.startsWith(r + '/'));

/** The rule file an absolute path is, or null. */
function ruleLabel(abs) {
  if (underProtected(abs)) return abs;
  const base = path.basename(abs);
  if (base === '.mcp.json' || base === '.claude.json' || CHECKER_BASE.test(base)) return abs;
  if (SETTINGS_BASE.test(base) && isConfigDir(path.dirname(abs))) return abs;
  return null;
}

function isClaudeDir(abs) {
  return path.basename(abs) === '.claude';
}

/** The real path, resolving every existing part (a symlinked folder or file), the rest kept as written. */
function realish(abs) {
  try {
    return fs.realpathSync(abs);
  } catch (e) {
    const dir = path.dirname(abs);
    if (dir === abs) return abs;
    return path.join(realish(dir), path.basename(abs));
  }
}

/** A file with more than one link that is one of the rule files near the folder (a hard link made earlier). */
function hardLinked(real, base) {
  let st;
  try {
    st = fs.lstatSync(real);
  } catch (e) {
    return null;
  }
  if (!st.isFile() || st.nlink < 2) return null;
  const dirs = [];
  for (const start of [path.dirname(real), base]) {
    let d = start;
    for (let k = 0; k < 12; k++) {
      dirs.push(d);
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  dirs.push(HOME);
  const rels = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', 'scripts/check-allowlist.mjs', '.claude.json'];
  const files = [];
  for (const d of dirs) for (const r of rels) files.push(path.join(d, r));
  if (CONFIG_DIR) files.push(path.join(CONFIG_DIR, 'settings.json'), path.join(CONFIG_DIR, 'settings.local.json'), path.join(CONFIG_DIR, '.claude.json'));
  for (const f of files) {
    try {
      const o = fs.statSync(f);
      if (o.dev === st.dev && o.ino === st.ino) return f;
    } catch (e) {
      // not there
    }
  }
  return null;
}

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return HOME + p.slice(1);
  return p;
}

/** The rule file (or .claude folder, when dirToo) a literal path names, resolved against base: lexically, through symlinks and hard links. */
function ruleTarget(p, base, dirToo) {
  if (typeof p !== 'string' || !p) return null;
  const abs = path.resolve(base, expandHome(p.replace(/^file:\/\//, '')));
  const lex = ruleLabel(abs);
  if (lex) return lex;
  const real = realish(abs);
  if (real !== abs) {
    const r = ruleLabel(real);
    if (r) return r + ' (through a link)';
  }
  if (dirToo && (isClaudeDir(abs) || isClaudeDir(real))) return abs + ' (a .claude folder)';
  const linked = hardLinked(real, base);
  if (linked) return linked + ' (a hard link)';
  return null;
}

/* ---------- patterns ---------- */

/** Expands {a,b} braces (not nested deeply), at most 64 results. */
function braces(s) {
  const out = [];
  const walk = (str) => {
    if (out.length >= 64) return;
    const open = str.indexOf('{');
    if (open < 0) return void out.push(str);
    let depth = 0;
    let close = -1;
    const commas = [];
    for (let k = open; k < str.length; k++) {
      if (str[k] === '{') depth++;
      else if (str[k] === '}') {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      } else if (str[k] === ',' && depth === 1) commas.push(k);
    }
    if (close < 0 || commas.length === 0) {
      const range = close > 0 ? /^(-?\w+)\.\.(-?\w+)$/.exec(str.slice(open + 1, close)) : null;
      if (!range) return void out.push(str);
      return void out.push(str.slice(0, open) + '*' + str.slice(close + 1));
    }
    const parts = [];
    let from = open + 1;
    for (const c of commas.concat([close])) {
      parts.push(str.slice(from, c));
      from = c + 1;
    }
    for (const p of parts) walk(str.slice(0, open) + p + str.slice(close + 1));
  };
  walk(s);
  return out;
}

const esc = (c) => c.replace(/[.+^$()|\\\/{}]/g, '\\$&');

/** One path segment of a pattern as a regex. NUL stands for a value the hook cannot see. */
function segRegex(seg, dotglob) {
  let re = '';
  for (let k = 0; k < seg.length; k++) {
    const c = seg[k];
    if (c === '\u0000') re += '.*';
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = seg.indexOf(']', k + 2);
      if (end < 0) re += '\\[';
      else {
        let cls = seg.slice(k + 1, end);
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        re += '[' + cls.replace(/\\/g, '\\\\') + ']';
        k = end;
      }
    } else re += esc(c);
  }
  const dotRule = !dotglob && /^[*?[]/.test(seg) ? '(?!\\.)' : '';
  try {
    return new RegExp('^' + dotRule + re + '$');
  } catch (e) {
    return /^.*$/;
  }
}

/** Whether a glob pattern reaches a protected folder or below it (/etc/claude-code/*, /e*c/claudepilot). */
function globUnderProtected(p, baseDir) {
  if (!path.isAbsolute(p) && baseDir === null) return false;
  const segs = path.resolve(baseDir || '/', p).split('/').filter(Boolean);
  for (const root of PROTECTED_ROOTS) {
    const rs = root.split('/').filter(Boolean);
    if (segs.length < rs.length) continue;
    let ok = true;
    for (let j = 0; j < rs.length && ok; j++) ok = segRegex(segs[j], true).test(rs[j]);
    if (ok) return true;
  }
  return false;
}

/** Whether a glob pattern could match a rule file (or the .claude folder) below base (null: base unknown). */
function couldMatch(pattern, baseDir, dotglob) {
  for (const p of braces(pattern)) {
    const segs = expandHome(p).split('/').filter((s) => s !== '' && s !== '.');
    if (segs.length === 0) continue;
    if (globUnderProtected(expandHome(p), baseDir)) return true;
    for (const cand of CANDIDATES) {
      const k = Math.min(segs.length, cand.length);
      let ok = true;
      for (let j = 1; j <= k && ok; j++) ok = segRegex(segs[segs.length - j], dotglob).test(cand[cand.length - j]);
      if (!ok) continue;
      if (segs.length < cand.length) {
        // The pattern is relative to base: base itself must be the rest of the candidate (a .claude folder).
        const rest = cand.slice(0, cand.length - segs.length);
        if (baseDir === null || pattern.startsWith('/')) {
          if (baseDir === null) return true;
          continue;
        }
        const tail = realish(baseDir).split('/').slice(-rest.length);
        if (tail.join('/') === rest.join('/')) return true;
        continue;
      }
      return true;
    }
  }
  return false;
}

/** Whether a quoted string in code is a piece (3+ characters) of a rule file's name: '.cla' + 'ude/settings.json'. */
function hasFragmentString(code) {
  const re = /(['"\x60])((?:\\.|(?!\1)[^\\\n]){3,200})\1/g;
  let m;
  while ((m = re.exec(code))) {
    const s = m[2];
    if (FRAGMENT_WORDS.test(s)) return true;
    for (const name of RULE_NAMES) if (name.includes(s)) return true;
  }
  return false;
}

// Code that writes a file or runs a command (which could).
const WRITE_API = /writeFile|appendFile|createWriteStream|copyFile|\bcp(Sync)?\(|rename|unlink|\brm(Sync)?\(|rmdir|symlink|\blink(Sync)?\(|truncate|chmod|open(Sync)?\([^)]*['"][wax+]|['"](w|a|x|wb|ab|w\+|a\+|r\+)['"]|\.write(_text|_bytes)?\(|shutil\.|os\.(replace|remove)|\bFile\.(write|open)|IO\.write|child_process|exec(Sync|File)?\(|spawn|system\(|subprocess|popen|Deno\.write|Bun\.write|print\s*>|printf[^;\n]*>|>\s*['"]?[\w.~\/$]|\btee\b|sed\s+-i|\bmv\s|\bcp\s/i;
const OBFUSCATION = /fromCharCode|atob\(|base64|b64decode|\\x[0-9a-f]{2}|\\u00[0-9a-f]{2}|\bchr\(|unhexlify|codecs\.|rot13|reverse\(\)|\[::-1\]|String\.raw|decodeURIComponent|unescape\(|\bpack\(/i;

function inlineSuspicious(code) {
  if (!WRITE_API.test(code)) return false;
  return MENTION.test(code) || FRAGMENT_WORDS.test(code) || hasFragmentString(code) || OBFUSCATION.test(code);
}

/** A script file run directly: comments dropped, refused when its code names a rule file and writes. */
function scriptSuspicious(file, base) {
  let text;
  try {
    const abs = path.resolve(base || process.cwd(), expandHome(file));
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 2097152) return false;
    if (CHECKER_BASE.test(path.basename(abs))) return false; // running the checker is a read
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return false;
  }
  const code = text
    .split('\n')
    .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
    .join('\n');
  return MENTION.test(code) && WRITE_API.test(code);
}

/** A patch's file names (diff headers) that are rule files. */
function patchNamesRule(text, base) {
  for (const line of String(text).split('\n')) {
    const m = /^(?:diff --git a\/(\S+) b\/(\S+)|\+\+\+ (\S+)|--- (\S+)|rename (?:from|to) (\S+)|copy (?:from|to) (\S+)|Index: (\S+))/.exec(line);
    if (!m) continue;
    for (const raw of m.slice(1)) {
      if (!raw || raw === '/dev/null') continue;
      const p = raw.replace(/^[ab]\//, '');
      if (ANY_RULE_BASE.test(path.basename(p)) && (ruleTarget(p, base || '/', false) || !SETTINGS_BASE.test(path.basename(p)))) return p;
      if (path.basename(p) === '.claude' || /(^|\/)\.claude\/settings(\.local)?\.json$/.test(p)) return p;
    }
  }
  return null;
}

/* ---------- the shell ---------- */

function matchParen(src, k) {
  let depth = 0;
  for (let j = k; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === "'") {
      const e = src.indexOf("'", j + 1);
      j = e < 0 ? src.length : e;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return src.length;
}

function skipVar(src, j) {
  if (src[j + 1] === '{') {
    const e = src.indexOf('}', j + 2);
    return e < 0 ? src.length : e + 1;
  }
  if (/[0-9@*#?$!-]/.test(src[j + 1])) return j + 2;
  let k = j + 1;
  while (k < src.length && /[A-Za-z0-9_]/.test(src[k])) k++;
  return k;
}

function ansiC(src, i) {
  // src[i] is the quote after $
  let j = i + 1;
  let s = '';
  while (j < src.length && src[j] !== "'") {
    if (src[j] === '\\' && j + 1 < src.length) {
      const c = src[j + 1];
      let m;
      if (c === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(j + 2)))) {
        s += String.fromCharCode(parseInt(m[0], 16));
        j += 2 + m[0].length;
        continue;
      }
      if (c === 'u' && (m = /^[0-9a-fA-F]{1,4}/.exec(src.slice(j + 2)))) {
        s += String.fromCharCode(parseInt(m[0], 16));
        j += 2 + m[0].length;
        continue;
      }
      if ((m = /^[0-7]{1,3}/.exec(src.slice(j + 1)))) {
        s += String.fromCharCode(parseInt(m[0], 8));
        j += 1 + m[0].length;
        continue;
      }
      const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };
      s += map[c] !== undefined ? map[c] : c;
      j += 2;
      continue;
    }
    s += src[j++];
  }
  return { text: s, end: j + 1 };
}

const VAR_START = /[A-Za-z_{0-9@*#?$!-]/;
// A parameter expansion that ASSIGNS a refused GIT_ name (dollar, brace, name, := or =): it sets the variable where no assignment word shows (T-860 S2c).
function assignsGit(src, j) {
  const m = /^\$\{(GIT_[A-Za-z0-9_]*):?=/.exec(src.slice(j, j + 80));
  return !!m && (EXEC_ENV.test(m[1]) || /^GIT_TRACE/.test(m[1]));
}

/**
 * Splits a command line into words (quotes removed; NUL where a value is not known: a variable, $(...), backticks),
 * operators and redirections. Command substitutions and heredoc bodies are collected for their own checks.
 */
function lex(src) {
  const tokens = [];
  const subs = [];
  const bodies = [];
  const pendingDocs = [];
  let awaitingDelim = null;
  // Set when a quote is never closed or a backslash ends the text: the shell would not run it as written (T-860).
  let bad = false;
  let gitAssign = false;
  let cur = null;
  let i = 0;
  const n = src.length;
  const word = () => (cur || (cur = { t: 'w', text: '', dyn: false, glob: false, quoted: false }));
  const end = () => {
    if (!cur) return;
    tokens.push(cur);
    if (awaitingDelim) {
      pendingDocs.push({ delim: cur.text, strip: awaitingDelim.strip, redir: awaitingDelim.redir });
      awaitingDelim = null;
    }
    cur = null;
  };
  const readBodies = () => {
    while (pendingDocs.length) {
      const doc = pendingDocs.shift();
      const lines = [];
      while (i < n) {
        const e = src.indexOf('\n', i);
        const line = src.slice(i, e < 0 ? n : e);
        i = e < 0 ? n : e + 1;
        if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break;
        lines.push(line);
      }
      doc.redir.body = lines.join('\n');
      bodies.push(doc.redir.body);
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      const w = word();
      if (i + 1 >= n) bad = true;
      w.text += src[i + 1] || '';
      w.quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e < 0) bad = true;
      const stop = e < 0 ? n : e;
      const w = word();
      w.text += src.slice(i + 1, stop);
      w.quoted = true;
      i = stop + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      const a = ansiC(src, i + 1);
      const w = word();
      w.text += a.text;
      w.quoted = true;
      i = a.end;
      continue;
    }
    if (c === '"') {
      const w = word();
      w.quoted = true;
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          w.text += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '(') {
          const e = matchParen(src, j + 1);
          subs.push(src.slice(j + 2, e));
          if (src[j + 2] !== '(') (w.subst || (w.subst = [])).push(src.slice(j + 2, e));
          w.dyn = true;
          w.text += '\u0000';
          j = e + 1;
          continue;
        }
        if (src[j] === '\x60') {
          const e = src.indexOf('\x60', j + 1);
          const stop = e < 0 ? n : e;
          subs.push(src.slice(j + 1, stop));
          (w.subst || (w.subst = [])).push(src.slice(j + 1, stop));
          w.dyn = true;
          w.text += '\u0000';
          j = stop + 1;
          continue;
        }
        if (src[j] === '$' && VAR_START.test(src[j + 1] || '')) {
          if (assignsGit(src, j)) gitAssign = true;
          w.dyn = true;
          w.text += '\u0000';
          j = skipVar(src, j);
          continue;
        }
        w.text += src[j++];
      }
      if (j >= n) bad = true;
      i = j + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const e = matchParen(src, i + 1);
      const w = word();
      if (src[i + 2] !== '(') {
        subs.push(src.slice(i + 2, e));
        (w.subst || (w.subst = [])).push(src.slice(i + 2, e));
      }
      w.dyn = true;
      w.text += '\u0000';
      i = e + 1;
      continue;
    }
    if (c === '\x60') {
      const e = src.indexOf('\x60', i + 1);
      const stop = e < 0 ? n : e;
      subs.push(src.slice(i + 1, stop));
      const w = word();
      (w.subst || (w.subst = [])).push(src.slice(i + 1, stop));
      w.dyn = true;
      w.text += '\u0000';
      i = stop + 1;
      continue;
    }
    if (c === '$' && VAR_START.test(src[i + 1] || '')) {
      if (assignsGit(src, i)) gitAssign = true;
      const w = word();
      w.dyn = true;
      w.text += '\u0000';
      i = skipVar(src, i);
      continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const e = matchParen(src, i + 1);
      subs.push(src.slice(i + 2, e));
      const w = word();
      (w.subst || (w.subst = [])).push(src.slice(i + 2, e));
      w.dyn = true;
      w.text += '\u0000';
      i = e + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      end();
      i++;
      continue;
    }
    if (c === '#' && !cur) {
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '\n') {
      end();
      tokens.push({ t: 'op', v: ';' });
      i++;
      readBodies();
      continue;
    }
    if (c === '&' && src[i + 1] === '>') {
      end();
      const v = src[i + 2] === '>' ? '&>>' : '&>';
      tokens.push({ t: 'redir', v: v, fd: null });
      i += v.length;
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      end();
      let v = c;
      if ((c === '&' || c === '|' || c === ';') && src[i + 1] === c) v = c + c;
      else if (c === '|' && src[i + 1] === '&') v = '|&';
      tokens.push({ t: 'op', v: v });
      i += v.length;
      continue;
    }
    if (c === '>' || c === '<') {
      let fd = null;
      if (cur && !cur.quoted && !cur.dyn && /^\d+$/.test(cur.text)) {
        fd = cur.text;
        cur = null;
      }
      end();
      let v = c;
      let j = i + 1;
      if (c === '<' && src[j] === '<') {
        v = '<<';
        j++;
        if (src[j] === '<') {
          v = '<<<';
          j++;
        } else if (src[j] === '-') {
          v = '<<-';
          j++;
        }
      } else if (c === '>' && (src[j] === '>' || src[j] === '|')) {
        v += src[j];
        j++;
      } else if (c === '<' && src[j] === '>') {
        v = '<>';
        j++;
      }
      if ((v === '>' || v === '<') && src[j] === '&') {
        v += '&';
        j++;
      }
      const tok = { t: 'redir', v: v, fd: fd, body: null };
      tokens.push(tok);
      if (v === '<<' || v === '<<-') awaitingDelim = { strip: v === '<<-', redir: tok };
      i = j;
      continue;
    }
    const w = word();
    if (c === '*' || c === '?' || c === '[' || c === '{') w.glob = true;
    w.text += c;
    i++;
  }
  end();
  readBodies();
  return { tokens: tokens, subs: subs, bodies: bodies, bad: bad, gitAssign: gitAssign };
}

/** Simple commands: words and redirections between operators; whether stdin comes from a pipe. */
function commands(tokens) {
  const out = [];
  let cur = { words: [], redirs: [], piped: false, open: 0, close: 0 };
  let opens = 0;
  const flush = (op) => {
    if (cur.words.length || cur.redirs.length || cur.open || cur.close) out.push(cur);
    cur = { words: [], redirs: [], piped: op === '|' || op === '|&', open: 0, close: 0 };
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'op') {
      if (t.v === '(') {
        flush(';');
        cur.open = ++opens;
        continue;
      }
      if (t.v === ')') {
        flush(';');
        out.push({ words: [], redirs: [], piped: false, open: 0, close: 1 });
        continue;
      }
      flush(t.v);
      continue;
    }
    if (t.t === 'redir') {
      const target = tokens[k + 1] && tokens[k + 1].t === 'w' ? tokens[++k] : null;
      cur.redirs.push({ v: t.v, fd: t.fd, target: target, body: t.body });
      continue;
    }
    cur.words.push(t);
  }
  flush(';');
  return out;
}

// Shell words that start a compound command: the command proper follows them.
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', 'coproc']);
const SHELLS = new Set(['sh','bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'rbash']);
const INTERPRETERS = /^(node|nodejs|deno|bun|tsx|ts-node|python[0-9.]*|pypy[0-9.]*|perl[0-9.]*|ruby[0-9.]*|irb|php[0-9.]*|lua[0-9.]*|luajit|Rscript|R|osascript|pwsh|powershell|awk|gawk|mawk|nawk|groovy|jshell|sqlite3|claude|julia|tclsh|wish|guile|racket|elixir|erl|swift|kotlin|scala)$/;
const WRITE_ALL = new Set(['rm', 'unlink', 'shred', 'truncate', 'touch', 'chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'mkdir', 'rmdir', 'mkfifo', 'mknod', 'ln', 'link', 'tee', 'sponge', 'vi', 'vim', 'nvim', 'view', 'ex', 'ed', 'nano', 'emacs', 'pico', 'joe', 'micro', 'trash', 'trash-put', 'srm', 'wipe', 'split', 'csplit', 'patchelf', 'setfattr']);
const COPIERS = new Set(['cp', 'install', 'rsync', 'scp', 'mv', 'gcp', 'ditto']);
const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'jq', 'yq', 'wc', 'diff', 'cmp', 'stat', 'file', 'ls', 'tree', 'realpath', 'readlink', 'basename', 'dirname', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'b2sum', 'od', 'hexdump', 'strings', 'nl', 'tac', 'bat', 'batcat', 'echo', 'printf', 'test', '[', '[[', 'true', 'false', 'type', 'which', 'column', 'cut', 'uniq', 'comm', 'fold', 'fmt', 'rev', 'tr', 'cd', 'pushd', 'popd', 'pwd', 'du', 'df', 'wc', 'colordiff', 'delta', 'icdiff', 'git-log', 'exit', 'return', ':', 'sleep', 'date', 'id', 'whoami', 'hostname', 'uname']);
const GIT_READS = new Set(['log', 'show', 'diff', 'status', 'blame', 'ls-files', 'ls-tree', 'grep', 'cat-file', 'rev-parse', 'check-ignore', 'check-attr', 'shortlog', 'describe', 'whatchanged', 'reflog', 'annotate', 'add', 'commit', 'fetch', 'push', 'branch', 'tag', 'remote', 'config', 'worktree', 'clone', 'init', 'log', 'help', 'version', 'difftool', 'range-diff', 'name-rev', 'for-each-ref', 'show-ref', 'merge-base', 'notes', 'bisect', 'gc', 'fsck', 'count-objects', 'verify-commit', 'archive', 'bundle', 'format-patch', 'request-pull', 'send-email']);
const GIT_PATH_WRITES = new Set(['checkout', 'restore', 'rm', 'mv', 'reset', 'clean', 'checkout-index', 'update-index', 'merge-file', 'stash', 'sparse-checkout']);
const DECODER = /\bbase(64|32)\b[^|;&\n]*\s(-d|--decode|-D)\b|\bxxd\b[^|;&\n]*\s-r|\bopenssl\b[^|;&\n]*\s(base64|enc)\b[^|;&\n]*\s-d\b|\buudecode\b|\\x[0-9a-fA-F]{2}|\\[0-7]{3}|\brev\b|\btr\b|\bgunzip\b|\bzcat\b|\bgzip\b[^|;&\n]*\s-d|\bperl\b[^|;&\n]*\bpack\b|\bfromCharCode\b|\batob\b/;

// Review 2 (T-404): forms that run a command the text shows in an odd place (a variable, a git -c value, a sed script).
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
// Variables a program runs as a command, loads code from, or that move where it writes: GIT_EDITOR, LESSOPEN, PAGER, ...
const EXEC_ENV = /^(GIT_(?!AUTHOR_|COMMITTER_|TERMINAL_PROMPT$|TRACE|OPTIONAL_LOCKS$|PAGER_IN_USE$)[A-Z0-9_]+|LESSOPEN|LESSCLOSE|LESSKEY|LESSKEYIN|LESSEDIT|[A-Z0-9_]*(PAGER|EDITOR|VISUAL|ASKPASS|COMMAND|_CMD|_PROGRAM|_SHELL|_HOOK)|BROWSER|BASH_ENV|ENV|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|PS[0-4]|IFS|LD_[A-Z_]+|DYLD_[A-Z_]+|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PYTHONINSPECT|PERL5OPT|PERL5LIB|PERLLIB|PERL5DB|RUBYOPT|RUBYLIB|TAR_OPTIONS|RIPGREP_CONFIG_PATH|SED|AWKPATH|MANOPT|TERMINFO)$/;
// A value of such a variable that runs nothing of its own.
const BENIGN_VALUE = /^(|cat|less|less -R|more|true|false|:|0|1|never)$/;
// git -c keys that run nothing and move no file.
const GIT_SAFE_CONFIG = /^(color\.[\w.-]+|advice\.[\w.-]+|user\.(name|email)|log\.[\w.-]+|format\.pretty|diff\.(renames|algorithm|noprefix|relative|mnemonicprefix|colormoved|submodule|indentheuristic)|core\.(quotepath|autocrlf|safecrlf|filemode|abbrev|ignorecase|precomposeunicode)|init\.defaultbranch|safe\.directory|pull\.(rebase|ff)|push\.(default|autosetupremote)|commit\.gpgsign|tag\.gpgsign|protocol\.version|fetch\.[\w.-]+|merge\.conflictstyle|rebase\.(autosquash|autostash)|status\.[\w.-]+|column\.ui|pager\.[\w-]+=(true|false)$|maintenance\.auto|gc\.auto)(=|$)/i;
// A sed script that runs a shell: the e command (1e CMD) or the e flag of s///e.
const SED_EXEC = /(^|[;\n{}!0-9$\/,|#~+])\s*e(\s|;|}|$)|(^|[^\\])[\/|#,:@!]\s*[gpiImMw0-9]*e[gpiImMw0-9]*\s*([;}\n]|$)/;
// Preprocessors rg --pre may run: they only print a file.
const PRE_OK = /^(cat|zcat|gzcat|bzcat|xzcat|zstdcat|lz4cat|pdftotext|catdoc|antiword)$/;

const nameOf = (w) => (w && !w.dyn ? path.basename(w.text) : '');
const shown = (w) => (w ? w.text.replace(/\u0000/g, '$…').slice(0, 300) : '');

function analyzeBash(command, cwd) {
  const st = { cwd: cwd, depth: 0 };
  // What the whole command shows: decoded words, command substitutions and heredoc bodies included.
  const all = [];
  const collect = (src, d) => {
    if (d > 6) return;
    const l = lex(src);
    all.push(src);
    for (const t of l.tokens) if (t.t === 'w') all.push(t.text);
    for (const b of l.bodies) all.push(b);
    for (const s of l.subs) collect(s, d + 1);
  };
  collect(command, 0);
  const flat = all.join(' ');
  st.mentions = MENTION.test(flat) || all.some((s) => typeof s === 'string' && s.length < 400 && MENTION.test(s));
  // A piece of a rule file's name: one of its words, or a word with a dot, slash or dash inside a name ('.cla', 'ude/s').
  st.fragments = st.mentions || FRAGMENT_WORDS.test(flat) || all.some((s) => s.length >= 3 && s.length <= 60 && /[.\/-]/.test(s) && !/\s/.test(s) && RULE_NAMES.some((nm) => nm.includes(s)));
  st.decoder = DECODER.test(flat);
  st.dotglob = /dotglob|GLOBIGNORE|globdots|GLOB_DOTS/.test(flat);
  const found = analyze(command, st, cwd, 0);
  if (found) return found;
  // A git -C in one command and a link, a move or a config change in another of the same line: the guard reads the path before the
  // line runs, and (ln -sfn OUT lane/l, then git -C lane/l commit) points it somewhere else by then (T-860).
  if (st.gitC && st.swap && st.swap.some((s) => st.gitC.some((g) => g !== s))) return hit('git -C in a command line that also changes links, folders or config', '');
  return null;
}

function hit(form, p) {
  return { form: form, path: p };
}

/**
 * Checks one write target. Literal: the rule file it is (through links). Pattern: whether it could match one.
 * Unknown value (a variable, a substitution): refused when the command shows a piece of a rule file's name, or decodes.
 */
function checkTarget(w, st, base, form, opts) {
  if (!w) return null;
  const dotglob = st.dotglob || !!(opts && opts.dotglob);
  if (w.dyn) {
    if (st.fragments || st.decoder) return hit(form + ' to a value the guard cannot see', shown(w));
    if (w.glob && couldMatch(w.text, base, dotglob)) return hit(form + ' to a pattern', shown(w));
    return null;
  }
  for (const e of braces(w.text)) {
    if (w.glob && /[*?[]/.test(e)) {
      if (couldMatch(e, base, dotglob)) return hit(form + ' to a pattern', shown(w));
      continue;
    }
    if (base === null) {
      const b = path.basename(e);
      if (ANY_RULE_BASE.test(b) || b === '.claude') return hit(form + ' after a change of folder', e);
      if (path.isAbsolute(expandHome(e))) {
        const r = ruleTarget(e, '/', true);
        if (r) return hit(form, r);
      }
      continue;
    }
    const r = ruleTarget(e, base, true);
    if (r) return hit(form, r);
  }
  return null;
}

/** Whether any word of a command names a rule file (literal, pattern or text). */
function namesRule(words, st, base) {
  for (const w of words) {
    if (MENTION.test(w.text)) return shown(w);
    if (w.dyn) continue;
    if (w.glob && couldMatch(w.text, base, st.dotglob)) return shown(w);
    if (w.glob) continue;
    if (w.text.length > 1000 || /\s/.test(w.text)) continue;
    const r = base === null ? (ANY_RULE_BASE.test(path.basename(w.text)) ? w.text : null) : ruleTarget(w.text, base, true);
    if (r) return r;
  }
  return null;
}

/**
 * Strips wrappers (sudo, env, timeout, nice, xargs, ...) and leading assignments; returns the real command's words, the
 * assignments it stripped (each checked by the caller), a folder the wrapper changes to (env -C, sudo -D), and whether
 * an env -S string was a value the guard cannot see.
 */
function unwrap(words) {
  let ws = words.slice();
  let xargs = false;
  const assigns = [];
  let chdir;
  let unseen = false;
  const takeAssigns = () => {
    while (ws.length && ASSIGN.test(ws[0].text)) assigns.push(ws.shift());
  };
  for (let guard = 0; guard < 12 && ws.length; guard++) {
    takeAssigns();
    while (ws.length && !ws[0].dyn && KEYWORDS.has(ws[0].text)) ws.shift();
    if (!ws.length) break;
    const name = nameOf(ws[0]);
    const skipOpts = (withArg) => {
      ws.shift();
      while (ws.length && ws[0].text.startsWith('-') && ws[0].text !== '-') {
        const o = ws.shift().text;
        if (o === '--') break;
        if (withArg.test(o)) ws.shift();
      }
    };
    if (name === 'sudo' || name === 'doas') {
      ws.shift();
      while (ws.length && ws[0].text.startsWith('-') && ws[0].text !== '-') {
        const o = ws.shift();
        if (o.text === '--') break;
        if (o.text === '-D' || o.text === '--chdir') chdir = ws.shift() || { text: '', dyn: true };
        else if (o.text.startsWith('--chdir=')) chdir = Object.assign({}, o, { text: o.text.slice(8) });
        else if (/^-[ugChprtU]$/.test(o.text)) ws.shift();
      }
    } else if (name === 'env') {
      // env -S 'cmd args' splits the string into the command (review 2, item 3); env -C runs it in another folder.
      ws.shift();
      while (ws.length && ws[0].text.startsWith('-') && ws[0].text !== '-') {
        const o = ws.shift();
        const t = o.text;
        if (t === '--') break;
        let split = null;
        const s = /^-[0iv]*S(.*)$/.exec(t);
        if (s) split = s[1] ? Object.assign({}, o, { text: s[1] }) : ws.shift() || null;
        else if (t === '--split-string') split = ws.shift() || null;
        else if (t.startsWith('--split-string=')) split = Object.assign({}, o, { text: t.slice(15) });
        else if (t === '-C' || t === '--chdir') chdir = ws.shift() || { text: '', dyn: true };
        else if (/^-C./.test(t)) chdir = Object.assign({}, o, { text: t.slice(2) });
        else if (t.startsWith('--chdir=')) chdir = Object.assign({}, o, { text: t.slice(8) });
        else if (/^-u$|^--unset$/.test(t)) ws.shift();
        if (split) {
          if (split.dyn) unseen = true;
          else ws = lex(split.text).tokens.filter((x) => x.t === 'w').concat(ws);
          break;
        }
      }
      takeAssigns();
    } else if (name === 'command' || name === 'builtin' || name === 'nohup' || name === 'time' || name === 'chronic' || name === 'unbuffer' || name === 'exec') skipOpts(/^-a$/);
    else if (name === 'nice' || name === 'ionice' || name === 'stdbuf' || name === 'chrt') skipOpts(/^-[ncpoei]$/);
    else if (name === 'setsid') skipOpts(/^$/);
    else if (name === 'taskset') {
      // taskset [-c] MASK|LIST command: one word (the mask, or the list after -c) comes between the options and the command.
      ws.shift();
      while (ws.length && ws[0].text.startsWith('-') && ws[0].text !== '-') if (ws.shift().text === '--') break;
      ws.shift();
    } else if (name === 'timeout') {
      skipOpts(/^-[sk]$|^--(signal|kill-after)$/);
      ws.shift();
    } else if (name === 'xargs') {
      skipOpts(/^-[IidLnPsEa]$|^--(replace|delimiter|max-lines|max-args|max-procs|max-chars|eof|arg-file)$/);
      xargs = true;
    } else if (name === 'strace' || name === 'ltrace' || name === 'watch' || name === 'caffeinate' || name === 'flock') {
      const wasFlock = name === 'flock';
      skipOpts(/^-[oesnwEcd]$/);
      if (wasFlock && ws.length) ws.shift();
    } else break;
  }
  return { words: ws, xargs: xargs, assigns: assigns, chdir: chdir, unseen: unseen };
}

/**
 * One assignment word (review 2, item 2). Set for a command (FOO=x cmd, env FOO=x cmd): refused when its value names a
 * rule file. A variable that runs a command or loads code (GIT_EDITOR, LESSOPEN, PAGER, NODE_OPTIONS, ...), wherever it
 * is set: refused when its value runs something and the command shows a piece of a rule file's name or decodes.
 */
function assignHit(w, st, forCommand) {
  const m = ASSIGN.exec(w.text);
  if (!m) return null;
  const value = w.text.slice(m[0].length);
  if (forCommand && MENTION.test(value)) return hit('a variable naming a rule file, set for a command', '');
  if (EXEC_ENV.test(m[1]) && !(BENIGN_VALUE.test(value) && !w.dyn) && (st.fragments || st.decoder)) return hit('a variable that runs code (' + m[1] + ') in a command that names a rule file', '');
  return null;
}

/** A reader's option that runs a program or writes a file: rg --pre, less +!cmd and -o FILE, a --pager. */
function readerExec(name, args, st, base) {
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    const t = w.text;
    if (name === 'rg') {
      const m = /^--(pre|hostname-bin)(?:=(.*))?$/.exec(t);
      if (m) {
        const v = m[2] !== undefined ? Object.assign({}, w, { text: m[2] }) : args[k + 1];
        if (!v || v.dyn || m[1] === 'hostname-bin' || !PRE_OK.test(path.basename(v.text))) return hit('rg running a program on what it searches', '');
      }
    }
    if (name === 'less' || name === 'more') {
      if (/^\+.*[!|]/.test(t) || (/^\+/.test(t) && w.dyn)) return hit(name + ' running a command', '');
      const o = /^(-o|-O|--log-file|--LOG-FILE)(?:=?(.+))?$/.exec(t);
      if (o && name === 'less') {
        const target = o[2] !== undefined ? Object.assign({}, w, { text: o[2] }) : args[k + 1];
        const r = checkTarget(target, st, base, 'less --log-file');
        if (r) return r;
      }
    }
    const pg = /^--pager(?:=(.*))?$/.exec(t);
    if (pg) {
      const v = pg[1] !== undefined ? Object.assign({}, w, { text: pg[1] }) : args[k + 1];
      if (v && (v.dyn || !BENIGN_VALUE.test(v.text)) && (st.fragments || st.decoder)) return hit(name + ' --pager in a command that names a rule file', '');
    }
  }
  return null;
}

/** Whether a sed command's scripts run a shell (the e command, s///e), scripts in -f files included. */
function sedRunsShell(args, base) {
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    const t = w.text;
    if (t === '-f' || t === '--file') {
      const f = args[++k];
      if (!f || f.dyn) return true;
      if (SED_EXEC.test(readSmall(f.text, base))) return true;
      continue;
    }
    if (t.startsWith('--file=')) {
      if (SED_EXEC.test(readSmall(t.slice(7), base))) return true;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(t) && !w.dyn) continue;
    const s = t.startsWith('--expression=') ? t.slice(13) : t;
    if (SED_EXEC.test(s)) return true;
  }
  return false;
}

function nonOptions(words) {
  const out = [];
  let dashdash = false;
  for (const w of words) {
    if (!dashdash && w.text === '--') {
      dashdash = true;
      continue;
    }
    if (!dashdash && w.text.startsWith('-') && w.text !== '-' && !w.dyn) continue;
    out.push(w);
  }
  return out;
}

const synth = (dest, src, sep) => ({ t: 'w', text: dest.text.replace(/\/+$/, '') + (sep || '/') + path.basename(src.text.replace(/\/+\.?$/, '')), dyn: dest.dyn || src.dyn, glob: dest.glob || src.glob, quoted: true });

/** A folder below which a rule file exists (bounded walk), or null. */
function treeHasRule(dir) {
  const queue = [dir];
  let seen = 0;
  while (queue.length && seen < 3000) {
    const d = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entries) {
      seen++;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        if (p.split('/').length - dir.split('/').length < 8) queue.push(p);
      } else if (ruleLabel(p)) return p;
    }
  }
  return null;
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function copier(name, words, st, base) {
  let tdir = null;
  let recursive = name === 'rsync' || name === 'ditto';
  const pos = [];
  let dashdash = false;
  for (let k = 1; k < words.length; k++) {
    const w = words[k];
    const t = w.text;
    if (!dashdash && !w.dyn && t === '--') {
      dashdash = true;
      continue;
    }
    if (!dashdash && !w.dyn && t.startsWith('-') && t !== '-') {
      if (t === '-t' || t === '--target-directory') {
        tdir = words[++k] || null;
        continue;
      }
      if (t.startsWith('--target-directory=')) {
        tdir = Object.assign({}, w, { text: t.slice(19) });
        continue;
      }
      if (/^-[A-Za-z]*[rRa]/.test(t) || t === '--recursive' || t === '--archive') recursive = true;
      if (name === 'install' && /^-[mogS]$/.test(t)) k++;
      if ((name === 'rsync' || name === 'scp') && /^-[eFiloPS]$/.test(t)) k++;
      continue;
    }
    pos.push(w);
  }
  const dest = tdir || pos.pop();
  if (!dest) return null;
  const sources = pos;
  const destAbs = !dest.dyn && base !== null ? path.resolve(base, expandHome(dest.text)) : null;
  const destIsDir = !!tdir || /\/$/.test(dest.text) || (destAbs !== null && isDir(destAbs));
  // Into a folder: what lands is checked per source below; the folder itself only when it is the thing written.
  let r = destIsDir ? (dest.dyn && (st.fragments || st.decoder) ? hit(name + ' to a value the guard cannot see', shown(dest)) : null) : checkTarget(dest, st, base, name);
  if (r) return r;
  const intoClaude = destAbs !== null && (isClaudeDir(destAbs) || isClaudeDir(realish(destAbs)));
  for (const s of sources) {
    if (name === 'mv') {
      r = checkTarget(s, st, base, 'mv');
      if (r) return r;
    }
    if (destIsDir) {
      r = checkTarget(synth(dest, s), st, base, name);
      if (r) return r;
    }
    if (s.dyn || s.glob) {
      if (intoClaude) return hit(name + ' of names the guard cannot see into a .claude folder', destAbs);
      continue;
    }
    // A folder copied or moved: every file it holds lands somewhere; one that lands on a rule file is refused.
    if ((recursive || name === 'mv') && base !== null && destAbs !== null) {
      const srcAbs = path.resolve(base, expandHome(s.text));
      if (isDir(srcAbs)) {
        const contents = (name === 'rsync' && /\/$/.test(s.text)) || /\/\.$/.test(s.text);
        const root = destIsDir && !contents ? path.join(destAbs, path.basename(srcAbs)) : destAbs;
        const landed = treeLandsOnRule(srcAbs, root);
        if (landed === 'too big' && st.fragments) return hit(name + ' of a folder too big to check', srcAbs);
        if (landed && landed !== 'too big') return hit(name + ' of a folder that would write a rule file', landed);
      }
    }
  }
  return null;
}

/** Where a folder's files land when copied to root: the first that is a rule file, 'too big' past the walk's bound, or null. */
function treeLandsOnRule(srcAbs, root) {
  const rootReal = realish(root);
  const queue = [''];
  let seen = 0;
  while (queue.length) {
    const rel = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(path.join(srcAbs, rel), { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entries) {
      if (++seen > 5000) return 'too big';
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.git' && r.split('/').length < 10) queue.push(r);
        continue;
      }
      const target = path.join(rootReal, r);
      if (ruleLabel(target)) return target;
    }
  }
  return null;
}

function analyze(command, st, cwd, depth) {
  if (depth > 6) return st.fragments ? hit('nested commands too deep', '') : null;
  const l = lex(command);
  if (l.bad && /(^|[^A-Za-z0-9_-])git([^A-Za-z0-9_-]|$)/.test(command) && gitCRoots().active) return hit('git in a command with an unclosed quote or a trailing backslash (a lane workspace)', '');
  if (l.gitAssign && gitCRoots().active) return hit('a parameter expansion that assigns a GIT_ variable that moves a folder or runs a program, in a lane workspace', '');
  for (const sub of l.subs) {
    const r = analyze(sub, st, cwd, depth + 1);
    if (r) return r;
  }
  let base = cwd;
  const stack = [];
  const cmds = commands(l.tokens);
  // A folder one command runs in (env -C, sudo -D): the shell's own folder comes back for the next command.
  let restore = null;
  for (let ci = 0; ci < cmds.length; ci++) {
    if (restore) {
      base = restore.base;
      restore = null;
    }
    const c = cmds[ci];
    if (c.open) {
      stack.push(base);
    }
    if (c.close) {
      if (stack.length) base = stack.pop();
      continue;
    }
    // Redirections: every write target.
    for (const rd of c.redirs) {
      if (/^(>|>>|>\||<>|&>|&>>|>&)$/.test(rd.v)) {
        if (rd.v === '>&' && rd.target && /^(\d+|-)$/.test(rd.target.text)) continue;
        const r = checkTarget(rd.target, st, base, 'redirect');
        if (r) return r;
      }
    }
    st.cmdN = (st.cmdN || 0) + 1;
    const u = unwrap(c.words);
    const ws = u.words;
    for (const a of u.assigns) {
      const r = assignHit(a, st, ws.length > 0) || gitEnvHit(a);
      if (r) return r;
    }
    if (u.unseen && (st.fragments || st.decoder)) return hit('env -S of a value the guard cannot see', '');
    if (u.chdir !== undefined) {
      restore = { base: base };
      const d = u.chdir;
      base = d.dyn || base === null ? (path.isAbsolute(expandHome(d.text)) && !d.dyn ? path.resolve(expandHome(d.text)) : null) : path.resolve(base, expandHome(d.text));
    }
    const heredoc = c.redirs.filter((rd) => rd.v === '<<' || rd.v === '<<-' || rd.v === '<<<');
    const stdinText = heredoc.map((rd) => (rd.v === '<<<' ? (rd.target ? rd.target.text : '') : rd.body || '')).join('\n');
    const stdinFile = c.redirs.find((rd) => rd.v === '<' && rd.target);
    if (!ws.length) continue;
    const head = ws[0];
    if (head.dyn) {
      if (st.fragments || st.decoder) return hit('a command the guard cannot see', shown(head));
      continue;
    }
    const name = path.basename(head.text);
    const args = ws.slice(1);
    if (GITC_SWAPPERS.has(name)) (st.swap || (st.swap = [])).push(st.cmdN);
    // for GIT_DIR in x y: the loop variable is set by the shell, then exported without a value (T-860 S2c).
    if ((name === 'for' || name === 'select') && args[0] && !args[0].dyn) {
      const r = gitEnvNameHit(args[0]);
      if (r) return r;
    }
    // set -a / set -o allexport: every variable set after it is exported, so a GIT_ one set by read or printf -v needs no export (T-860 S2c).
    if (name === 'set' && gitCRoots().active) {
      for (let i = 0; i < args.length && args[i].text !== '--'; i++) {
        const t = args[i].text;
        if (args[i].dyn || /^-[A-Za-z]*a/.test(t) || (/^-[A-Za-z]*o$/.test(t) && args[i + 1] && args[i + 1].text === 'allexport') || t === '-oallexport') return hit('set -a or set -o allexport in a lane workspace', '');
      }
    }
    // script -qc 'git ...' runs its command in a shell: read it like sh -c (a typescript file operand is only a file).
    if (name === 'script') {
      for (let i = 0; i < args.length; i++) {
        const t = args[i].text;
        const eq = /^--command=([\s\S]*)$/.exec(t);
        let code = null;
        if (eq) code = Object.assign({}, args[i], { text: eq[1] });
        else if (!args[i].dyn && /^-[A-Za-z]*c$/.test(t)) code = args[i + 1];
        else if (!args[i].dyn && /^-[A-Za-z]*c.+/.test(t) && !t.startsWith('--')) code = Object.assign({}, args[i], { text: t.replace(/^-[A-Za-z]*?c/, '') });
        if (!code) continue;
        const text = codeOf(code, base);
        if (text === null) return hit('script -c of code the guard cannot see', '');
        if (code.dyn && (st.fragments || st.decoder)) return hit('script -c with a value the guard cannot see', shown(code));
        const r = analyze(text, st, base, depth + 1);
        if (r) return r;
        break;
      }
      // No continue: script FILE writes its typescript there, so the generic check below still reads the operands for a rule file.
    }
    // A for list is read; what the loop does with it is checked in its own commands (a write to $f is a variable).
    if (name === 'for' || name === 'select' || name === 'case' || name === 'esac' || name === 'function') continue;
    // export LESSOPEN='|rm %s': a variable that runs code, set for the commands after it.
    if (name === 'export' || name === 'declare' || name === 'typeset' || name === 'local' || name === 'readonly') {
      for (const a of args) {
        const r = assignHit(a, st, false) || gitEnvHit(a) || gitEnvNameHit(a);
        if (r) return r;
      }
      if (gitCRoots().active) {
        // declare -n ref=GIT_DIR (a nameref): what the name points to is not on the line, so every nameref is refused (T-860 S2c).
        if (name !== 'export' && args.some((a) => !a.dyn && /^-[A-Za-z]*n/.test(a.text))) return hit('a nameref (declare -n) in a lane workspace', '');
        // export "$x"=v, export "$x", declare -x "$x": a name the guard cannot read could be GIT_DIR.
        const exports = name === 'export' || (name !== 'local' && name !== 'readonly' && args.some((a) => !a.dyn && /^-[A-Za-z]*x/.test(a.text)));
        if (exports && args.some((a) => a.dyn && a.text.slice(0, a.text.indexOf('=') < 0 ? undefined : a.text.indexOf('=')).includes('\u0000'))) return hit('export of a variable name the guard cannot see, in a lane workspace', '');
      }
    }
    // read GIT_DIR <<<x, printf -v GIT_DIR x: a refused GIT_ name filled from input, to be exported without a value.
    if (name === 'read' || name === 'mapfile' || name === 'readarray') {
      for (const a of args) {
        const r = gitEnvNameHit(a);
        if (r) return r;
      }
    }
    if (name === 'printf') {
      for (let i = 0; i < args.length; i++) {
        const m = /^-v(.*)$/.exec(args[i].text);
        const target = m ? (m[1] ? { text: m[1], dyn: args[i].dyn } : args[i + 1]) : null;
        const r = target ? gitEnvNameHit(target) : null;
        if (r) return r;
      }
    }
    // alias git='git -C ...' changes what a later plain git does; the lane allow rules match the text of that later command.
    if (name === 'alias' && gitCRoots().active) return hit('alias in a lane workspace', '');

    if (name === 'cd' || name === 'pushd') {
      const a = nonOptions(args)[0];
      if (!a) base = HOME;
      else if (a.dyn || a.glob || a.text === '-') base = null;
      else base = base === null ? (path.isAbsolute(expandHome(a.text)) ? path.resolve(expandHome(a.text)) : null) : path.resolve(base, expandHome(a.text));
      if (base !== null) {
        const real = realish(base);
        if (isClaudeDir(real)) base = real;
      }
      continue;
    }
    if (name === 'popd') {
      base = null;
      continue;
    }
    if (name === 'shopt' || name === 'setopt') continue;

    if (u.xargs) {
      if (WRITE_ALL.has(name) || COPIERS.has(name) || SHELLS.has(name) || INTERPRETERS.test(name) || name === 'sed' || name === 'git' || name === 'dd' || name === 'patch') {
        const listing = /\bfind\b|\bfd\b|\bls\b[^|;&]*\s-[A-Za-z]*[aA]|git\s+ls-files|\bgrep\b[^|;&]*\s-[A-Za-z]*l|\brg\b[^|;&]*(--files|-l)/.test(command);
        if (st.fragments || listing) return hit('xargs ' + name + ' on names from a pipe', shown(args[0]) || name);
      }
    }

    if (SHELLS.has(name) || (name === 'busybox' && args[0] && SHELLS.has(args[0].text))) {
      const sargs = name === 'busybox' ? args.slice(1) : args;
      const ci2 = sargs.findIndex((w) => !w.dyn && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text));
      if (ci2 >= 0) {
        const code = sargs[ci2 + 1];
        if (!code) continue;
        const text = codeOf(code, base);
        if (text === null) return hit(name + ' -c of code the guard cannot see', '');
        if (code.dyn && (st.fragments || st.decoder)) return hit(name + ' -c with a value the guard cannot see', shown(code));
        const r = analyze(text, st, base, depth + 1);
        if (r) return r;
        continue;
      }
      const script = nonOptions(sargs)[0];
      if (script && script.text !== '-' && !script.dyn) {
        if (scriptSuspicious(script.text, base)) return hit(name + ' running a script that writes a rule file', script.text);
        continue;
      }
      // The commands come from stdin.
      if (stdinText) {
        const r = analyze(stdinText, st, base, depth + 1);
        if (r) return r;
        continue;
      }
      if (stdinFile) {
        if (scriptSuspicious(stdinFile.target.text, base)) return hit(name + ' reading a script that writes a rule file', stdinFile.target.text);
        continue;
      }
      if (c.piped && (st.fragments || st.decoder)) return hit(name + ' reading commands from a pipe', name);
      continue;
    }

    if (name === 'eval' || name === 'source' || name === '.') {
      if (name === 'eval') {
        const parts = args.map((w) => codeOf(w, base));
        if (parts.some((p) => p === null)) return hit('eval of code the guard cannot see', '');
        if (args.some((w) => w.dyn) && (st.fragments || st.decoder)) return hit('eval of a value the guard cannot see', name);
        const r = analyze(parts.join(' '), st, base, depth + 1);
        if (r) return r;
        continue;
      }
      const f = args[0];
      if (!f) continue;
      if (f.dyn) {
        // source <(...) and source "$(...)": code the guard cannot see.
        if (f.subst || st.fragments || st.decoder) return hit(name + ' of a value the guard cannot see', shown(f));
        continue;
      }
      if (scriptSuspicious(f.text, base)) return hit(name + ' of a script that writes a rule file', f.text);
      continue;
    }

    // A nested Claude Code given settings that turn hooks off (or settings the guard cannot read): refused.
    if (name === 'claude' || (/^(npx|bunx|pnpx|pnpm|yarn|npm|node|nodejs|deno|bun)$/.test(name) && ws.some((w) => /claude/i.test(w.text) && !w.text.startsWith('-')))) {
      const r = claudeSettings(ws, st, base);
      if (r) return r;
    }

    if (INTERPRETERS.test(name)) {
      const r = interpreter(name, args, st, base, command, stdinText, stdinFile, c.piped);
      if (r) return r;
      continue;
    }

    if (WRITE_ALL.has(name)) {
      for (const w of nonOptions(args)) {
        const r = checkTarget(w, st, base, name);
        if (r) return r;
      }
      continue;
    }
    if (COPIERS.has(name)) {
      const r = copier(name, ws, st, base);
      if (r) return r;
      continue;
    }
    if (name === 'dd') {
      for (const w of args)
        if (w.text.startsWith('of=')) {
          const r = checkTarget(Object.assign({}, w, { text: w.text.slice(3) }), st, base, 'dd');
          if (r) return r;
        }
      continue;
    }
    if (name === 'sed' || name === 'gsed') {
      const inPlace = args.some((w) => !w.dyn && (/^-[A-Za-z]*i/.test(w.text) || w.text.startsWith('--in-place')));
      if (inPlace) {
        for (const w of nonOptions(args)) {
          const r = checkTarget(w, st, base, 'sed -i');
          if (r) return r;
        }
      }
      const named = namesRule(args, st, base);
      if (named && args.some((w) => /(^|[;\s}])w\s|\/w\s|\bW\s/.test(w.text))) return hit('sed writing a file', named);
      // sed '1e rm .mcp.json' and s///e run a shell (review 2, item 4).
      if ((st.fragments || st.decoder) && sedRunsShell(args, base)) return hit('sed running a shell in a command that names a rule file', '');
      continue;
    }
    if (name === 'curl' || name === 'wget') {
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text;
        const takesOut = name === 'curl' ? /^(-[A-Za-z]*o|--output)$/.test(t) : /^(-O|--output-document)$/.test(t);
        if (takesOut) {
          const r = checkTarget(args[k + 1], st, base, name);
          if (r) return r;
        }
        if (name === 'wget' && t.startsWith('--output-document=')) {
          const r = checkTarget(Object.assign({}, args[k], { text: t.slice(18) }), st, base, name);
          if (r) return r;
        }
      }
      const remoteName = name === 'wget' ? !args.some((w) => /^(-O|--output-document)/.test(w.text)) : args.some((w) => /^(-[A-Za-z]*O|--remote-name(-all)?)$/.test(w.text));
      if (remoteName)
        for (const w of args)
          if (/^[a-z]+:\/\//i.test(w.text)) {
            const b = path.basename(w.text.split(/[?#]/)[0]);
            const r = checkTarget({ t: 'w', text: b, dyn: w.dyn, glob: false }, st, base, name);
            if (r) return r;
          }
      continue;
    }
    if (name === 'tar' || name === 'unzip' || name === 'bsdtar' || name === 'cpio' || name === '7z' || name === '7za') {
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text;
        if (t === '-C' || t === '--directory' || t === '-d') {
          const r = checkTarget(args[k + 1], st, base, name);
          if (r) return r;
        }
        if (t.startsWith('--directory=')) {
          const r = checkTarget(Object.assign({}, args[k], { text: t.slice(12) }), st, base, name);
          if (r) return r;
        }
      }
      const named = namesRule(args, st, base);
      if (named) return hit(name + ' naming a rule file', named);
      continue;
    }
    if (name === 'patch') {
      const pos = nonOptions(args);
      if (pos[0]) {
        const r = checkTarget(pos[0], st, base, 'patch');
        if (r) return r;
      }
      const fileOpt = args.findIndex((w) => w.text === '-i' || w.text === '--input');
      const patchFile = fileOpt >= 0 ? args[fileOpt + 1] : pos[1] || (stdinFile && stdinFile.target);
      const text = patchFile && !patchFile.dyn ? readSmall(patchFile.text, base) : stdinText;
      const named = text ? patchNamesRule(text, base) : null;
      if (named) return hit('patch touching a rule file', named);
      if (!text && c.piped && st.fragments) return hit('patch from a pipe', 'patch');
      continue;
    }
    if (name === 'git') {
      // env -C DIR git ..., sudo -D DIR git ...: the folder is read like a git -C folder.
      if (u.chdir !== undefined && gitCRoots().active) {
        (st.gitC || (st.gitC = [])).push(st.cmdN);
        const step = gitCStep(u.chdir, restore ? restore.base : base);
        if (step.hit) return step.hit;
      }
      const r = git(args, st, base, stdinText, stdinFile, c.piped);
      if (r) return r;
      continue;
    }
    if (name === 'find' || name === 'fd' || name === 'fdfind') {
      const acts = args.filter((w) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$|^(-x|--exec|-X|--exec-batch)$/.test(w.text));
      if (!acts.length) continue;
      const execAt = args.findIndex((w) => /^-(exec|execdir|ok|okdir)$|^(-x|--exec|-X|--exec-batch)$/.test(w.text));
      // find ... -exec git ... {} ;: the words after -exec are a git command of their own (a lane workspace reads its -C and options).
      if (execAt >= 0 && args[execAt + 1] && nameOf(args[execAt + 1]) === 'git' && gitCRoots().active) {
        const inner = [];
        for (let j = execAt + 2; j < args.length && args[j].text !== ';' && args[j].text !== '+'; j++) inner.push(args[j]);
        const r = git(inner, st, null, '', null, false);
        if (r) return r;
      }
      let writes = acts.some((w) => w.text !== '-exec' && w.text !== '-execdir' && w.text !== '-ok' && w.text !== '-okdir' && !/^(-x|--exec|-X|--exec-batch)$/.test(w.text));
      if (execAt >= 0 && args[execAt + 1]) {
        const cmd = path.basename(args[execAt + 1].text);
        if (WRITE_ALL.has(cmd) || COPIERS.has(cmd) || SHELLS.has(cmd) || INTERPRETERS.test(cmd) || cmd === 'sed' || cmd === 'dd' || cmd === 'git' || cmd === 'perl') writes = true;
      }
      if (!writes) continue;
      if (st.fragments) return hit(name + ' writing what it finds', namesRule(args, st, base) || name);
      // Its name tests are patterns, quoted or not, and they match names starting with a dot.
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text;
        if (/^-(i?regex)$/.test(t)) return hit(name + ' writing what a regex finds', (args[k + 1] && args[k + 1].text) || t);
        if (/^-(i?name|i?path|i?wholename)$/.test(t) && args[k + 1] && couldMatch(args[k + 1].dyn ? '\u0000' : args[k + 1].text, null, true))
          return hit(name + ' writing what it finds', args[k + 1].text);
      }
      for (const w of args) {
        if (w.dyn) continue;
        if (w.glob && couldMatch(w.text, null, true)) return hit(name + ' writing what it finds', w.text);
        const r = base === null ? null : ruleTarget(w.text, base, true);
        if (r) return hit(name + ' writing what it finds', r);
      }
      continue;
    }
    // Readers with a write form: uniq IN OUT, tree -o FILE, yq -i.
    if (name === 'uniq' || name === 'tree' || name === 'yq') {
      const r = readerWrite(name, args, st, base);
      if (r) return r;
      continue;
    }
    // A reader with an option that runs a program or writes (rg --pre, less +!cmd, --pager): review 2, item 5.
    if (READERS.has(name)) {
      const r = readerExec(name, args, st, base);
      if (r) return r;
    }
    // Anything else that names a rule file and is not a known reader: refused (prettier --write, npx, an editor, ...).
    if (!READERS.has(name)) {
      const named = namesRule(args, st, base);
      if (named) return hit(name + ' naming a rule file', named);
      if (head.text.includes('/') && scriptSuspicious(head.text, base)) return hit('a script that writes a rule file', head.text);
    }
  }
  return null;
}

/** The write target of a reader that can write: uniq's second operand, tree's -o, every operand of yq -i. */
function readerWrite(name, args, st, base) {
  const pos = [];
  const outs = [];
  let inPlace = false;
  let dashdash = false;
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    const t = w.text;
    if (dashdash || w.dyn || !t.startsWith('-') || t === '-') {
      pos.push(w);
      continue;
    }
    if (t === '--') {
      dashdash = true;
      continue;
    }
    if (name === 'uniq' && /^-[fsw]$/.test(t)) k++;
    if (name === 'tree') {
      if (t === '-o') outs.push(args[++k]);
      else if (/^-o./.test(t)) outs.push(Object.assign({}, w, { text: t.slice(2) }));
      else if (/^-[LPIH]$|^--(filelimit|timefmt|charset)$/.test(t)) k++;
    }
    if (name === 'yq') {
      if (t === '--inplace' || /^--inplace=/.test(t) || /^-[A-Za-z]*i[A-Za-z]*$/.test(t)) inPlace = true;
      else if (/^-[A-Za-z]*[oIp]$|^--(output-format|input-format|indent|expression|from-file|front-matter)$/.test(t)) k++;
    }
  }
  if (name === 'uniq' && pos[1]) outs.push(pos[1]);
  if (name === 'yq' && inPlace) for (const w of pos) outs.push(w);
  for (const w of outs) {
    const r = checkTarget(w, st, base, name === 'yq' ? 'yq -i' : name === 'tree' ? 'tree -o' : 'uniq to a file');
    if (r) return r;
  }
  return null;
}

// Settings text that switches hooks off or replaces them.
const HOOKS_OFF = /disableAllHooks|allowManagedHooksOnly|["']?hooks["']?\s*:/;

/** claude --settings <json|file>: refused when the settings turn hooks off or replace them, or cannot be read. */
function claudeSettings(ws, st, base) {
  for (let k = 0; k < ws.length; k++) {
    const t = ws[k].text;
    let v = null;
    if (t === '--settings') v = ws[k + 1] || { text: '', dyn: true };
    else if (t.startsWith('--settings=')) v = Object.assign({}, ws[k], { text: t.slice(11) });
    if (!v) continue;
    if (v.dyn) return hit('claude --settings the guard cannot see', '');
    const s = v.text.trim();
    let text = s;
    if (!s.startsWith('{')) {
      if (base === null && !path.isAbsolute(expandHome(s))) return hit('claude --settings the guard cannot read', '');
      try {
        const abs = path.resolve(base || '/', expandHome(s));
        const fst = fs.statSync(abs);
        if (!fst.isFile() || fst.size > 1048576) return hit('claude --settings the guard cannot read', '');
        text = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        return hit('claude --settings the guard cannot read', '');
      }
    }
    if (hooksOff(text)) return hit('claude --settings that change hooks', '');
  }
  // claude config set, claude mcp add, claude plugin install: Claude Code writes its own rule files for them.
  const prog = ws.findIndex((w) => !w.text.startsWith('-') && /claude/i.test(w.text));
  const ci = ws.findIndex((w, j) => j > prog && !w.dyn && /^(config|mcp|plugin|plugins)$/.test(w.text));
  if (prog >= 0 && ci >= 0) {
    const verb = ws.slice(ci + 1).find((w) => !w.text.startsWith('-'));
    if (verb && (verb.dyn || !/^(get|list|ls|show|serve|help|validate)$/.test(verb.text))) return hit('claude ' + ws[ci].text + ' writing its settings', '');
  }
  return null;
}

/**
 * Settings that switch hooks off or set hooks (review 2, item 6): the keys of the parsed JSON, so an escape
 * ("disableAllHooks") does not hide one. Text that is not JSON is refused: the guard cannot read it.
 */
function hooksOff(text) {
  if (HOOKS_OFF.test(text)) return true;
  let o;
  try {
    o = JSON.parse(text);
  } catch (e) {
    return true;
  }
  const walk = (v, d) => {
    if (d > 20 || !v || typeof v !== 'object') return false;
    for (const k of Object.keys(v)) {
      if (/^(disableAllHooks|allowManagedHooksOnly|hooks)$/i.test(k)) return true;
      if (walk(v[k], d + 1)) return true;
    }
    return false;
  };
  return walk(o, 0);
}

/**
 * The code a word carries, for sh -c, eval and inline interpreter code (item 6 of the T-404 review): its text, or the
 * file a lone $(cat FILE) or $(< FILE) reads; null when the guard cannot know it (any other command substitution, or a
 * word made only of variables).
 */
function codeOf(w, base) {
  if (!w) return '';
  if (w.subst && w.subst.length) {
    if (w.text !== '\u0000' || w.subst.length !== 1) return null;
    const m = /^\s*(?:cat\s+(?:--\s+)?|<\s*)([^\s|;&<>$\x60'"*?\[{(]+)\s*$/.exec(w.subst[0]);
    if (!m || base === null) return null;
    try {
      const abs = path.resolve(base, expandHome(m[1]));
      const s = fs.statSync(abs);
      if (!s.isFile() || s.size > 1048576) return null;
      return fs.readFileSync(abs, 'utf8');
    } catch (e) {
      return null;
    }
  }
  if (w.dyn && !w.text.replace(/\u0000/g, '').trim()) return null;
  return w.text.replace(/\u0000/g, '$X');
}

function readSmall(file, base) {
  try {
    const abs = path.resolve(base || process.cwd(), expandHome(file));
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 4194304) return '';
    return fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return '';
  }
}

/** A git config setting (key=value): refused when it names a rule file, or runs something while the command shows one. */
function gitConfigHit(kv, unseen, st) {
  if (MENTION.test(kv)) return hit('git config naming a rule file', '');
  if (!unseen && GIT_SAFE_CONFIG.test(kv)) return null;
  if (st.fragments || st.decoder) return hit('git config that could run a command, in a command that names a rule file', '');
  return null;
}

/* ---------- git -C (T-860) ---------- */

// The lane allow rules say git -C /home/node/work/agentic-worktrees/* ..., and the shell builds a ".." from forms with no two dots
// in a row (.''. , .\. , .'.'), so a text rule cannot hold the path. The guard reads the path the way the shell does (the lexer
// above removes quotes and backslashes), takes its real path and allows it only below a lane root. Roots: the lane folder, and
// the lines of a root-owned file (CLAUDEPILOT_GUARD_GITC_ROOTS_FILE, for a test; else /etc/claudepilot/git-c-roots).
const GITC_DEFAULT_ROOT = '/home/node/work/agentic-worktrees';
const GITC_ROOTS_FILE = process.env.CLAUDEPILOT_GUARD_GITC_ROOTS_FILE || '/etc/claudepilot/git-c-roots';

function gitCRoots() {
  const extra = [];
  try {
    for (const line of fs.readFileSync(GITC_ROOTS_FILE, 'utf8').split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && path.isAbsolute(t)) extra.push(path.resolve(t));
    }
  } catch (e) {
    // no file: only the default root
  }
  return { extra: extra, active: extra.length > 0 || isDir(GITC_DEFAULT_ROOT) };
}

/**
 * A GIT_* variable that moves a folder, adds config or runs a program (GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_CONFIG_COUNT,
 * GIT_EXEC_PATH, GIT_SSH_COMMAND, ...), set for a command, exported or declared: refused in a lane workspace, where the lane allow
 * rules match the text of the command and not its environment. Author and committer names, tracing and the prompt switch are not refused.
 */
function gitEnvHit(w) {
  const m = ASSIGN.exec(w.text);
  if (!m || !/^GIT_/.test(m[1])) return null;
  // GIT_TRACE and GIT_TRACE2* append to the file they name: only a switch (0, 1, true, false) or a descriptor number is allowed.
  if (/^GIT_TRACE/.test(m[1])) {
    const value = w.text.slice(m[0].length);
    return gitCRoots().active && (w.dyn || !/^(\d{1,3}|true|false)$/i.test(value)) ? hit('GIT_TRACE with a file, in a lane workspace', '') : null;
  }
  if (!EXEC_ENV.test(m[1])) return null;
  return gitCRoots().active ? hit('a GIT_ variable that moves a folder or runs a program, in a lane workspace', '') : null;
}

/** export GIT_DIR (no value) after read GIT_DIR or printf -v GIT_DIR: the name alone, or read or printf -v into it, in a lane workspace. */
function gitEnvNameHit(w) {
  const m = /^(GIT_[A-Za-z0-9_]*)$/.exec(w.text);
  if (!m || w.dyn || !(EXEC_ENV.test(m[1]) || /^GIT_TRACE/.test(m[1]))) return null;
  return gitCRoots().active ? hit('a GIT_ variable that moves a folder or runs a program, in a lane workspace', '') : null;
}

/** The folder a git -C path word names: { hit } when it is refused, else { base } (its real path), or { base: next } when the guard is off here. */
function gitCStep(d, b) {
  const roots = gitCRoots();
  // Not a lane workspace (no lane folder, no configured root): there is no lane allow rule to guard, and the folder is tracked as before.
  if (!roots.active) return { base: !d || d.dyn ? null : b === null ? null : path.resolve(b, expandHome(d.text)) };
  if (!d) return { hit: hit('git -C without a folder', '') };
  if (d.dyn) return { hit: hit('git -C of a value the guard cannot see (a variable or a command substitution)', '') };
  if (d.glob) return { hit: hit('git -C of a pattern', '') };
  const t = expandHome(d.text);
  if (!t || /[\u0000-\u001f$]/.test(t)) return { hit: hit('git -C of a path the guard cannot read', '') };
  if (b === null && !path.isAbsolute(t)) return { hit: hit('git -C of a folder relative to a folder the guard does not know', '') };
  let real;
  try {
    real = fs.realpathSync(path.resolve(b === null ? '/' : b, t));
  } catch (e) {
    return { hit: hit('git -C of a folder that does not exist', '') };
  }
  const under = [GITC_DEFAULT_ROOT].concat(roots.extra).some((r) => {
    const rr = realish(r);
    return real.startsWith(rr === '/' ? rr : rr + '/');
  });
  if (!under) return { hit: hit('git -C outside the lane worktrees', '') };
  return { base: real };
}

// Options git takes before the subcommand that move nothing: the only ones a lane workspace may use there (S2). Every other one is
// refused: -c and --config-env set config (core.worktree, core.hooksPath, alias.x=!cmd), --exec-path runs a program from a folder,
// --namespace and --bare change where refs go, and a glued -Cpath or an option a later git adds fails closed.
const GITC_GLOBAL_OK = /^(--no-pager|-P|--paginate|-p|--no-optional-locks|--no-lazy-fetch|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-advice|--no-replace-objects|--version)$/;
// Config keys that move the work tree or run a program, refused for git config in a lane workspace.
const GITC_CONFIG_KEYS = /^(core\.(worktree|bare|hookspath|fsmonitor|sshcommand|gitproxy|askpass|editor|pager)|alias\.|include\.|includeif\.|credential\.|filter\.|diff\.[^=]*\.(command|textconv)|sequence\.editor|gpg\.[a-z.]*program)/i;
// Config keys that decide where a push goes (T-974 FIX), refused when set in a lane workspace. A remote's name may hold dots.
const GITC_PUSH_KEYS = /^(remote\..*\.(push|url|pushurl)|push\.|url\..*\.(push)?insteadof|branch\..*\.pushremote)/i;
// Programs that change links, folders or files in the same command line as a git -C (the path is read before they run).
const GITC_SWAPPERS = new Set(['ln', 'mv', 'cp', 'rm', 'rmdir', 'mkdir', 'tar', 'unzip', 'install', 'rsync', 'bsdtar', 'cpio', '7z', '7za', 'unlink', 'truncate', 'mkfifo']);

/* ---------- git by subcommand and flags (T-974) ---------- */

// The lane allow rules are text (git -C <lane>/* commit*), and a text deny cannot tell a SUBCOMMAND from words in a -m value (a message
// that says "restore" or "clean" was refused). So after the options before the subcommand, a git -C line is read as an argv: the
// subcommand, its flags and its words, with the values of -m, -F and --message left out, and refused by subcommand and flags.
const GIT_PROTECTED = ['stg', 'main', 'uat'];
// Subcommands read by the policy; for every other one the earlier rules (rule files named, paths) are all that apply.
const GIT_POLICED = new Set(['reset', 'clean', 'restore', 'checkout', 'switch', 'rebase', 'branch', 'push', 'commit', 'worktree', 'fetch', 'ls-remote', 'clone', 'pull', 'remote']);
// git remote subcommands that change where a fetch or push goes (the same effect as the remote.*.url keys): refused. -v, show and get-url read.
const GIT_REMOTE_WRITES = new Set(['add', 'set-url', 'rename', 'remove', 'rm', 'set-branches', 'set-head']);
// Where a pattern or a variable could hide a protected branch or a flag.
const GIT_NO_GLOB = new Set(['reset', 'restore', 'checkout', 'switch', 'branch', 'push', 'worktree']);
// Short flags that take a value (the rest of the cluster, else the next word) for the subcommands that carry a message.
const GIT_VALUE_LETTERS = { commit: 'mFCct', tag: 'mFu', merge: 'mF', stash: 'm', notes: 'mF' };
// Short flags whose value can only be glued on (commit -uno is -u no, not -n -o).
const GIT_GLUED_LETTERS = { commit: 'uS' };
const GIT_MESSAGE_SUBS = new Set(['commit', 'tag', 'merge', 'stash', 'notes']);

/** Whether a long option is spelled in full or as an unambiguous start of it (git accepts --no-ver for --no-verify). */
function gitLong(text, full, min) {
  const eq = text.indexOf('=');
  const name = eq < 0 ? text : text.slice(0, eq);
  return name.length >= min && full.startsWith(name);
}

/** A branch name as git reads it: refs/heads/x, heads/x and x are one branch; a leading + is a forced refspec. */
function gitProtected(text) {
  const t = text.replace(/^\+/, '').replace(/^(refs\/)?heads\//, '');
  return GIT_PROTECTED.includes(t);
}

/** The words of a git line without the values of -m, -F and --message; short flag clusters split into one flag each. */
function gitArgv(sub, rest) {
  const letters = GIT_VALUE_LETTERS[sub] || '';
  const glued = GIT_GLUED_LETTERS[sub] || '';
  const out = [];
  let paths = false;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    const t = w.text;
    if (paths) {
      out.push(w);
      continue;
    }
    if (t === '--') {
      paths = true;
      out.push(w);
      continue;
    }
    if (t.startsWith('--')) {
      if (GIT_MESSAGE_SUBS.has(sub) && (gitLong(t, '--message', 4) || gitLong(t, '--file', 4))) {
        if (t.indexOf('=') < 0) i++;
        continue;
      }
      out.push(w);
      continue;
    }
    if (t.length > 1 && t[0] === '-') {
      for (let j = 1; j < t.length; j++) {
        const ch = t[j];
        if (letters.includes(ch)) {
          if (j === t.length - 1) i++;
          break;
        }
        if (glued.includes(ch)) break;
        out.push(Object.assign({}, w, { text: '-' + ch }));
      }
      continue;
    }
    out.push(w);
  }
  return out;
}

/** The refusal of a git subcommand or flag in a git -C line of a lane workspace (T-974), or null. */
function gitPolicy(sub, rest) {
  if (!GIT_POLICED.has(sub)) return null;
  const argv = gitArgv(sub, rest);
  const no = (what) => hit('git ' + sub + ' ' + what + ' (a lane workspace)', '');
  // Fail closed: a value the guard cannot see could be a flag or a protected branch.
  for (const w of argv) {
    if (w.dyn) return no('with a value the guard cannot see (a variable or a command substitution)');
    if (w.glob && GIT_NO_GLOB.has(sub)) return no('with a pattern');
  }
  const dd = argv.findIndex((w) => w.text === '--');
  const before = dd < 0 ? argv : argv.slice(0, dd);
  const flags = before.filter((w) => w.text.startsWith('-')).map((w) => w.text);
  const pos = before.filter((w) => !w.text.startsWith('-')).map((w) => w.text);
  const has = (...names) => flags.some((f) => names.includes(f));
  const long = (full, min) => flags.some((f) => gitLong(f, full, min));
  // A program git runs from an option: fetch, pull, ls-remote, push and clone take one.
  if (long('--upload-pack', 5) || long('--receive-pack', 5) || long('--exec', 5)) return no('with --upload-pack, --receive-pack or --exec');
  if (sub === 'reset') return long('--hard', 4) ? no('--hard') : null;
  if (sub === 'clean') return no('(it deletes untracked files)');
  if (sub === 'restore') return has('--staged', '-S') && !has('--worktree', '-W') ? null : no('of the work tree');
  if (sub === 'rebase') return no('(it rewrites history)');
  if (sub === 'checkout' || sub === 'switch') {
    if (pos.some(gitProtected)) return no('of a protected branch (stg, main, uat)');
    if (has('-f', '--force') || long('--force', 4) || long('--discard-changes', 4)) return no('--force (it discards changes)');
    if (sub === 'checkout') {
      if (dd >= 0) return no('of paths (it restores the work tree)');
      if (pos.some((p) => p === '.' || p === ':/')) return no('of the whole work tree');
      const creates = has('-b', '-B', '--orphan') || long('--orphan', 4);
      if (!creates && pos.length >= 2) return no('of paths from a commit (it restores the work tree)');
    }
    return null;
  }
  if (sub === 'branch') {
    if (has('-D', '-d') || long('--delete', 4)) return no('--delete');
    if ((has('-f', '-m', '-M', '-c', '-C') || long('--force', 4) || long('--move', 4) || long('--copy', 4)) && pos.some(gitProtected)) return no('of a protected branch (stg, main, uat)');
    return null;
  }
  if (sub === 'push') {
    if (has('-f') || long('--force', 5) || long('--force-with-lease', 5) || long('--force-if-includes', 5)) return no('--force');
    if (has('-d') || long('--delete', 5) || long('--mirror', 5) || long('--prune', 5) || long('--all', 5) || long('--branches', 5)) return no('with --delete, --mirror, --prune or --all');
    for (const p of pos) {
      if (/[*?[]/.test(p)) return no('with a pattern');
      if (p.startsWith('+')) return no('of a forced refspec (+)');
      if (p.startsWith(':')) return no('of a deletion refspec (:branch)');
      const dst = p.slice(p.lastIndexOf(':') + 1);
      if (gitProtected(p) || gitProtected(dst)) return no('to a protected branch (stg, main, uat)');
    }
    return null;
  }
  if (sub === 'remote') return GIT_REMOTE_WRITES.has(pos[0]) ? no(pos[0] + ' (it changes where a push goes)') : null;
  if (sub === 'commit') return has('-n') || long('--no-verify', 6) ? no('--no-verify') : null;
  if (sub === 'worktree') return pos[0] === 'remove' ? no('remove') : null;
  if (sub === 'clone') return has('-u', '-c') || long('--config', 5) || long('--template', 5) ? no('with --config, --template or -u') : null;
  return null;
}

function git(args, st, base, stdinText, stdinFile, piped) {
  let k = 0;
  let b = base;
  const lane = gitCRoots().active;
  let viaC = false;
  const mark = (list) => (st[list] || (st[list] = [])).push(st.cmdN);
  for (; k < args.length; k++) {
    const t = args[k].text;
    if (lane) {
      // A lane workspace: the folders before the subcommand are -C, --git-dir and --work-tree (each read as the shell does and
      // kept below a lane root) and the options on the list above. The lane allow's * would let any of them through.
      if (t === '-C') {
        viaC = true;
        mark('gitC');
        const step = gitCStep(args[++k], b);
        if (step.hit) return step.hit;
        b = step.base;
        continue;
      }
      const dir = /^--(git-dir|work-tree)(?:=([\s\S]*))?$/.exec(t);
      if (dir && !args[k].glob) {
        viaC = true;
        mark('gitC');
        const v = dir[2] !== undefined ? Object.assign({}, args[k], { text: dir[2] }) : args[++k];
        // Git keeps the value as a string and applies every -C first, so a relative value is read against the folder after the
        // LAST -C, which the guard has not reached yet: refuse it (an absolute value is read as it is).
        if (v && !v.dyn && !path.isAbsolute(expandHome(v.text))) return hit('a relative --git-dir or --work-tree in a lane workspace (git reads it after the last -C)', '');
        const step = gitCStep(v, b);
        if (step.hit) return step.hit;
        continue;
      }
      if (GITC_GLOBAL_OK.test(t) && !args[k].dyn) continue;
      if (t.startsWith('-') || args[k].dyn || args[k].glob) return hit('a git option before the subcommand that a lane workspace does not allow (-c, --exec-path, --namespace, a glued -C, a variable)', '');
      break;
    }
    if (t === '-C') {
      const step = gitCStep(args[++k], b);
      if (step.hit) return step.hit;
      b = step.base;
      continue;
    }
    // git -c alias.x='!cmd' x, git -c core.pager='tee FILE' log (review 2, item 1): a config value that names a rule file,
    // or any key that is not known to run nothing while the command shows a piece of one.
    if (t === '-c' || /^--config-env(=|$)/.test(t)) {
      const v = t === '-c' || t === '--config-env' ? args[++k] : Object.assign({}, args[k], { text: t.slice(13) });
      if (!v) continue;
      const r = gitConfigHit(v.text, v.dyn || t !== '-c', st);
      if (r) return r;
      continue;
    }
    // Another work tree or git folder: paths are not where the command's folder says (git --work-tree=.claude checkout).
    if (t === '--git-dir' || t === '--work-tree') {
      k++;
      b = null;
      continue;
    }
    if (/^--(git-dir|work-tree)=/.test(t)) {
      b = null;
      continue;
    }
    if (t === '--namespace') {
      k++;
      continue;
    }
    if (t.startsWith('-')) continue;
    break;
  }
  const sub = args[k] ? args[k].text : '';
  const rest = args.slice(k + 1);
  if (lane && (sub === 'worktree' || sub === 'config')) mark('swap');
  // T-974: a git -C line (the form the lane allow matches by text) is refused by subcommand and flags.
  if (lane && viaC) {
    const pr = gitPolicy(sub, rest);
    if (pr) return pr;
  }
  // A lane workspace: git config of a key that moves the work tree or runs a program (core.worktree, core.hooksPath, alias.x, include.path).
  if (lane && sub === 'config') {
    const ops = nonOptions(rest);
    // Another file than the repository's own (--file, -f, --global, --system, --blob): a write or a read outside the lane.
    if (rest.some((w) => /^(--file|--global|--system|--blob|-f)/.test(w.text))) return hit('git config of another file than the repository’s own, in a lane workspace', '');
    if (ops.some((w) => GITC_CONFIG_KEYS.test(w.text)) || (ops.length >= 2 && ops[0].dyn)) return hit('git config of a key that moves the work tree or runs a program, in a lane workspace', '');
    // T-974 FIX: a key that redirects a push (remote.<n>.push, .url, .pushurl, push.*, url.<base>.insteadOf, branch.<n>.pushRemote) turns a later
    // plain git push into a push to a protected branch: refused when SET (a read, git config --get remote.origin.url, stays allowed).
    const setting = ops.length >= 2 || rest.some((w) => /^--(add|replace-all)$/.test(w.text));
    if (setting && ops.some((w) => GITC_PUSH_KEYS.test(w.text))) return hit('git config of a key that redirects a push (remote.*.push, remote.*.url, push.*, url.*.insteadOf, branch.*.pushRemote), in a lane workspace', '');
  }
  // git config alias.x '!rm .mcp.json' (then git x): a key that runs something, set while a rule file is named.
  if (sub === 'config') {
    const ops = nonOptions(rest);
    const setting = ops.length >= 2 || rest.some((w) => /^--(add|replace-all)$/.test(w.text));
    if (setting && ops[0] && !ops[0].dyn) {
      const r = gitConfigHit(ops[0].text + '=' + (ops[1] ? ops[1].text : ''), !!(ops[1] && ops[1].dyn), st);
      if (r) return r;
    } else if (setting && (st.fragments || st.decoder)) return hit('git config of a key the guard cannot see', '');
  }
  if (sub === 'apply' || sub === 'am') {
    const files = nonOptions(rest).filter((w) => !w.dyn && w.text !== '-');
    for (const f of files) {
      const named = patchNamesRule(readSmall(f.text, b), b);
      if (named) return hit('git ' + sub + ' touching a rule file', named);
    }
    if (!files.length) {
      const text = stdinText || (stdinFile ? readSmall(stdinFile.target.text, b) : '');
      const named = text ? patchNamesRule(text, b) : null;
      if (named) return hit('git ' + sub + ' touching a rule file', named);
      if (!text && piped && st.fragments) return hit('git ' + sub + ' from a pipe', 'git ' + sub);
    }
    const named = namesRule(rest, st, b);
    if (named) return hit('git ' + sub + ' naming a rule file', named);
    return null;
  }
  if (GIT_PATH_WRITES.has(sub)) {
    for (const w of rest) {
      if (w.text.startsWith('-')) {
        const eq = /^--(pathspec-from-file)=(.*)$/.exec(w.text);
        if (eq && st.fragments) return hit('git ' + sub + ' from a list of paths', eq[2]);
        continue;
      }
      if (MENTION.test(w.text)) return hit('git ' + sub, shown(w));
      const r = checkTarget(w, st, b, 'git ' + sub, { dotglob: true });
      if (r) return r;
    }
    // A source commit with a folder (or everything) brings that commit's rule files: git checkout <commit> -- <folder>,
    // git checkout <commit> <folder>, git restore --source <commit> <folder>.
    const dd = rest.findIndex((w) => w.text === '--');
    const before = nonOptions(dd >= 0 ? rest.slice(0, dd) : rest);
    let paths = [];
    if (sub === 'restore' && rest.some((w) => /^(-s|--source)(=|$)/.test(w.text))) paths = dd >= 0 ? rest.slice(dd + 1) : before.slice(rest.some((w) => w.text === '-s' || w.text === '--source') ? 1 : 0);
    else if (sub === 'checkout' && dd >= 0 && before.length > 0) paths = rest.slice(dd + 1);
    else if (sub === 'checkout' && dd < 0 && before.length > 1) paths = before.slice(1);
    if (b !== null) {
      for (const w of paths) {
        if (w.dyn) {
          if (st.fragments) return hit('git ' + sub + ' from another commit', shown(w));
          continue;
        }
        const t = w.text.replace(/^:\(top\)|^:\//, '');
        const abs = path.resolve(b, t || '.');
        if (t === '' || t === '.' || w.glob || (isDir(abs) && treeHasRule(abs))) return hit('git ' + sub + ' of a folder from another commit', abs);
      }
    }
    return null;
  }
  if (sub === 'diff' || sub === 'log' || sub === 'format-patch' || sub === 'show') {
    for (const w of rest) {
      const m = /^(--output|-o)=?(.*)$/.exec(w.text);
      if (m && m[2]) {
        const r = checkTarget(Object.assign({}, w, { text: m[2] }), st, b, 'git ' + sub + ' --output');
        if (r) return r;
      }
    }
    return null;
  }
  // Subcommands on the read list that write a file they are given: config --file, archive --output, bundle create.
  if (sub === 'config' || sub === 'archive') {
    const opt = sub === 'config' ? /^(--file|-f)$/ : /^(--output|-o)$/;
    const optEq = sub === 'config' ? /^(--file|-f)=(.+)$/ : /^(--output|-o)=?(.+)$/;
    for (let j = 0; j < rest.length; j++) {
      const t = rest[j].text;
      let target = null;
      if (opt.test(t)) target = rest[++j] || null;
      else if (!rest[j].dyn && optEq.test(t)) target = Object.assign({}, rest[j], { text: optEq.exec(t)[2] });
      if (!target) continue;
      const r = checkTarget(target, st, b, 'git ' + sub + ' to a file');
      if (r) return r;
    }
    return null;
  }
  if (sub === 'bundle') {
    const ops = nonOptions(rest);
    if (ops[0] && ops[0].text === 'create') {
      const r = checkTarget(ops[1], st, b, 'git bundle create');
      if (r) return r;
    }
    return null;
  }
  if (GIT_READS.has(sub) || sub === '') return null;
  // switch, merge, pull, rebase, cherry-pick, revert, read-tree, filter-branch, ... naming a rule file.
  const named = namesRule(rest, st, b);
  if (named) return hit('git ' + sub + ' naming a rule file', named);
  return null;
}

function interpreter(name, args, st, base, command, stdinText, stdinFile, piped) {
  const inlineFlags = /^(-e|--eval|-p|--print|-c|-E|-r|-x|--command|-Command|-[a-zA-Z]*e)$/;
  let code = null;
  let script = null;
  let fromStdin = false;
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    const t = w.text;
    if (t === '-') {
      fromStdin = true;
      break;
    }
    if (!w.dyn && inlineFlags.test(t) && !(name === 'claude')) {
      const text = codeOf(args[k + 1], base);
      if (text === null) return hit(name + ' code the guard cannot see', '');
      code = (code || '') + '\n' + text;
      k++;
      continue;
    }
    if (!w.dyn && t.startsWith('-')) {
      if (/^(-r|--require|--import|--loader|--experimental-loader|-m|-W|-X|--env-file|-I|-M|-f|--input-type|--conditions|-C)$/.test(t)) {
        if ((t === '-f' && /awk$/.test(name)) || (t === '-m' && /^python/.test(name))) {
          script = args[k + 1] || null;
          if (t === '-m') script = null;
        }
        k++;
      }
      continue;
    }
    if (/awk$/.test(name) && code === null && script === null) {
      code = t;
      continue;
    }
    if (script === null && code === null) script = w;
    break;
  }
  // The interpreter's own words naming a rule file (the checker itself as the script is a run of it, not a write).
  const own = args.filter((w) => !(script && w === script && CHECKER_BASE.test(path.basename(w.text))));
  const named = namesRule(own, st, base);
  if (named) return hit(name + ' with a rule file named', named);
  // A rule file named anywhere in the command (data on stdin, an argument further on): refused when unsure.
  const checker = script && !script.dyn && CHECKER_BASE.test(path.basename(script.text));
  if (checker ? MENTION.test(command.split(script.text).join(' ')) : st.mentions) return hit(name + ' in a command that names a rule file', name);
  if (code !== null) {
    if (MENTION.test(code)) return hit(name + ' with a rule file named', name);
    if (inlineSuspicious(code)) return hit(name + ' code that could write a rule file', name);
    return null;
  }
  if (script && !fromStdin) {
    if (script.dyn) return st.fragments ? hit(name + ' running a script the guard cannot see', shown(script)) : null;
    if (scriptSuspicious(script.text, base)) return hit(name + ' running a script that writes a rule file', script.text);
    return null;
  }
  if (name === 'claude') return null;
  // The program comes from stdin: a heredoc, a file, or a pipe.
  if (stdinText) {
    if (st.mentions || inlineSuspicious(stdinText)) return hit(name + ' reading code from stdin while a rule file is named', name);
    return null;
  }
  if (stdinFile && !stdinFile.target.dyn) {
    if (scriptSuspicious(stdinFile.target.text, base) || st.mentions) return hit(name + ' reading code from stdin while a rule file is named', stdinFile.target.text);
    return null;
  }
  if (piped || fromStdin) {
    if (st.mentions || inlineSuspicious(command) || st.decoder) return hit(name + ' reading code from stdin while a rule file is named', name);
  }
  return null;
}

/* ---------- tools ---------- */

const PATH_KEY = /path|file|dest|target|source|uri|dir|location|output|name|^(to|from|src|dst|into|old|new)$/i;
const READ_TOOL = /(^|_)(read|get|list|search|find|view|show|stat|info|query|describe|cat|head|tail|grep|glob|tree|fetch|download_to_memory|open_text)/i;
// A tool name with a write verb is a write, whatever read verb it also has (search_and_replace, get_or_create_file).
const WRITE_TOOL = /(^|_|-)(write|edit|create|update|upsert|delete|remove|rm|move|mv|rename|copy|cp|replace|patch|put|set|save|append|insert|upload|apply|modify|mkdir|touch|chmod|chown|truncate|overwrite|link|symlink|restore|checkout|reset|commit|exec|execute|run|install|import|extract|unzip|download)/i;

// A tool that runs a command (run_command, execute, shell): its command-like argument is checked like a Bash command.
const EXEC_TOOL = /(^|_|-)(exec|execute|run|shell|bash|sh|eval|spawn|command|terminal|script|process)(_|-|$)/i;
const COMMAND_KEY = /^(command|cmd|commands|script|shell|bash|code|command_?line|args|argv|input)$/i;

function stringsUnder(v, key, out, depth, every) {
  if (depth > 4 || out.length > 200) return;
  if (typeof v === 'string') {
    if (PATH_KEY.test(key) || (every && COMMAND_KEY.test(key))) out.push({ key: key, v: v });
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) stringsUnder(x, key, out, depth + 1, every);
    return;
  }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) stringsUnder(v[k], k, out, depth + 1, every);
}

function check(tool, ti, cwd) {
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    for (const key of ['file_path', 'notebook_path', 'path']) {
      const p = ti[key];
      if (typeof p !== 'string') continue;
      const r = ruleTarget(p, cwd, false);
      if (r) return hit(tool, r);
    }
    return null;
  }
  if (tool === 'Bash') {
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    if (!cmd) return null;
    if (cmd.length > 200000) return hit('a command too long to check', '');
    return analyzeBash(cmd, cwd);
  }
  if (tool.startsWith('mcp__')) {
    // camelCase names are split first: searchAndReplace is search_and_Replace (review 2, item 7).
    const action = tool
      .split('__')
      .slice(2)
      .join('__')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    if (READ_TOOL.test(action) && !WRITE_TOOL.test(action)) return null;
    const runs = EXEC_TOOL.test(action);
    const vals = [];
    stringsUnder(ti, '', vals, 0, runs);
    for (const { key, v } of vals) {
      if (runs && COMMAND_KEY.test(key)) {
        // A command run by a tool: refused when it names a rule file at all (its arguments may be split over keys),
        // else checked like Bash for the hidden forms.
        if (v.length > 200000) return hit(tool + ' with a command too long to check', '');
        if (MENTION.test(v)) return hit(tool + ' running a command that names a rule file', v);
        const r = analyzeBash(v, cwd);
        if (r) return hit(tool + ': ' + r.form, r.path);
        continue;
      }
      if (v.length > 4096) {
        if (runs) return hit(tool + ' with an argument too long to check', '');
        continue;
      }
      const r = (PATH_KEY.test(key) ? ruleTarget(v, cwd, true) : null) || (MENTION.test(v) ? v : null);
      if (r) return hit(tool, r);
    }
  }
  return null;
}

/* ---------- audit and verdict ---------- */

/** What the audit keeps of a refusal's path: the resolved rule file (or .claude folder), else a fixed label; never a command word. */
function auditPath(p) {
  const s = String(p || '').replace(/ \((through a link|a hard link|a \.claude folder)\)$/, '');
  if (!s) return '';
  if (s.length <= 300 && path.isAbsolute(s) && !/[\s\u0000-\u001f]/.test(s) && (ruleLabel(s) || isClaudeDir(s))) return s;
  return 'unresolved';
}

function audit(input, tool, form, p) {
  try {
    const dir = path.join(HOME, '.claudepilot', 'outbox');
    if (!fs.statSync(dir).isDirectory()) return;
    const file = path.join(dir, 'guard.jsonl');
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch (e) {
      size = 0;
    }
    if (size >= OUTBOX_CAP) return;
    const pick = (v, re, max) => (typeof v === 'string' && re.test(v) ? v.slice(0, max) : '');
    const line = JSON.stringify({
      id: Date.now() + '-' + process.pid + '-' + Math.floor(Math.random() * 1e9),
      t: new Date().toISOString(),
      type: 'refused',
      session: pick(input && input.session_id, /^[A-Za-z0-9-]{1,64}$/, 64),
      tool: pick(tool, /^[A-Za-z0-9_.-]{1,100}$/, 100),
      form: String(form || '').replace(/[^A-Za-z0-9 ._+\/:-]/g, '?').slice(0, 80),
      path: auditPath(p),
      agent: pick(input && input.agent_type, /^[A-Za-z0-9_:. -]{1,64}$/, 64),
      mode: pick(input && input.permission_mode, /^[A-Za-z]{1,32}$/, 32),
    });
    fs.appendFileSync(file, line + '\n', { mode: 384 });
  } catch (e) {
    // the audit is best effort; the refusal is not
  }
}

function refuse(input, tool, form, p) {
  audit(input, tool, form, p);
  process.stderr.write(MESSAGE + '. Refused: ' + form + (p ? ' (' + p + ')' : '') + '. Propose the change as text on a ticket; the coordinator lands it.\n');
  process.exit(2);
}

// The guard's own deadline, well inside the hook's 30 s timeout: a check still running then is refused by the guard
// itself, so a slow check never depends on how Claude Code treats a hook it had to kill. A test may only lower it.
const DEADLINE_MS = 20000;
function deadline() {
  const v = Number(process.env.CLAUDEPILOT_GUARD_DEADLINE_MS);
  return Number.isFinite(v) && v > 0 && v < DEADLINE_MS ? v : DEADLINE_MS;
}

function verdictOf(input) {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
  try {
    return check(tool, ti, cwd);
  } catch (e) {
    return hit('a command the guard could not check', '');
  }
}

function main() {
  let input = null;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (e) {
    return refuse(null, '', 'unreadable hook input', '');
  }
  if (!input || typeof input !== 'object') return refuse(null, '', 'unreadable hook input', '');
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  // The check runs in a worker; this thread stays free to keep the deadline. No answer, a crash or the deadline: refused.
  let done = false;
  const finish = (verdict) => {
    if (done) return;
    done = true;
    if (!verdict) process.exit(0);
    refuse(input, tool, verdict.form, verdict.path);
  };
  let worker;
  try {
    worker = new threads.Worker(__filename, { workerData: input, env: threads.SHARE_ENV });
  } catch (e) {
    return finish(verdictOf(input));
  }
  const timer = setTimeout(() => finish(hit('a check that took too long', '')), deadline());
  worker.on('message', (m) => {
    clearTimeout(timer);
    finish(m && typeof m === 'object' && m.verdict ? m.verdict : m && m.allow === true ? null : hit('a check that gave no answer', ''));
  });
  worker.on('error', () => finish(hit('a command the guard could not check', '')));
  worker.on('exit', () => finish(hit('a check that gave no answer', '')));
}

const threads = require('worker_threads');
if (threads.isMainThread) main();
else {
  const verdict = verdictOf(threads.workerData || {});
  threads.parentPort.postMessage(verdict ? { verdict: verdict } : { allow: true });
}
`;

/** The file the guard's `git -C` check reads for its lane roots (T-860, T-924). */
export const GITC_ROOTS_PATH = '/etc/claudepilot/git-c-roots';

/** The lane worktree roots of this workspace's tracks (T-924). Never a main checkout: the guard exists to keep lanes off those. */
export const GITC_ROOTS: readonly string[] = [
  '/home/node/work/agentic-worktrees',
  '/home/node/work/claudepilot.worktrees',
  '/home/node/work/tradingbot.worktrees',
  '/home/node/work/konfersi-universe.worktrees',
];

/** The file's content: one root a line. Throws for a root that is not absolute, has `..` or is not a worktrees folder. */
export function gitCRootsContent(roots: readonly string[]): string {
  for (const r of roots) {
    const ok =
      r.startsWith('/') &&
      !r.split('/').includes('..') &&
      !/[\s\u0000-\u001f]/.test(r) &&
      !r.endsWith('/') &&
      /(^|\/)(agentic-worktrees|[^/]+\.worktrees)$/.test(r);
    if (!ok)
      throw new Error(
        `git -C root "${r}" must be an absolute path without "..", ending in .worktrees or agentic-worktrees (never a main checkout)`,
      );
  }
  return `# claudepilot: lane roots for the git -C check of policy-rule-guard (T-860, T-924). Root-owned; written by the portal.\n${roots.join('\n')}\n`;
}

/** The guard's files: root-owned, outside every workspace folder (policy owner: `/etc/claudepilot/bin/policy-*` and the roots file). */
export const RULE_GUARD_FILES: DeliveredFile[] = [
  { path: RULE_GUARD_PATH, content: RULE_GUARD_WRAPPER, mode: 0o755, uid: ROOT, gid: ROOT },
  { path: `${RULE_GUARD_PATH}.cjs`, content: RULE_GUARD_SCRIPT, mode: 0o644, uid: ROOT, gid: ROOT },
  { path: GITC_ROOTS_PATH, content: gitCRootsContent(GITC_ROOTS), mode: 0o644, uid: ROOT, gid: ROOT },
];

/** The tools it runs on: the file tools, Bash, and every MCP tool (a path argument of one that writes). */
export const RULE_GUARD_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*';

/** The policy drop-in's `hooks`: `|| exit 2` makes a missing or failing guard refuse instead of letting the call through. */
export const RULE_GUARD_HOOKS = {
  PreToolUse: [{ matcher: RULE_GUARD_MATCHER, hooks: [{ type: 'command', command: `${RULE_GUARD_PATH} || exit 2`, timeout: 30 }] }],
};
