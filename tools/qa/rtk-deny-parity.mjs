#!/usr/bin/env node
// T-286 step 2 preparation: do the repo's deny rules (.claude/settings.json) still catch the command AFTER rtk rewrites it?
//   RTK_BIN=/path/to/rtk node tools/qa/rtk-deny-parity.mjs [settings.json] [--json]
// Runs NOTHING denied: it only calls `rtk rewrite "<command>"`, which prints the rewrite and executes nothing, in an empty folder with an
// empty HOME (so rtk's own reading of deny rules does not hide a bypass), and matches the rewritten text against the pattern in JS.
// Pattern semantics (Claude Code): Bash(prefix:*) = the command is prefix or starts with "prefix "; Bash(a * b) = glob, whole command; else exact.
// Verdicts per Bash deny rule: UNCHANGED (no rewrite: still denied), STILL_MATCHES (rewritten, still matches), BYPASSED (rewritten and no longer
// matches), and, as a second line, whether rtk itself (running in the repo with the rules visible) refuses with exit 2.
//
// T-306 (step 2, item 2): the same question against the subset hook instead of rtk's blanket rewrite:
//   node tools/qa/rtk-deny-parity.mjs [settings.json] --hook tools/rtk/hook.mjs [--json]
// Each sample is fed to the hook as PreToolUse JSON on stdin (CLAUDE_PROJECT_DIR = the folder that holds .claude/settings.json, an empty
// HOME, a stand-in `rtk` on PATH so the hook believes rtk is there: the hook only checks that). Besides one sample per rule it tries, for a
// rule with a wildcard, the sample with each allowlisted command put in front of it where that still matches the rule (e.g.
// `ls -la /proc/x/environx` for `* /proc/*/environ*`): the denied commands most likely to look rewritable. Nothing is executed.
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname, delimiter } from "node:path";
const argv = process.argv.slice(2);
const hookAt = argv.indexOf("--hook");
const hookPath = hookAt >= 0 ? resolve(argv[hookAt + 1] ?? "") : null;
const args = argv.filter((a, i) => !a.startsWith("--") && !(hookAt >= 0 && i === hookAt + 1));
const asJson = argv.includes("--json");
const settingsPath = resolve(args[0] ?? ".claude/settings.json");
const RTK = process.env.RTK_BIN;
if (!RTK && !hookPath) { console.error("set RTK_BIN to the verified rtk binary, or pass --hook <hook.mjs>"); process.exit(2); }
const deny = JSON.parse(readFileSync(settingsPath, "utf8")).permissions?.deny ?? [];
const bash = deny.map((r) => /^Bash\((.*)\)$/s.exec(r)?.[1]).filter((x) => x !== undefined);
const other = deny.filter((r) => !r.startsWith("Bash("));
const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
export function matches(pattern, cmd) {
  if (pattern.endsWith(":*")) { const p = pattern.slice(0, -2); if (!p.includes("*")) return cmd === p || cmd.startsWith(p + " "); return new RegExp("^" + p.split("*").map(esc).join(".*") + "( .*)?$", "s").test(cmd); }
  if (pattern.includes("*")) return new RegExp("^" + pattern.split("*").map(esc).join(".*") + "$", "s").test(cmd);
  return cmd === pattern;
}
const sample = (p) => (p.endsWith(":*") ? p.slice(0, -2) : p).replace(/\*/g, "x").replace(/\|\s*x$/, "| cat");
const clean = mkdtempSync(join(tmpdir(), "rtk-deny-")), home = mkdtempSync(join(tmpdir(), "rtk-home-"));
const env = (h) => ({ PATH: process.env.PATH, HOME: h, RTK_TELEMETRY_DISABLED: "1", XDG_CONFIG_HOME: join(h, "c"), XDG_DATA_HOME: join(h, "d"), NO_COLOR: "1" });
const rewrite = (cmd, cwd, h) => { const r = spawnSync(RTK, ["rewrite", cmd], { cwd, env: env(h), encoding: "utf8", timeout: 15000 }); return { code: r.status, out: (r.stdout ?? "").trim() }; };
const rows = [];
if (hookPath) {
  const bin = mkdtempSync(join(tmpdir(), "rtk-bin-"));
  writeFileSync(join(bin, "rtk"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "rtk"), 0o755);
  const projectDir = dirname(dirname(settingsPath));
  const hookEnv = { PATH: bin + delimiter + (process.env.PATH ?? ""), HOME: home, CLAUDE_PROJECT_DIR: projectDir };
  const runHook = (cmd) => {
    const r = spawnSync(process.execPath, [hookPath], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd }, cwd: projectDir }), env: hookEnv, encoding: "utf8", timeout: 15000 });
    const out = (r.stdout ?? "").trim();
    if (r.status !== 0) return { code: r.status, rewritten: null, error: (r.stderr ?? "").slice(0, 200) };
    if (!out) return { code: 0, rewritten: null };
    return { code: 0, rewritten: JSON.parse(out)?.hookSpecificOutput?.updatedInput?.command ?? null };
  };
  // A probe that the stand-in works: an allowlisted command that no rule names must be rewritten, or the run proves nothing.
  const probe = runHook("git status");
  const FRONT = ["git status", "git log --oneline -20", "ls -la", "grep -rl x", "rg -l x", "git diff --stat", "find .", "tree", "npm ls"];
  for (const p of bash) {
    const base = sample(p);
    const cmds = [base];
    if (p.includes("*")) for (const f of FRONT) for (const c of [f + " " + base, base.replace(/^x/, f)]) if (c !== base && matches(p, c) && !cmds.includes(c)) cmds.push(c);
    for (const cmd of cmds) {
      const h = runHook(cmd);
      const verdict = h.code !== 0 ? "HOOK_ERROR" : h.rewritten === null ? "UNCHANGED" : matches(p, h.rewritten) ? "STILL_MATCHES" : "BYPASSED";
      rows.push({ pattern: `Bash(${p})`, sample: cmd, sane: matches(p, cmd), rewritten: h.rewritten, verdict });
    }
  }
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const summary = { mode: "hook", hook: hookPath, rules: deny.length, bash_rules: bash.length, non_bash_rules: other.length, samples: rows.length,
    probe_rewritten: probe.rewritten, sanity_failures: rows.filter((r) => !r.sane).length, unchanged: count("UNCHANGED"), still_matches: count("STILL_MATCHES"),
    bypassed: count("BYPASSED"), hook_errors: count("HOOK_ERROR"), non_bash_note: "Read(...) rules guard the Read tool, which a Bash-only hook never rewrites: not affected" };
  if (asJson) console.log(JSON.stringify({ summary, rows }));
  else {
    console.log(JSON.stringify(summary));
    for (const r of rows.filter((x) => x.verdict === "BYPASSED" || x.verdict === "HOOK_ERROR")) console.log(`${r.verdict} ${r.pattern} :: '${r.sample}' -> '${r.rewritten}'`);
  }
  process.exit(summary.bypassed || summary.hook_errors || summary.sanity_failures || probe.rewritten !== "rtk git status" ? 1 : 0);
}
for (const p of bash) {
  const cmd = sample(p);
  const sane = matches(p, cmd);
  const blind = rewrite(cmd, clean, home);
  let verdict, rewritten = null;
  if (blind.code === 1 || blind.out === "") verdict = "UNCHANGED";
  else if (blind.code === 2) verdict = "RTK_REFUSES";
  else { rewritten = blind.out; verdict = matches(p, rewritten) ? "STILL_MATCHES" : "BYPASSED"; }
  const aware = rewrite(cmd, process.cwd(), home);
  rows.push({ pattern: `Bash(${p})`, sample: cmd, sane, rtk_rewrite_exit: blind.code, rewritten, verdict, rtk_with_rules_exit: aware.code, rtk_with_rules_refuses: aware.code === 2 });
}
const count = (v) => rows.filter((r) => r.verdict === v).length;
const summary = { rules: deny.length, bash_rules: bash.length, non_bash_rules: other.length, sanity_failures: rows.filter((r) => !r.sane).length,
  unchanged: count("UNCHANGED"), still_matches: count("STILL_MATCHES"), rtk_refuses: count("RTK_REFUSES"), bypassed: count("BYPASSED"),
  bypassed_but_rtk_refuses_with_rules: rows.filter((r) => r.verdict === "BYPASSED" && r.rtk_with_rules_refuses).length,
  non_bash_note: "Read(...) rules guard the Read tool, which a Bash-only hook never rewrites: not affected" };
if (asJson) console.log(JSON.stringify({ summary, rows }));
else {
  console.log(JSON.stringify(summary));
  for (const r of rows.filter((x) => x.verdict === "BYPASSED")) console.log(`BYPASSED ${r.pattern} :: '${r.sample}' -> '${r.rewritten}' (rtk with rules: exit ${r.rtk_with_rules_exit})`);
}
process.exit(summary.bypassed || summary.sanity_failures ? 1 : 0);
