// Upstream sync (PRD FR8a, T-486): a pilot remote that follows an https upstream (GitHub or Gitea). The upstream's branches are fetched
// into a staging namespace (`refs/upstream/heads/*`, the only place a forced update is allowed), then each `refs/heads/<b>` moves only
// by a fast-forward, with a compare-and-swap. A branch that diverged is left as it is and reported with both shas; a branch new upstream
// is created; a branch gone upstream is kept and reported. Each moved branch writes the same event a push writes, so the same triggers fire.
//
// The credential: a Secrets & env NAME, read here from the file the workspace was given, and handed to the one `git fetch` child in its
// environment (`GIT_CONFIG_*`, an `http.<origin>/.extraHeader` scoped to the upstream's origin). Never in argv, the URL, a reply or a log:
// git's own message is scrubbed of the value before it leaves.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { NULL_SHA } from '../plan.js';
import { Fail, git, validRefName, validSha } from './common.js';
import { emitEvents, type RefUpdate } from './events.js';
import { needRepo } from './repo.js';

/** A Secrets & env name as the runner accepts it: a file name under the secrets folder, nothing that walks out of it. */
export const SECRET_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** The proxy variables curl reads; emptied for the upstream fetch so the pinned address is where it connects. */
const NO_PROXY_VARS = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'];

/** The upstream URL, or a Fail: https, a host, a plain path; no user, password, query or fragment (a token never rides in a URL). */
export function upstreamUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 500 || /[\s\0]/.test(raw)) throw new Fail('bad_url', 'The upstream is an https URL.');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Fail('bad_url', 'The upstream is an https URL.');
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.search || u.hash) throw new Fail('bad_url', 'The upstream is an https URL with no user, password, query or fragment.');
  if (!/^\/[A-Za-z0-9._~/-]+$/.test(u.pathname) || u.pathname.includes('..')) throw new Fail('bad_url', 'The upstream\'s path is letters, digits and . _ ~ / -.');
  return u;
}

/** The value of a delivered secret (`<etc>/secrets/files/<NAME>`, as a pipeline's secrets are read), or a Fail that names only the name. */
function secretValue(name: string): string {
  if (!SECRET_NAME.test(name) || name.includes('..')) throw new Fail('bad_secret', 'That is not a secret\'s name.');
  const etc = dirname(dirname(realpathSync(process.argv[1]!)));
  const path = join(etc, 'secrets', 'files', name);
  let text: string;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 65_536) throw new Error('size');
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Fail('no_secret', `The secret ${name} is not available in this workspace. Assign it in Secrets & env as a secret or a tool login.`);
  }
  const value = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!value || /[\r\n\0]/.test(value)) throw new Fail('no_secret', `The secret ${name} is empty or has more than one line.`);
  return value;
}

/** Removes every form of the value from text git wrote (the value, its header's base64, any Authorization line). */
export function scrub(text: string, values: string[]): string {
  let out = text;
  for (const v of values) if (v) out = out.split(v).join('***');
  return out.replace(/authorization:[^\n]*/gi, 'Authorization: ***');
}

async function heads(dir: string, prefix: string): Promise<Map<string, string>> {
  const r = await git(['for-each-ref', '--format=%(refname)%00%(objectname)', prefix], { gitDir: dir });
  const out = new Map<string, string>();
  if (r.code !== 0) return out;
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const [ref, sha] = line.split('\0');
    if (!ref || !validSha(sha) || !ref.startsWith(prefix)) continue;
    out.set(ref.slice(prefix.length), sha);
  }
  return out;
}

export interface SyncDiverged {
  branch: string;
  local: string;
  upstream: string;
}

/**
 * `repo sync <name> --url <https> [--secret <NAME>] [--pin <ip>]`. `--pin` is the address the portal resolved and checked (the SSRF
 * guard): git connects to it and to nothing else for that host, so a name that resolves elsewhere a moment later is never reached.
 */
