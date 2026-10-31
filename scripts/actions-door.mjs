#!/usr/bin/env node
// The Gitea Actions door (T-3192): a lead or a lane reads the Actions runs of a Konfersi repository on git.konfersi.com, so a CI step can
// be cited as evidence. A NARROW DOOR: read only (every request is a GET, there is no other request function), one host (pinned below,
// no flag or variable changes it), repositories `konfersi-*` of the `platform` organisation only, and a token that is read from a file
// and never printed. Tested with a mocked API: apps/server/src/qa/actionsDoor.test.ts.
//
//   node scripts/actions-door.mjs runs <repo> <branch> [--limit N]                  the branch's recent runs (default 5, at most 20): run id,
//                                                                                   head sha, status, and each job's steps with their result
//   node scripts/actions-door.mjs log <repo> <run-id> <step> [--job <name>] [--lines N]
//                                                                                   the last N lines (default 40, at most 200) of that step's log
//
// <repo> is `konfersi-<name>` (or `platform/konfersi-<name>`). The token: the file whose path is in GITEA_ACTIONS_READ_TOKEN_FILE (it
// needs read on the repository's actions and nothing more). Printed log lines are cleaned of control characters and of anything
// credential-shaped (the token itself, `Authorization:`/`token=` values, known key prefixes, long hex and base64 runs).
//
// Exit codes: 0 done; 1 bad arguments; 2 no token (the variable unset, the file unreadable or empty); 3 the token lacks actions read
// (401/403); 4 not found (404, or no such step in the run); 5 any other HTTP answer, a timeout (20 s) or a network error.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const HOST = 'https://git.konfersi.com';
export const ORG = 'platform';
export const TOKEN_ENV = 'GITEA_ACTIONS_READ_TOKEN_FILE';
export const CAPS = Object.freeze({ lines: 200, defaultLines: 40, runs: 20, defaultRuns: 5, jobs: 50, timeoutMs: 20_000 });
export const EXIT = Object.freeze({ ok: 0, usage: 1, token: 2, auth: 3, notFound: 4, http: 5 });

const REPO = /^(?:platform\/)?(konfersi-[a-z0-9-]{1,80})$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const RUN_ID = /^\d{1,18}$/;
const COUNT = /^\d{1,4}$/;
// A step or job name: printable text, no control characters, at most 200 characters.
const NAME = /^[^\u0000-\u001f\u007f]{1,200}$/;

const USAGE = [
  'usage: actions-door.mjs runs <konfersi-repo> <branch> [--limit N]',
  '       actions-door.mjs log <konfersi-repo> <run-id> <step name> [--job <job name>] [--lines N]',
].join('\n');

class DoorError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Arguments to a plan, or a DoorError(usage). No option names a host, a URL or a token: there is nothing to override. */
export function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' || a === '--lines' || a === '--job') {
      if (i + 1 >= argv.length) throw new DoorError(EXIT.usage, `${a} needs a value`);
      opt[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new DoorError(EXIT.usage, `unknown option ${a.split('=')[0].slice(0, 40)}`);
    else pos.push(a);
  }
  const [cmd, repoArg, ...rest] = pos;
  if (cmd !== 'runs' && cmd !== 'log') throw new DoorError(EXIT.usage, USAGE);
  const repo = REPO.exec(repoArg ?? '')?.[1];
  if (!repo) throw new DoorError(EXIT.usage, 'repo must be konfersi-<name> (lower case letters, digits, dashes)');
  if (cmd === 'runs') {
    if (rest.length !== 1 || opt.lines !== undefined || opt.job !== undefined) throw new DoorError(EXIT.usage, USAGE);
    const branch = rest[0];
    if (!BRANCH.test(branch) || branch.includes('..'))
      throw new DoorError(EXIT.usage, 'branch: letters, digits, . _ / - only, at most 200');
    return { cmd, repo, branch, limit: count(opt.limit, CAPS.defaultRuns, CAPS.runs, '--limit') };
  }
  if (rest.length !== 2 || opt.limit !== undefined) throw new DoorError(EXIT.usage, USAGE);
  const [runId, step] = rest;
  if (!RUN_ID.test(runId)) throw new DoorError(EXIT.usage, 'run id: digits only');
  if (!NAME.test(step)) throw new DoorError(EXIT.usage, 'step name: 1 to 200 printable characters');
  if (opt.job !== undefined && !NAME.test(opt.job)) throw new DoorError(EXIT.usage, 'job name: 1 to 200 printable characters');
  return { cmd, repo, runId, step, job: opt.job, lines: count(opt.lines, CAPS.defaultLines, CAPS.lines, '--lines') };
}

function count(value, dflt, cap, flag) {
  if (value === undefined) return dflt;
  if (!COUNT.test(value) || Number(value) < 1) throw new DoorError(EXIT.usage, `${flag}: a whole number from 1`);
  return Math.min(Number(value), cap);
}

