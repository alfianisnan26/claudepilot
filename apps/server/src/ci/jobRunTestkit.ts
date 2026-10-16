// The Job's two containers of deploy/k3s-build/job-run.yaml (T-401), run here in turn on one scratch /tmp (JR_ROOT): `fetch`, the only
// one given the credentials, then `run`, given none. Test helper only; nothing here reaches a cluster.

import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The text between two marker comments of a template's container script, without the YAML block indent. */
export function scriptPart(template: string, begin: string, end: string): string {
  const tpl = readFileSync(template, 'utf8');
  const a = tpl.indexOf(begin), b = tpl.indexOf(end);
  assert.ok(a >= 0 && b > a, `${template}: the markers ${begin} and ${end}`);
  return tpl.slice(a, b).replace(/^ {14}/gm, '');
}

/**
 * The fetch part with `env` plus `creds`, then the run part with `env` alone (as the manifest gives them). JR_ROOT must be set;
 * JR_FETCH_HOME defaults to a folder next to it (the fetch container's own HOME volume). Returns the run part's result, which prints the
 * fetch part's log first, as the run container does.
 */
export function runPod(template: string, env: NodeJS.ProcessEnv, creds: Record<string, string> = {}): SpawnSyncReturns<string> {
  assert.ok(env.JR_ROOT, 'JR_ROOT');
  const fetchEnv = { JR_FETCH_HOME: `${env.JR_ROOT}-fetch-home`, ...env, ...creds };
  const f = spawnSync('bash', ['-c', scriptPart(template, '# JOB-RUN-FETCH BEGIN', '# JOB-RUN-FETCH END')], { encoding: 'utf8', env: fetchEnv });
  assert.equal(f.status, 0, `the fetch container always ends 0 (its code is in fetch.rc): ${f.stdout}${f.stderr}`);
  return spawnSync('bash', ['-c', scriptPart(template, '# JOB-RUN-SCRIPT BEGIN', '# JOB-RUN-SCRIPT END')], { encoding: 'utf8', env });
}