export async function repoSync(repo: unknown, opts: { url: unknown; secret?: string; pin?: string; reset?: boolean }): Promise<Record<string, unknown>> {
  const dir = needRepo(repo);
  const url = upstreamUrl(opts.url);
  // `--reset`: the upstream was changed or removed, so the old one's staging refs go and this sync is a baseline again.
  if (opts.reset) {
    for (const name of (await heads(dir, 'refs/upstream/heads/')).keys()) {
      const r = await git(['update-ref', '-d', `refs/upstream/heads/${name}`], { gitDir: dir });
      if (r.code !== 0) throw new Fail('reset_failed', 'The old upstream\'s staged branches could not be cleared.');
    }
  }
  // The pin must decide where git connects: no proxy and no URL rewrite from outside. The workspace's global and system git
  // configuration are not read for this one call (an `insteadOf` or `http.proxy` there), and the proxy variables are emptied (curl
  // ignores an empty one); `-c http.proxy=` below turns git's own proxy off. The remote's own configuration (the portal's) still counts.
  const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const name of NO_PROXY_VARS) env[name] = '';
  const hide: string[] = [];
  if (opts.secret !== undefined) {
    const value = secretValue(opts.secret);
    const basic = Buffer.from(`x-access-token:${value}`).toString('base64');
    hide.push(value, basic);
    // Scoped to the upstream's origin: a redirect (refused anyway) or a rewrite elsewhere never carries it.
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.${url.origin}/.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  const pin: string[] = [];
  if (opts.pin !== undefined) {
    const v = isIP(opts.pin);
    if (!v) throw new Fail('bad_pin', 'The pinned address is not an IP address.');
    pin.push('-c', `http.curloptResolve=${url.hostname}:${url.port || '443'}:${v === 6 ? `[${opts.pin}]` : opts.pin}`);
  }

  const before = await heads(dir, 'refs/upstream/heads/');
  const fetch = await git(
    [
      // Only https leaves, no redirect is followed, no helper is asked, nothing prompts.
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false', '-c', 'credential.helper=',
      '-c', 'http.proxy=',
      ...pin,
      'fetch', '--quiet', '--no-tags', '--prune', '--no-write-fetch-head', '--', url.href, '+refs/heads/*:refs/upstream/heads/*',
    ],
    { gitDir: dir, env, timeoutMs: 600_000 },
  );
  if (fetch.code !== 0) {
    const line = scrub(fetch.stderr, hide).trim().split('\n').filter(Boolean).pop() ?? '';
    throw new Fail('fetch_failed', (line || 'git could not fetch the upstream.').slice(0, 300));
  }
  const upstream = await heads(dir, 'refs/upstream/heads/');
  const local = await heads(dir, 'refs/heads/');

  const moved: RefUpdate[] = [];
  const created: string[] = [];
  const diverged: SyncDiverged[] = [];
  const ahead: string[] = [];
  const failed: string[] = [];
  const ancestor = async (a: string, b: string) => (await git(['merge-base', '--is-ancestor', a, b], { gitDir: dir })).code === 0;
  for (const [branch, sha] of [...upstream].sort(([a], [b]) => a.localeCompare(b))) {
    if (!validRefName(branch)) continue;
    const mine = local.get(branch);
    const ref = `refs/heads/${branch}`;
    if (mine === sha) continue;
    if (mine === undefined) {
      // A branch new upstream: create it, only if it still does not exist.
      const r = await git(['update-ref', '-m', 'upstream sync: create', ref, sha, NULL_SHA], { gitDir: dir });
      if (r.code === 0) {
        moved.push({ ref, old: NULL_SHA, new: sha });
        created.push(branch);
      } else failed.push(branch);
      continue;
    }
    if (await ancestor(mine, sha)) {
      // A fast-forward, with a compare-and-swap: a push that landed meanwhile wins and is looked at next time.
      const r = await git(['update-ref', '-m', 'upstream sync: fast-forward', ref, sha, mine], { gitDir: dir });
      if (r.code === 0) moved.push({ ref, old: mine, new: sha });
      else failed.push(branch);
    } else if (await ancestor(sha, mine)) ahead.push(branch);
    else diverged.push({ branch, local: mine, upstream: sha });
  }
  // Gone upstream: the staging copy was pruned. The branch here is kept (the default) and reported.
  const deleted = [...before.keys()].filter((b) => !upstream.has(b) && validRefName(b)).sort();
  const onlyHere = [...local.keys()].filter((b) => !upstream.has(b) && validRefName(b)).sort();
  // The first sync (nothing staged yet) records the upstream's branches as the baseline: they move here, but no pipeline starts for
  // branches that were already there. Only a later move triggers. (An upstream with no branch at all stays "first" until it has one.)
  const baseline = before.size === 0;
  const events = baseline ? { written: [], dropped: 0 } : emitEvents(repo as string, moved, 'push', 'upstream');
  return {
    ok: true,
    baseline,
    moved: moved.map((m) => ({ branch: m.ref.slice(11), old: m.old, new: m.new })),
    created,
    diverged,
    ahead,
    deleted,
    onlyHere,
    failed,
    events: events.written.length,
    dropped: events.dropped,
  };
}