/** The token from the file named by TOKEN_ENV, or a DoorError(token). The message names the variable, never the value or its content. */
export function readToken(env) {
  const file = env[TOKEN_ENV];
  if (!file) throw new DoorError(EXIT.token, `${TOKEN_ENV} is not set: it names the file that holds a Gitea token with actions read`);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new DoorError(EXIT.token, `the file named by ${TOKEN_ENV} cannot be read`);
  }
  const token = text.trim();
  if (!token || token.length > 512 || /\s/.test(token))
    throw new DoorError(EXIT.token, `the file named by ${TOKEN_ENV} does not hold one token`);
  return token;
}

/* ---------- Cleaning what is printed ---------- */

// Terminal escapes (CSI and OSC) and the other control characters: an API field or a log line cannot move the cursor or retitle a terminal.
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[\u0000-\u0008\u000b-\u001f\u007f]/g;
const REDACTED = '[redacted]';
const SHAPES = [
  // `Authorization: token x`, `Authorization: Bearer x`, `Authorization: Basic x`: everything after the colon.
  [/(authorization["']?\s*[:=]\s*)\S.*$/gi, '$1' + REDACTED],
  // `Bearer x`, `token x` with a long value.
  [/\b((?:bearer|token)\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1' + REDACTED],
  // `token=x`, `"password": "x"`, `api_key: x`, `GITEA_TOKEN=x`: the value.
  [
    /([A-Za-z0-9_.-]{0,40}(?:token|secret|password|passwd|api[_-]?key)[A-Za-z0-9_.-]{0,40}["']?\s{0,4}[:=]\s{0,4}["']?)[^\s"',;]{6,}/gi,
    '$1' + REDACTED,
  ],
  // Known key prefixes (GitHub, GitLab, Anthropic, Slack, AWS, the portal's own tokens).
  [/\b(?:gh[pousr]_|github_pat_|glpat-|sk-ant-|xox[abprs]-|cp(?:at|oa|or|st|en|na|wh|ws|ns)_)[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/-----BEGIN [A-Z0-9 ]{0,24}PRIVATE KEY-----.*$/g, REDACTED],
  // A Gitea token is 40 hex characters, the same shape as a commit: every hex run of 32 or more goes (a commit in a log line too).
  [/\b[0-9a-fA-F]{32,}\b/g, REDACTED],
  // A long base64 or base64url run with a letter and a digit in it.
  [/(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]{0,39}[0-9])(?=[A-Za-z0-9+/_-]{0,39}[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}/g, REDACTED],
];

/** One line of untrusted text made safe to print: no control characters, the token itself and every credential shape replaced. */
export function cleanLine(line, token) {
  let s = String(line).replace(CONTROL, '');
  if (token) s = s.split(token).join(REDACTED);
  for (const [re, to] of SHAPES) s = s.replace(re, to);
  return s;
}

/** API metadata (names, titles, states): control characters out and the token out; shapes stay (a sha must stay readable). */
function cleanField(value, token) {
  let s = String(value ?? '').replace(CONTROL, '');
  if (token) s = s.split(token).join(REDACTED);
  return s.slice(0, 200);
}

/* ---------- The API: GET only ---------- */

function makeGet({ base, token, fetchImpl, timeoutMs }) {
  const origin = new URL(base).origin;
  const prefix = `${origin}/api/v1/repos/${ORG}/`;
  // The only request this script makes. Its method is fixed; there is no body; a redirect is refused (the token never follows one).
  return async function get(path, as) {
    const url = prefix + path;
    if (!url.startsWith(prefix) || new URL(url).origin !== origin) throw new DoorError(EXIT.usage, 'refused: not the pinned host');
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `token ${token}`, Accept: as === 'text' ? 'text/plain' : 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw new DoorError(
        EXIT.http,
        timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : 'the request failed (network or redirect)',
      );
    }
    if (res.status === 401 || res.status === 403)
      throw new DoorError(EXIT.auth, `HTTP ${res.status}: the token lacks actions read on this repository`);
    if (res.status === 404) throw new DoorError(EXIT.notFound, 'not found (HTTP 404)');
    if (!res.ok) throw new DoorError(EXIT.http, `HTTP ${res.status} from the Gitea API`);
    if (as === 'text') return await res.text();
    try {
      return await res.json();
    } catch {
      throw new DoorError(EXIT.http, 'the Gitea API answered something that is not JSON');
    }
  };
}

const q = encodeURIComponent;

async function jobsOf(get, repo, runId) {
  const body = await get(`${q(repo)}/actions/runs/${runId}/jobs?limit=${CAPS.jobs}`);
  return Array.isArray(body?.jobs) ? body.jobs : [];
}

const state = (x) => x?.conclusion || x?.status || 'unknown';

async function runs(plan, get, token, out) {
  const body = await get(`${q(plan.repo)}/actions/runs?branch=${q(plan.branch)}&limit=${plan.limit}`);
  const all = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
  // The branch filter is applied here too, in case the server ignores the query parameter.
  const list = all.filter((r) => !r?.head_branch || r.head_branch === plan.branch).slice(0, plan.limit);
  if (!list.length) {
    out(`${plan.repo} ${plan.branch}: no Actions runs`);
    return;
  }
  for (const r of list) {
    const id = String(r.id ?? '');
    if (!RUN_ID.test(id)) continue;
    out('');
    out(`run ${id}  ${cleanField(state(r), token)}`);
    out(`  sha ${cleanField(r.head_sha, token)}`);
    const when = r.started_at || r.created_at || r.run_started_at;
    out(`  ${cleanField(r.event || 'event?', token)}${when ? `  ${cleanField(when, token)}` : ''}`);
    if (r.display_title || r.name) out(`  ${cleanField(r.display_title || r.name, token)}`);
    for (const j of await jobsOf(get, plan.repo, id)) {
      out(`  job ${cleanField(j.name, token)}: ${cleanField(state(j), token)}`);
      for (const s of Array.isArray(j.steps) ? j.steps : [])
        out(`    ${cleanField(state(s), token).padEnd(9)} ${cleanField(s.name, token)}`);
    }
  }
}

// act_runner marks a step's start in the job log as `⭐ Run <stage> <step name>`; the next start ends it.
const STEP_START = '\u2b50 Run ';
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s?/;

/** The lines of one step in a whole job log, or null when the log has no start marker for it. */
export function stepSection(text, step) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(TIMESTAMP, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const isStart = (l) => {
    const at = l.indexOf(STEP_START);
    if (at < 0) return false;
    const rest = l.slice(at + STEP_START.length).trimEnd();
    return rest === step || rest.replace(/^(?:Main|Pre|Post) /, '') === step;
  };
  const start = lines.findIndex(isStart);
  if (start < 0) return { lines, found: false };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].includes(STEP_START)) {
      end = i;
      break;
    }
  }
  return { lines: lines.slice(start, end), found: true };
}

async function log(plan, get, token, out) {
  const jobs = await jobsOf(get, plan.repo, plan.runId);
  const named = plan.job === undefined ? jobs : jobs.filter((j) => j?.name === plan.job);
  const hits = named.filter((j) => Array.isArray(j?.steps) && j.steps.some((s) => s?.name === plan.step));
  if (!hits.length) {
    const names = [...new Set(named.flatMap((j) => (Array.isArray(j?.steps) ? j.steps.map((s) => cleanField(s?.name, token)) : [])))];
    throw new DoorError(
      EXIT.notFound,
      `no step named "${cleanField(plan.step, token)}" in run ${plan.runId}${plan.job === undefined ? '' : ` job "${cleanField(plan.job, token)}"`}` +
        (names.length ? `; its steps: ${names.slice(0, 30).join(' | ')}` : ''),
    );
  }
  if (hits.length > 1) {
    throw new DoorError(
      EXIT.usage,
      `step "${cleanField(plan.step, token)}" is in ${hits.length} jobs; name one with --job: ${hits.map((j) => cleanField(j.name, token)).join(' | ')}`,
    );
  }
  const job = hits[0];
  const jobId = String(job.id ?? '');
  if (!RUN_ID.test(jobId)) throw new DoorError(EXIT.http, 'the Gitea API gave a job without a numeric id');
  const step = job.steps.find((s) => s.name === plan.step);
  const text = await get(`${q(plan.repo)}/actions/jobs/${jobId}/logs`, 'text');
  const section = stepSection(text, plan.step);
  const tail = section.lines.slice(-plan.lines);
  out(
    `run ${plan.runId}  job ${cleanField(job.name, token)}: ${cleanField(state(job), token)}  step ${cleanField(plan.step, token)}: ${cleanField(state(step), token)}`,
  );
  if (!section.found) out(`(no start marker for this step in the job log: the last ${tail.length} lines of the whole job follow)`);
  else out(`(the last ${tail.length} of the step's ${section.lines.length} lines)`);
  for (const line of tail) out(cleanLine(line, token));
}

/**
 * The door. Returns the exit code; writes through `out` and `err` only. `base` and `fetchImpl` are for the tests: the command line calls
 * this with neither, so the host is HOST and the request goes through the global fetch.
 */
export async function main(
  argv,
  { env = {}, fetchImpl = globalThis.fetch, out = console.log, err = console.error, base = HOST, timeoutMs = CAPS.timeoutMs } = {},
) {
  let token = '';
  try {
    const plan = parseArgs(argv);
    token = readToken(env);
    const get = makeGet({ base, token, fetchImpl, timeoutMs });
    const safeOut = (line) => out(token ? String(line).split(token).join(REDACTED) : String(line));
    if (plan.cmd === 'runs') await runs(plan, get, token, safeOut);
    else await log(plan, get, token, safeOut);
    return EXIT.ok;
  } catch (e) {
    const code = e instanceof DoorError ? e.code : EXIT.http;
    const message = e instanceof DoorError ? e.message : 'unexpected error';
    err(`actions-door: ${token ? message.split(token).join(REDACTED) : message}`);
    return code;
  }
}

function isMain() {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  // Only the one variable is read from the environment, by name.
  main(process.argv.slice(2), { env: { [TOKEN_ENV]: process.env[TOKEN_ENV] } }).then((code) => {
    process.exitCode = code;
  });
}
