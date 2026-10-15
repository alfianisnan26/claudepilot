// T-561: the lead rules (chat-sessions PRD FR79, D-63). A crew lead plans, routes, merges and deploys; it does not edit code (D-63 item 3),
// and a lead's edit costs several times a worker's. With the policy `sessions.leadRules` on, a lead's process launches with ONE
// `--settings` value from the portal (the project's trusted permission rules merged with these; never the repository's own rule files): a PreToolUse hook on Edit, Write, MultiEdit and NotebookEdit
// that refuses a path outside its status files, its notes folder and the scratch folder, and tells it to dispatch a worker. Bash stays.
//
// A hook, not `permissions.deny`: in Claude Code a deny rule beats every allow rule, so "deny Edit except the status file" cannot be written
// as rules, and a deny rule carries no reason. A PreToolUse hook that exits 2 stops the call in every permission mode, Bypass included
// (the rule guard of D-60 relies on the same), and Claude reads its stderr: that is where the D-63 text goes.
//
// A lead: a session its starter marked one (`lead: true` on create: the dev supervisor's leads; a continuation keeps it), or one that has
// started a worker. The rules are fixed when the process starts: a session that becomes a lead mid-run gets them at its next start.

import { posix } from 'node:path';
import { defineSetting } from '../settings/registry.js';

/** The policy: off by default. Deny rules are a charter wall, so a person turns it on (Settings, `PUT /api/settings/:key`, admins). */
export const LEAD_RULES_SETTING = 'sessions.leadRules';

defineSetting({
  key: LEAD_RULES_SETTING,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'sessions',
  order: 12,
  label: 'Lead rules',
  help: 'A crew lead (a session with workers, or one the supervisor started) may not edit files outside its status files (docs/dev-sessions/status), its notes (docs/dev-sessions/notes) and /tmp: a refused edit tells it to dispatch a worker (D-63). Bash stays allowed. A session that has ever started a worker counts as a lead, for good, even when the worker ended. Applies at each session’s next start, Bypass included.',
  protective: true,
  confirmText: 'Leads will be able to edit code again.',
});

/** The folders a lead may still write with the file tools, relative to its own folder; and the scratch folder, absolute. */
export const LEAD_STATUS_DIR = 'docs/dev-sessions/status';
export const LEAD_NOTES_DIR = 'docs/dev-sessions/notes';
export const LEAD_SCRATCH_DIR = '/tmp';

/** What Claude reads when an edit is refused: what to do instead, and why (D-63). */
export const LEAD_RULES_MESSAGE =
  'Refused by the lead rules (D-63): a crew lead does not edit files. Dispatch a worker for this change (session_spawn, or session_message to a live one). ' +
  `You may still edit your status files (${LEAD_STATUS_DIR}/), your notes (${LEAD_NOTES_DIR}/) and the scratch folder (${LEAD_SCRATCH_DIR}/).`;

/** The file tools the hook runs on (MultiEdit: the older name some versions still have). */
export const LEAD_RULES_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

/** Whether a session is a crew lead: marked so at its start, or it has started a worker. */
export function isLead(row: { lead?: number | null }, hasWorkers: boolean): boolean {
  return row.lead === 1 || hasWorkers;
}

/** The absolute folders a lead in `cwd` may write with the file tools. */
export function leadAllowedDirs(cwd: string): string[] {
  const root = posix.resolve('/', cwd);
  return [posix.join(root, LEAD_STATUS_DIR), posix.join(root, LEAD_NOTES_DIR), LEAD_SCRATCH_DIR];
}

/**
 * The hook's program: reads the PreToolUse input on stdin, resolves the tool's path (against the call's `cwd`, else the lead's folder), and
 * exits 0 for a path inside an allowed folder, else writes the message to stderr and exits 2. Input it cannot read is refused. Plain
 * JavaScript with no single quote (it goes inside one on the command line).
 */
