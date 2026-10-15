#!/usr/bin/env node
// External heartbeat (T-315, docs/prd/chat-sessions.md §23.3). Run by .github/workflows/heartbeat.yml every 5 minutes.
// Probes GET <url> (the portal's /healthz). A MISS is a resolved host that answers non-2xx or times out. A BLIND probe is a
// name that does not resolve or a connect that cannot route (ENOTFOUND, EAI_AGAIN, ENETUNREACH, EHOSTUNREACH): the runner
// cannot see the portal, which says nothing about the portal. A run probes, and on a miss waits and probes once more: two
// misses in ONE run are "two in a row", so no state is kept between runs. Two misses open ONE issue labelled portal-down;
// a blind probe opens ONE issue labelled heartbeat-blind instead (never a portal-down). Never a second while one of the
// label is open; a probe that sees the portal closes both with a comment. The log names the error class only (no headers,
// no bodies). Only GITHUB_TOKEN is used. Node 22, no dependencies.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name), GITHUB_API_URL (default https://api.github.com).
// Args: --url <health url> [--retry-delay-ms 60000] [--timeout-ms 10000] [--dry-run]
// With --dry-run nothing is written to GitHub: the intended action is printed.

const DOWN = 'portal-down';
const BLIND = 'heartbeat-blind';
const BLIND_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

export async function probe(url, timeoutMs, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return { ok: res.status >= 200 && res.status < 300, blind: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    const code = e?.cause?.code ?? e?.code ?? e?.name ?? 'error';
    return { ok: false, blind: BLIND_CODES.has(code), detail: `no answer (${code})` };
  }
}

function gh({ api, repo, token }) {
  const call = async (method, path, body) => {
    const res = await fetch(`${api}/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status}`);
    return res.json();
  };
  return {
    openIssues: async (label) => (await call('GET', `/issues?state=open&labels=${label}&per_page=10`)).filter((i) => !i.pull_request),
    open: (title, body, label) => call('POST', '/issues', { title, body, labels: [label] }),
    comment: (n, body) => call('POST', `/issues/${n}/comments`, { body }),
    close: (n) => call('PATCH', `/issues/${n}`, { state: 'closed' }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns what was done: 'up', 'up-closed', 'miss', 'down-opened', 'down-already-open'. */
export async function run({ url, retryDelayMs, timeoutMs, dryRun, api, repo, token, log = console.log }) {
  const first = await probe(url, timeoutMs);
  let last = first;
  let misses = first.ok ? 0 : 1;
  if (!first.ok && !first.blind) {
    log(`miss 1: ${first.detail}`);
    await sleep(retryDelayMs);
    last = await probe(url, timeoutMs);
    if (!last.ok && !last.blind) {
      misses = 2;
      log(`miss 2: ${last.detail}`);
    }
  }
  const blind = misses < 2 && (first.blind || last.blind);
  if (blind) log(`blind: ${(last.blind ? last : first).detail}`);
  const client = gh({ api, repo, token });
  // Dry run still READS the issues (the test's fake API); it only skips writes.
  const w = dryRun ? { open: async () => ({}), comment: async () => ({}), close: async () => ({}) } : client;
  const tag = dryRun ? ' (dry run)' : '';
  const sawPortal = first.ok || last.ok || misses === 2 || (!blind && misses === 1);
  const [downOpen, blindOpen] = [await client.openIssues(DOWN), await client.openIssues(BLIND)];
  // A probe that reached the portal (answered or missed on a resolved host) ends any blind issue.
  if (sawPortal && blindOpen.length > 0) {
    log(`the portal is visible again; closing blind issue #${blindOpen[0].number}${tag}`);
    for (const i of blindOpen) {
      await w.comment(i.number, `The probe reaches the portal again (${(last.ok ? last : first).detail}). Closing.`);
      await w.close(i.number);
    }
  }
  if (blind) {
    if (blindOpen.length > 0) {
      log(`blind; issue #${blindOpen[0].number} is already open`);
      return 'blind-already-open';
    }
    log(`blind; opening an issue${tag}`);
    await w.open(
      'Heartbeat is blind',
      `The heartbeat (scripts/heartbeat.mjs) cannot see ${url} from its runner: ${(last.blind ? last : first).detail}. This says nothing about the portal; a name that resolves only on a private network cannot be probed from here. The probe needs to move to a host that can reach it. This issue closes itself when a probe sees the portal.`,
      BLIND,
    );
    return 'blind-opened';
  }
  if (misses === 2) {
    if (downOpen.length > 0) {
      log(`down; issue #${downOpen[0].number} is already open`);
      return 'down-already-open';
    }
    log(`down; opening an issue${tag}`);
    await w.open(
      'Portal is down',
      `The heartbeat (scripts/heartbeat.mjs) got no healthy answer from ${url} twice in a row at ${new Date().toISOString()}: ${first.detail}, then ${last.detail}.\n\nThis issue closes itself when the portal answers again.`,
      DOWN,
    );
    return 'down-opened';
  }
  if (misses === 0 && downOpen.length > 0) {
    log(`up; closing issue #${downOpen[0].number}${tag}`);
    for (const i of downOpen) {
      await w.comment(i.number, `The portal answers again (${first.detail}) at ${new Date().toISOString()}. Closing.`);
      await w.close(i.number);
    }
    return 'up-closed';
  }
  log(misses === 0 ? 'up' : 'one miss, then an answer: nothing to do');
  return misses === 0 ? 'up' : 'miss';
}

function args(argv) {
  const o = { retryDelayMs: 60000, timeoutMs: 10000, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') o.url = argv[++i];
    else if (argv[i] === '--retry-delay-ms') o.retryDelayMs = Number(argv[++i]);
    else if (argv[i] === '--timeout-ms') o.timeoutMs = Number(argv[++i]);
    else if (argv[i] === '--dry-run') o.dryRun = true;
  }
  return o;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv.slice(2));
  const env = process.env;
  if (!o.url || !env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    console.error('need --url, GITHUB_TOKEN and GITHUB_REPOSITORY');
    process.exit(2);
  }
  run({ ...o, api: env.GITHUB_API_URL || 'https://api.github.com', repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN })
    .then((r) => console.log(`result: ${r}`))
    .catch((e) => {
      console.error(String(e?.message ?? e));
      process.exit(1);
    });
}
