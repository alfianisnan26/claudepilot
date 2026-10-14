#!/usr/bin/env node
// T-306 step 2, item 2: a PreToolUse hook for Bash that rewrites ONLY an allowlist of read-only commands to their rtk form, and nothing else.
// NOT INSTALLED: delivery (item 4) needs the owner's approval; the proposed settings diff is in
// docs/dev-sessions/overhaul/evidence/rtk-subset-2026-10-14.md with the fidelity table and the deny-parity result.
//
// Input: the hook JSON on stdin ({ tool_name, tool_input: { command }, cwd }). Output: nothing (the command runs as typed), or
// { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...tool_input, command: "rtk <command>" } } }. It never sets a
// permission decision: the permission rules still judge the command. Any error, any doubt: no output (fail closed = no rewrite).
//
// Rules, in order (classify()):
//   1. rtk must be on PATH (else a rewrite would turn a working command into "command not found").
//   2. Shell syntax anywhere, even quoted, means untouched: ; & | ` $ ( ) < > \ { } # ! and line breaks. A compound command (&&, ;, |),
//      a subshell, a redirect or an expansion is NEVER rewritten, even when every part is on the allowlist: rewriting one part of a pipe
//      changes what the next part parses, and a shell parser in a hook is where a bypass hides. Untouched is always safe; it only costs bytes.
//   3. A command that matches ANY Bash deny rule is untouched. The rules are read at run time from the project's .claude/settings.json
//      (required: missing or broken = no rewrite at all), .claude/settings.local.json, ~/.claude/settings.json and
//      /etc/claude-code/managed-settings.json (each optional, broken = no rewrite at all). There is no mirrored copy.
//   4. The command must be on the allowlist (ALLOW below: classes that kept >= 95 percent fidelity in tools/qa/rtk-classes.sh AND got
//      smaller), with only the flags that were measured. Test runners, builds, typecheck, kubectl, cat/sed, git push and anything else: never.
//   5. The rewritten form ("rtk " + command) must not match a deny rule either (it would newly block a harmless command).
import { readFileSync, accessSync, constants } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const SHELL_SYNTAX = /[;&|`$()<>\\{}#!\n\r]/;

/** Claude Code's Bash rule semantics (as in tools/qa/rtk-deny-parity.mjs): "prefix:*" = the command is prefix or starts with "prefix ";
 *  a pattern with * elsewhere = a glob over the whole command; else exact. */
const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
export function matches(pattern, cmd) {
  if (pattern.endsWith(":*")) {
    const p = pattern.slice(0, -2);
    if (!p.includes("*")) return cmd === p || cmd.startsWith(p + " ");
    return new RegExp("^" + p.split("*").map(esc).join(".*") + "( .*)?$", "s").test(cmd);
  }
  if (pattern.includes("*")) return new RegExp("^" + pattern.split("*").map(esc).join(".*") + "$", "s").test(cmd);
  return cmd === pattern;
}
const denied = (deny, cmd) => { const v = [cmd, cmd.trim(), cmd.trim().replace(/\s+/g, " ")]; return deny.some((p) => v.some((c) => matches(p, c))); };

/** Words of a command with simple quotes ('…' and "…", no escapes: a backslash is shell syntax above). null when a quote is open. */
export function tokenize(cmd) {
  const out = [];
  let cur = "", q = null, quoted = false;
  for (const ch of cmd) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; quoted = true; continue; }
    if (/\s/.test(ch)) { if (cur || quoted) out.push(cur); cur = ""; quoted = false; continue; }
    cur += ch;
  }
  if (q) return null;
  if (cur || quoted) out.push(cur);
  return out;
}

const isFlag = (w) => w.startsWith("-");
/** Every word after the head is a measured flag or an operand (a path, a ref, a pattern) that is not a flag. */
const only = (words, ok) => words.every((w) => !isFlag(w) || w === "--" || ok(w));

/** The allowlist (T-306, evidence: docs/dev-sessions/overhaul/evidence/rtk-subset-2026-10-14.md): the classes that kept 100 percent of
 *  their facts AND got smaller, in the forms that got smaller. Kept but not here because rtk passes them through byte for byte (a rewrite
 *  would only add rtk's start-up): git status -s/-sb, git log --oneline/--stat, git diff --stat/--name-only/--name-status, grep -c/rg --count.
 *  Dropped on fidelity: ls (rtk shows 50 entries and hides the rest behind `rtk recall`, and drops node_modules), find (hides most paths),
 *  grep -n/rg -n (cuts long lines and leaves out matches). Not scored: tree (not installed), npm ls (rtk does not rewrite it). */
export const ALLOW = {
  "git-status": (w) => w[0] === "git" && w[1] === "status" && only(w.slice(2), () => false),
  "git-log": (w) => w[0] === "git" && w[1] === "log" && only(w.slice(2), (f) => /^-\d+$/.test(f) || /^--max-count=\d+$/.test(f)),
  "grep-list": (w) =>
    (w[0] === "grep" && only(w.slice(1), (f) => /^-[rRi]*l[rRi]*$/.test(f)) && w.slice(1).some((f) => /^-[rRi]*l/.test(f))) ||
    (w[0] === "rg" && only(w.slice(1), (f) => /^-i?li?$/.test(f) || f === "--files-with-matches") && w.slice(1).some((f) => /^-i?l/.test(f) || f === "--files-with-matches")),
};

/** The decision for one command. { action: "rewrite", class, command } or { action: "skip", reason }. */
export function classify(cmd, { deny, rtkOnPath, allow = ALLOW }) {
  if (typeof cmd !== "string" || !cmd.trim()) return { action: "skip", reason: "no command" };
  if (!rtkOnPath) return { action: "skip", reason: "rtk is not on PATH" };
  if (cmd.length > 2000) return { action: "skip", reason: "too long" };
  if (SHELL_SYNTAX.test(cmd)) return { action: "skip", reason: "shell syntax (compound, pipe, subshell, redirect, expansion): never rewritten" };
  if (!Array.isArray(deny)) return { action: "skip", reason: "no deny list" };
  if (denied(deny, cmd)) return { action: "skip", reason: "matches a deny rule" };
  const words = tokenize(cmd.trim());
  if (!words || !words.length) return { action: "skip", reason: "open quote" };
  if (words[0] === "rtk") return { action: "skip", reason: "already rtk" };
  const cls = Object.keys(allow).find((k) => allow[k](words));
  if (!cls) return { action: "skip", reason: "not on the allowlist" };
  const command = "rtk " + cmd.trim();
  if (denied(deny, command)) return { action: "skip", reason: "the rewritten form matches a deny rule" };
  return { action: "rewrite", class: cls, command };
}

/** The settings files whose Bash deny rules count, [path, required]. */
export function settingsFiles(projectDir, home = homedir()) {
  return [
    [join(projectDir, ".claude", "settings.json"), true],
    [join(projectDir, ".claude", "settings.local.json"), false],
    [join(home, ".claude", "settings.json"), false],
    ["/etc/claude-code/managed-settings.json", false],
  ];
}
/** The Bash deny patterns, read now. Throws when a required file is missing or any file is broken (the caller then rewrites nothing). */
export function loadDeny(files) {
  const out = [];
  for (const [path, required] of files) {
    let text;
    try { text = readFileSync(path, "utf8"); } catch (e) { if (required) throw new Error(`cannot read ${path}`); continue; }
    const deny = JSON.parse(text)?.permissions?.deny;
    if (deny === undefined) continue;
    if (!Array.isArray(deny)) throw new Error(`${path}: permissions.deny is not a list`);
    for (const r of deny) {
      if (typeof r !== "string") throw new Error(`${path}: a deny rule is not a string`);
      if (r === "Bash" || r === "Bash()" || r === "Bash(*)") { out.push("*"); continue; }
      const m = /^Bash\((.*)\)$/s.exec(r);
      if (m) out.push(m[1]);
    }
  }
  return out;
}
export function rtkOnPath(path = process.env.PATH ?? "") {
  for (const d of path.split(delimiter)) {
    if (!d) continue;
    try { accessSync(join(d, "rtk"), constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try {
    const j = JSON.parse(input);
    if (j?.tool_name !== "Bash" || typeof j?.tool_input?.command !== "string") return;
    const projectDir = process.env.CLAUDE_PROJECT_DIR || j.cwd || process.cwd();
    const r = classify(j.tool_input.command, { deny: loadDeny(settingsFiles(projectDir)), rtkOnPath: rtkOnPath() });
    if (process.env.RTK_HOOK_DEBUG === "1") process.stderr.write(JSON.stringify(r) + "\n");
    if (r.action !== "rewrite") return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...j.tool_input, command: r.command } } }) + "\n");
  } catch (e) {
    if (process.env.RTK_HOOK_DEBUG === "1") process.stderr.write(`rtk hook: no rewrite (${e instanceof Error ? e.message : String(e)})\n`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