export function leadHookScript(cwd: string): string {
  const script =
    `const p=require("path"),fs=require("fs");const msg=${JSON.stringify(LEAD_RULES_MESSAGE)};` +
    // The real path of the nearest existing parent, the rest appended. A link whose target does not exist yet is read (readlink) and judged
    // by where it points, up to 8 levels (a chain or a loop beyond that is refused).
    `const rp=(a,n)=>{n=n||0;let t=a,r="";for(;;){try{return p.join(fs.realpathSync(t),r);}catch(e){try{const l=fs.readlinkSync(t);if(n>=8)return "/lead-rules-link-loop";return rp(p.join(p.resolve(fs.realpathSync(p.dirname(t)),l),r),n+1);}catch(e2){}const u=p.dirname(t);if(u===t)return a;r=p.join(p.basename(t),r);t=u;}}};` +
    // An allowed folder that is itself a link leading elsewhere (status -> apps) is dropped: its resolved path must lie where it does under the resolved session folder.
    `const root=${JSON.stringify(posix.resolve('/', cwd))};const rr=rp(root);` +
    `const ok=${JSON.stringify(leadAllowedDirs(cwd))}.filter((d)=>d.startsWith(root+"/")?rp(d)===p.join(rr,p.relative(root,d)):true).map((d)=>rp(d));` +
    `let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(c)=>{s+=c;});process.stdin.on("end",()=>{` +
    `let f="";let base=${JSON.stringify(posix.resolve('/', cwd))};` +
    // A call that carries agent_id comes from a sub-agent: a dispatch, allowed (D-47).
    `try{const i=JSON.parse(s);if(i&&typeof i.agent_id==="string"&&i.agent_id){process.exitCode=0;return;}const t=(i&&i.tool_input)||{};f=String(t.file_path||t.notebook_path||"");if(typeof i.cwd==="string"&&i.cwd.startsWith("/"))base=i.cwd;}catch(e){}` +
    `const a=f?rp(p.resolve(base,f)):"";` +
    `if(a&&ok.some((d)=>a===d||a.startsWith(d+"/"))){process.exitCode=0;return;}` +
    `process.exitCode=2;process.stderr.write(msg+(a?" Refused: "+a:"")+"\\n");});`;
  if (script.includes("'")) throw new Error('lead rules: the folder cannot be quoted for the hook');
  return script;
}

/** The hook command line: `node` from a fixed PATH in an emptied environment (nothing the session sets loads first); `|| exit 2`: a hook that cannot run refuses. */
export function leadHookCommand(cwd: string): string {
  return `/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin node -e '${leadHookScript(cwd)}' || exit 2`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * The ONE `--settings` value for a lead in `cwd`: inline JSON with the lead rules' hook, merged with the project settings the portal trusts
 * (`project`: the JSON the host's `psettings` printed, permission rules only; anything unreadable is left out, which only makes the lead
 * stricter). The permission lists are joined (allow, deny, ask: the project's first, no repeats) and the hooks are joined per event. Never two
 * `--settings` flags: how Claude Code treats a repeated flag is not something to depend on.
 */
export function leadRulesSettings(cwd: string, project?: string | null): string {
  const hook = { matcher: LEAD_RULES_MATCHER, hooks: [{ type: 'command', command: leadHookCommand(cwd), timeout: 15 }] };
  let theirs: Record<string, unknown> = {};
  try {
    const parsed: unknown = project ? JSON.parse(project) : {};
    if (isRecord(parsed)) theirs = parsed;
  } catch {
    // unreadable project settings: the lead rules alone
  }
  const out: Record<string, unknown> = {};
  const perms = isRecord(theirs.permissions) ? theirs.permissions : {};
  const permissions: Record<string, string[]> = {};
  for (const k of ['allow', 'deny', 'ask']) {
    const list = [...new Set(strings(perms[k]))];
    if (list.length) permissions[k] = list;
  }
  if (Object.keys(permissions).length) out.permissions = permissions;
  const hooks: Record<string, unknown[]> = {};
  if (isRecord(theirs.hooks)) for (const [ev, list] of Object.entries(theirs.hooks)) if (Array.isArray(list)) hooks[ev] = [...list];
  hooks.PreToolUse = [...(hooks.PreToolUse ?? []), hook];
  out.hooks = hooks;
  return JSON.stringify(out);
}
