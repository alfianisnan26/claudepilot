import type { Tombstone } from './types.js';

/**
 * Tombstones (secrets PRD A6, foundation §6.4). Claude Code applies a changed `env` value to running
 * sessions at their next request but keeps a removed one until the session ends, so an owner that takes
 * a variable back writes a safe value over it instead. The safe value can go once every `claude` process
 * that might still hold the old value has exited: the reconciler asks the workspace for the age of each
 * running `claude` process (nothing else: no environments, no command lines) and drops a tombstone when
 * none is older than it.
 */

/** A process this close to a tombstone's time counts as older: ages are whole seconds, and the write takes a moment. */
export const TOMBSTONE_SLACK_MS = 2_000;

/**
 * A function, run with Node inside the workspace, returning the age in whole seconds of every live
 * `claude` process (`comm` or executable named `claude`, as the native build runs). It reads only
 * `comm`, the `exe` link and `stat`; never `environ` or `cmdline`. `hz` is the kernel's clock tick.
 */
export const CLAUDE_AGES_JS = `(hz)=>{const fs=require("fs"),up=parseFloat(fs.readFileSync("/proc/uptime","utf8")),out=[],names=["claude","claude.exe"];
for(const d of fs.readdirSync("/proc")){if(!/^[0-9]+$/.test(d))continue;let comm="",exe="",st="";
try{comm=fs.readFileSync("/proc/"+d+"/comm","utf8").trim();st=fs.readFileSync("/proc/"+d+"/stat","utf8")}catch{continue}
try{exe=fs.readlinkSync("/proc/"+d+"/exe").split("/").pop()}catch{}
if(!names.includes(comm)&&!names.includes(exe))continue;const f=st.slice(st.lastIndexOf(")")+2).split(" ");
if(f[0]==="Z"||f[0]==="X")continue;out.push(Math.max(0,Math.floor(up-Number(f[19])/hz)))}return out}`;

/** Parses the ages the workspace printed (one integer per line); anything else is ignored. */
export function parseClaudeAges(text: string): number[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d{1,10}$/.test(l))
    .map(Number);
}

/**
 * The tombstones still needed. A stopped workspace needs none: no session survives a stop. A running
 * one keeps each tombstone while some `claude` process started before it (within the slack) still runs,
 * and keeps all of them when it couldn't tell (`claudeAges` null).
 */
export function settleTombstones(tombstones: Tombstone[], ctx: { running: boolean; claudeAges: number[] | null; now: number }): Tombstone[] {
  if (!ctx.running) return [];
  if (!ctx.claudeAges) return tombstones;
  const oldestMs = ctx.claudeAges.length ? Math.max(...ctx.claudeAges) * 1000 : -Infinity;
  return tombstones.filter((t) => oldestMs > ctx.now - t.since - TOMBSTONE_SLACK_MS);
}

export const tombstoneKey = (t: { owner: string; name: string }) => `${t.owner}\0${t.name}`;
