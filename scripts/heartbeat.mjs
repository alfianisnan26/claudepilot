#!/usr/bin/env node
// External heartbeat (T-315, docs/prd/chat-sessions.md §23.3). Run by .github/workflows/heartbeat.yml every 5 minutes.
// Probes GET <url> (the portal's /healthz). A miss is a non-200 answer or no answer in 10 s. A run probes, and on a miss
// waits and probes once more: two misses in ONE run are "two in a row", so no state is kept between runs (no cache, no
// counter in an issue). Two misses open ONE issue labelled portal-down (never a second while one is open); an answer closes
// it with a comment. Only GITHUB_TOKEN is used. Node 22, no dependencies.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name), GITHUB_API_URL (default https://api.github.com).
// Args: --url <health url> [--retry-delay-ms 60000] [--timeout-ms 10000] [--dry-run]
// With --dry-run nothing is written to GitHub: the intended action is printed.

const LABEL = 'portal-down';

export async function probe(url, timeoutMs, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return { ok: res.status === 200, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: `no answer (${e?.cause?.code ?? e?.name ?? 'error'})` };
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
    openIssues: () => call('GET', `/issues?state=open&labels=${LABEL}&per_page=10`),
    open: (title, body) => call('POST', '/issues', { title, body, labels: [LABEL] }),
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
  if (!first.ok) {
    log(`miss 1: ${first.detail}`);
    await sleep(retryDelayMs);
    last = await probe(url, timeoutMs);
    if (!last.ok) {
      misses = 2;
      log(`miss 2: ${last.detail}`);
    }
  }
  const client = dryRun ? null : gh({ api, repo, token });
  // Dry run still READS the issues (the test's fake API); it only skips writes.
  const reader = client ?? gh({ api, repo, token });
  const open = (await reader.openIssues()).filter((i) => !i.pull_request);
  if (misses === 2) {
    if (open.length > 0) {
      log(`down; issue #${open[0].number} is already open`);
      return 'down-already-open';
    }
    const when = new Date().toISOString();
    log(`down; opening an issue${dryRun ? ' (dry run)' : ''}`);
    if (client) {
      await client.open(
        'Portal is down',
        `The heartbeat (scripts/heartbeat.mjs) got no healthy answer from ${url} twice in a row at ${when}: ${first.detail}, then ${last.detail}.\n\nThis issue closes itself when the portal answers again.`,
      );
    }
    return 'down-opened';
  }
  if (misses === 0 && open.length > 0) {
    log(`up; closing issue #${open[0].number}${dryRun ? ' (dry run)' : ''}`);
    if (client) {
      for (const i of open) {
        await client.comment(i.number, `The portal answers again (${first.detail}) at ${new Date().toISOString()}. Closing.`);
        await client.close(i.number);
      }
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
