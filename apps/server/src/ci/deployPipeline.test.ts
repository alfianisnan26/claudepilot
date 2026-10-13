// The deploy pipeline of this repository (.pilot/deploy.yml and .pilot/scripts/*.sh) against a FAKE cluster and a FAKE GitHub, in a temporary
// folder: kubectl, gh and curl are scripts that record what they were asked and answer like the real ones; "GitHub" is a bare repository.
// Nothing here can reach a real cluster or remote: every step runs with a clean environment (no KUBECONFIG, a temporary HOME, the fakes
// first on PATH). The real scripts/k3s-build.sh runs against the fake kubectl. Then the whole pipeline runs through the CI service and the
// real runner, with the release held for an approval.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDirectory } from '../store/testTmp.js';
import { compile } from './spec/compile.js';
import { validatePipeline } from './spec/validate.js';
import { harness, WS } from './testkit.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '.');
/**
 * The tags the fake world's manifest starts from. The repository's real manifest changes with every release (and a real release on the day the tests
 * run makes its tag equal to the "next free tag" the fake registry gives), so the fake world gets a copy with these fixed tags instead.
 */
const FAKE_TAGS = { portal: '2026.01.01-1', workspace: '2.1.296-2026.01.01-1' } as const;
const manifestTag = (what: 'portal' | 'workspace') => FAKE_TAGS[what];
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What the fake world needs from this repository: the pipeline, its scripts, the manifests, the build script and the workspace Dockerfile. */
function templateFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (rel: string) => void (out[rel] = readFileSync(join(REPO, rel), 'utf8'));
  const walk = (rel: string) => {
    for (const name of readdirSync(join(REPO, rel))) {
      const r = `${rel}/${name}`;
      if (statSync(join(REPO, r)).isDirectory()) walk(r);
      else add(r);
    }
  };
  walk('.pilot');
  walk('deploy/k3s-build');
  add('deploy/k3s/portal.yaml');
  out['deploy/k3s/portal.yaml'] = out['deploy/k3s/portal.yaml']!
    .replace(/(claudepilot\/portal:)\S+/, (_m, head: string) => `${head}${FAKE_TAGS.portal}`)
    .replace(/(claudepilot\/workspace:)\S+/, (_m, head: string) => `${head}${FAKE_TAGS.workspace}`);
  add('scripts/k3s-build.sh');
  add('scripts/gate-job.sh');
  add('scripts/gate-verdict.sh');
  add('scripts/gate-job-stop.sh');
  add('images/workspace/Dockerfile');
  // The release gate itself (npm ci, the suite) is far too heavy here: a stand-in leaves the summary it would, green or red.
  out['scripts/gate.sh'] = `#!/usr/bin/env bash
sha=$(git rev-parse --short "\${1:-HEAD}"); dir=\${GATE_DIR:-/tmp/gate-$sha}; logs=$dir.logs
mkdir -p "$dir" "$logs"; mode=$(cat "$FAKE/gate-mode" 2>/dev/null || echo green)
for s in npm-ci typecheck web-build; do echo "$s rc=0 1s" >> "$logs/SUMMARY.txt"; : > "$logs/$s.log"; done
if [ "$mode" = red ]; then echo "server-suite rc=1 9s" >> "$logs/SUMMARY.txt"; printf 'not ok 7 - a test\\n# fail 1\\n' > "$logs/server-suite.log"
else echo "server-suite rc=0 9s" >> "$logs/SUMMARY.txt"; printf '# tests 3\\n# pass 3\\n# fail 0\\n' > "$logs/server-suite.log"; fi
echo "gate (stand-in) at $sha"
`;
  return out;
}

const FAKE_KUBECTL = `#!/usr/bin/env bash
# A stand-in for kubectl: records the call, answers from the fake GitHub's main.
printf 'kubectl %s\\n' "$*" >> "$FAKE/calls.log"
args=" $* "
manifest() { git --git-dir="$FAKE/github.git" show main:deploy/k3s/portal.yaml; }
case $args in
  # The in-cluster gate (scripts/gate-job.sh): its Job succeeds or fails with the fake gate's mode, and its log ends with the verdict.
  *" get job claudepilot-gate-"*"metadata.uid"*) printf 'uid-1234' ;;
  *" get jobs,secrets -l app=claudepilot-gate,claudepilot-gate/by=pipeline "*) [ -f "$FAKE/leftover" ] && { printf 'job.batch/claudepilot-gate-aaaaaaa-0000\nsecret/claudepilot-gate-aaaaaaa-0000\n'; rm -f "$FAKE/leftover"; }; true ;;
  *" get job claudepilot-gate-"*) if [ "$(cat "$FAKE/gate-mode" 2>/dev/null)" = red ]; then printf '/1'; else printf '1/'; fi ;;
  *" logs job/claudepilot-gate-"*)
    printf '=== SUMMARY\nnpm-ci rc=0 1s\n'; [ -f "$FAKE/leak" ] && echo "npm: $(cat "$FAKE/token")"
    if [ "$(cat "$FAKE/gate-mode" 2>/dev/null)" = red ]; then echo 'GATE-VERDICT: red: typecheck failed'; else echo 'GATE-VERDICT: green'; fi ;;
  *" get application "*)
    health=Healthy
    if [ -f "$FAKE/bad-tag" ] && manifest | grep -qF "portal:$(cat "$FAKE/bad-tag")"; then health=Degraded; fi
    printf '%s Synced %s' "$(git --git-dir="$FAKE/github.git" rev-parse main)" "$health" ;;
  *" rollout status "*) echo 'deployment "claudepilot-portal" successfully rolled out' ;;
  *" get deploy/"*) manifest | grep -oE 'image: [^ ]*claudepilot/portal:[^ ]*' | sed 's/^image: //' ;;
  *" logs deploy/"*) cat "$FAKE/portal.log" 2>/dev/null || echo '[store] ready (portal 1234abcd, schema 610)' ;;
  *" get pods "*) printf '0 ' ;;
  *" get job "*) if [ -f "$FAKE/build-fails" ]; then printf '/1'; else printf '1/'; fi ;;
  *" logs job/"*) echo "kaniko: pushing"; [ -f "$FAKE/leak" ] && echo "auth: $(cat "$FAKE/token")"; true ;;
  *" apply -f -"*) cat > "$FAKE/applied.yaml" ;;
  *) ;;
esac
`;

const FAKE_GH = `#!/usr/bin/env bash
printf 'gh %s\\n' "$1 $2" >> "$FAKE/calls.log"
[ "$1 $2" = "auth token" ] && cat "$FAKE/token"
`;

const FAKE_CURL = `#!/usr/bin/env bash
# A stand-in for curl: the registry's tag list, and the portal's answers for the smoke test.
printf 'curl %s\\n' "$*" >> "$FAKE/calls.log"
url=\${*: -1}
case $url in
  */tags/list) printf '{"name":"x","tags":%s}' "$(cat "$FAKE/tags.json" 2>/dev/null || echo '[]')" ;;
  *) if [[ " $* " == *" -w "* ]]; then if [ -f "$FAKE/unhealthy" ]; then printf 503; else printf 200; fi; fi ;;
esac
`;

interface World {
  root: string;
  github: string;
  work: string;
  env: NodeJS.ProcessEnv;
  token: string;
  /** The run's commit: integration's head. */
  sha: string;
  base: string;
  git(args: string[], cwd?: string): string;
  run(script: string, inputs?: Record<string, string>): { code: number; out: string };
  calls(): string;
  main(): string;
  branch(name: string): string;
  manifestAt(ref: string): string;
}

function shell(file: string, text: string) {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

/** The fakes, a fake GitHub (main, and integration one commit ahead) and a checkout of integration's head like the runner makes. */
function world(): World {
  const root = tempDirectory('cp-deploy-');
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  shell(join(bin, 'kubectl'), FAKE_KUBECTL);
  shell(join(bin, 'gh'), FAKE_GH);
  shell(join(bin, 'curl'), FAKE_CURL);
  // Built at run time: a value shaped like nothing a scanner knows, for the mask to find.
  const token = `canary${randomBytes(12).toString('hex')}`;
  writeFileSync(join(root, 'token'), token);
  writeFileSync(join(root, 'tags.json'), JSON.stringify([`${today()}-1`, '2026.01.01-9', `2.1.296-${today()}-4`]));
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    TMPDIR: root,
    FAKE: root,
    DEPLOY_GIT_REMOTE: join(root, 'github.git'),
    DEPLOY_URL: 'http://portal.test:3000',
    DEPLOY_WAIT_S: '2',
    DEPLOY_POLL_S: '1',
    // The gate here, with the stand-in gate.sh; the in-cluster path (the default) has a test of its own.
    DEPLOY_GATE_IN_CLUSTER: 'false',
  };
  const git = (args: string[], cwd = root) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const github = join(root, 'github.git');
  git(['init', '-q', '--bare', github]);
  const src = join(root, 'src');
  mkdirSync(src);
  git(['init', '-q'], src);
  for (const [path, text] of Object.entries(templateFiles())) {
    mkdirSync(dirname(join(src, path)), { recursive: true });
    writeFileSync(join(src, path), text);
  }
  git(['add', '-A'], src);
  git(['commit', '-q', '-m', 'base'], src);
  const base = git(['rev-parse', 'HEAD'], src);
  git(['push', '-q', github, 'HEAD:refs/heads/main'], src);
  writeFileSync(join(src, 'feature.txt'), 'new\n');
  git(['add', '-A'], src);
  git(['commit', '-q', '-m', 'a feature'], src);
  const sha = git(['rev-parse', 'HEAD'], src);
  git(['push', '-q', github, 'HEAD:refs/heads/integration'], src);
  // The runner's checkout: a clone of the workspace's own remote (here: src), detached at the commit.
  const work = join(root, 'work');
  git(['clone', '-q', '--no-checkout', src, work]);
  git(['checkout', '-q', '--detach', sha], work);
  const runEnv = (inputs: Record<string, string>) => ({
    ...env,
    PILOT_SHA: sha,
    PILOT_BRANCH: 'integration',
    PILOT_RUN_ID: 'rtestdeploy01',
    PILOT_RUN_NUMBER: '7',
    PILOT_INPUT_IMAGES: 'portal',
    PILOT_INPUT_GATE: 'true',
    PILOT_INPUT_DEPLOY: 'true',
    PILOT_INPUT_DRY_RUN: 'false',
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`PILOT_INPUT_${k.toUpperCase()}`, v])),
  });
  return {
    root,
    github,
    work,
    env,
    token,
    sha,
    base,
    git,
    run(script, inputs = {}) {
      const r = spawnSync('bash', [`.pilot/scripts/${script}.sh`], { cwd: work, env: runEnv(inputs), encoding: 'utf8', timeout: 60_000 });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    },
    calls: () => (existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8') : ''),
    main: () => git(['--git-dir', github, 'rev-parse', 'main']),
    branch: (name) => git(['--git-dir', github, 'rev-parse', name]),
    manifestAt: (ref) => git(['--git-dir', github, 'show', `${ref}:deploy/k3s/portal.yaml`]),
  };
}

/** What a job leaves for the jobs that need it (the runner copies artifacts into their checkouts; here they share one). */
const outFile = (w: World, name: string) => readFileSync(join(w.work, '.pilot/out', name), 'utf8');
const MUTATING = /^kubectl .*\b(annotate|apply|create|delete|patch|scale|rollout (restart|undo))\b/m;

test('the pipeline file: manual only, the release deploys to production, rollback only on failure; it compiles with its defaults', () => {
  const v = validatePipeline('.pilot/deploy.yml', readFileSync(join(REPO, '.pilot/deploy.yml'), 'utf8'));
  assert.deepEqual(v.info.diagnostics, []);
  assert.deepEqual(v.info.triggers, ['manual'], 'no push, merge or schedule: a deploy is always asked for');
  assert.deepEqual(v.info.inputs.map((i) => [i.name, i.type, i.default]), [['images', 'string', 'portal'], ['gate', 'boolean', true], ['deploy', 'boolean', true], ['dry_run', 'boolean', false]]);
  const c = compile(v.pipeline!, { event: 'manual', ref: 'refs/heads/integration', sha: 'a'.repeat(40), base: null, actor: 'session:s1', repo: 'claudepilot', ticket: null, inputs: { images: 'portal', gate: true, deploy: true, dry_run: false }, workspace: 'kubernetes/kohi-event', runId: 'rabc123', runNumber: 1 }, { maxParallel: 2 });
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.deepEqual(c.plan.jobs.map((j) => [j.id, j.needs, j.when, j.skip, j.environment ?? null]), [
    ['gate', [], 'success', null, null],
    ['build', ['gate'], 'success', null, null],
    ['release', ['build'], 'success', null, 'production'],
    ['verify', ['release'], 'success', null, null],
    ['rollback', ['release', 'verify'], 'failure', null, null],
  ]);
  assert.equal(c.group, 'deploy-claudepilot', 'one deploy at a time');
  assert.ok(c.plan.jobs.every((j) => j.steps.every((s) => /^bash \.pilot\/scripts\/[a-z]+\.sh$/.test(s.run))), 'the logic is in the scripts');
  const buildOnly = compile(v.pipeline!, { event: 'manual', ref: 'refs/heads/integration', sha: 'a'.repeat(40), base: null, actor: 'ui', repo: 'claudepilot', ticket: null, inputs: { images: 'portal', gate: true, deploy: false, dry_run: false }, workspace: 'x/y', runId: 'rabc124', runNumber: 2 }, { maxParallel: 2 });
  assert.ok(buildOnly.ok && buildOnly.plan.jobs.find((j) => j.id === 'release')!.skip === 'condition', 'deploy=false leaves the release out');
});

test('the scripts pass shellcheck (when it is installed: the dev image has it)', (t) => {
  const which = spawnSync('sh', ['-c', 'command -v shellcheck'], { encoding: 'utf8' });
  if (which.status !== 0) return t.skip('shellcheck is not installed here');
  const files = readdirSync(join(REPO, '.pilot/scripts')).filter((f) => f.endsWith('.sh')).map((f) => relative(REPO, join(REPO, '.pilot/scripts', f)));
  const r = spawnSync('shellcheck', ['-x', '-P', 'SCRIPTDIR', ...files], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a dry run says what each job would do and changes nothing: no push, no cluster change', () => {
  const w = world();
  const dry = { dry_run: 'true', images: 'portal,workspace' };
  assert.equal(spawnSync('sh', ['-c', 'command -v kubectl'], { env: w.env, encoding: 'utf8' }).stdout.trim(), join(w.root, 'bin/kubectl'), 'the fake comes first');
  const gate = w.run('gate', dry);
  assert.equal(gate.code, 0, gate.out);
  assert.match(gate.out, /\[dry-run\] would run: scripts\/gate\.sh [0-9a-f]{7}/);
  const build = w.run('build', dry);
  assert.equal(build.code, 0, build.out);
  assert.match(build.out, new RegExp(`would run: BUILD_BRANCH=integration scripts/k3s-build.sh portal ${today().replace(/\./g, '\\.')}-2 ${w.sha}`), 'the next free tag of today');
  assert.match(build.out, new RegExp(`scripts/k3s-build.sh workspace 2\\.1\\.296-${today().replace(/\./g, '\\.')}-5 `));
  assert.equal(outFile(w, 'build.env'), `PORTAL_TAG=${today()}-2\nWORKSPACE_TAG=2.1.296-${today()}-5\n`);
  const release = w.run('release', dry);
  assert.equal(release.code, 0, release.out);
  assert.match(release.out, /\[dry-run\] would run: git push -q origin [0-9a-f]{40}:refs\/heads\/main\n/);
  assert.match(release.out, /\[dry-run\] would run: git push -q origin [0-9a-f]{40}:refs\/heads\/integration\n/, 'the branch follows as its own step');
  assert.match(outFile(w, 'release.env'), /PUSHED=0/);
  const verify = w.run('verify', dry);
  assert.equal(verify.code, 0, verify.out);
  assert.match(verify.out, /would wait for Argo CD/);
  const rollback = w.run('rollback', dry);
  assert.equal(rollback.code, 0, rollback.out);
  assert.match(rollback.out, /nothing to roll back/);

  assert.deepEqual([w.main(), w.branch('integration')], [w.base, w.sha], 'GitHub is untouched');
  assert.doesNotMatch(w.calls(), MUTATING, 'only reads reached the cluster');
  assert.ok(!existsSync(join(w.root, 'applied.yaml')));
});

test('a release: gate verdict, the real k3s-build.sh on a fake cluster, the bump on main and integration in one push, verify', () => {
  const w = world();
  assert.equal(w.run('gate').code, 0);
  const build = w.run('build', { images: 'portal' });
  assert.equal(build.code, 0, build.out);
  assert.match(build.out, /building portal:\S+ from [0-9a-f]{40}/, 'k3s-build.sh ran');
  assert.match(build.out, /token in the build log: none/);
  assert.ok(!build.out.includes(w.token), 'the token is never printed');
  assert.match(readFileSync(join(w.root, 'applied.yaml'), 'utf8'), new RegExp(`claudepilot/portal:${today().replace(/\./g, '\\.')}-2`), 'the job built the new tag');
  assert.match(readFileSync(join(w.root, 'applied.yaml'), 'utf8'), new RegExp(`#refs/heads/integration#${w.sha}`), 'from the run\'s commit on integration');
  assert.match(w.calls(), /kubectl -n isnan-claudepilot delete secret claudepilot-build/, 'the build secret is removed again');

  const release = w.run('release');
  assert.equal(release.code, 0, release.out);
  const bump = w.main();
  assert.notEqual(bump, w.base);
  assert.equal(w.branch('integration'), bump, 'main and integration move together');
  assert.equal(w.git(['--git-dir', w.github, 'rev-parse', `${bump}^`]), w.sha, 'the bump sits on the run\'s commit');
  assert.match(w.manifestAt('main'), new RegExp(`image: registry\\.int\\.isnan\\.me/claudepilot/portal:${today().replace(/\./g, '\\.')}-2\\n`));
  assert.match(w.manifestAt('main'), new RegExp(`value: registry\\.int\\.isnan\\.me/claudepilot/workspace:${esc(manifestTag('workspace'))}\\n`), 'an image not built keeps its tag');
  const diff = w.git(['--git-dir', w.github, 'diff', '--stat', `${bump}^`, bump]);
  assert.match(diff, /1 file changed, 1 insertion\(\+\), 1 deletion\(-\)/, 'exactly one line changed');
  assert.match(w.git(['--git-dir', w.github, 'log', '-1', '--format=%B', bump]), /^deploy: portal \S+\n\nReleased by the deploy pipeline: pilot CI run #7 .*\n\nPilot-Run: rtestdeploy01/);
  assert.match(outFile(w, 'release.env'), new RegExp(`PREV_PORTAL=${esc(manifestTag('portal'))}\\nPREV_WORKSPACE=${esc(manifestTag('workspace'))}\\nNEW_PORTAL=${today().replace(/\./g, '\\.')}-2\\nNEW_WORKSPACE=\\nBUMP_SHA=${bump}\\nBASE_SHA=${w.sha}\\nPUSHED=1\\n`));

  const verify = w.run('verify');
  assert.equal(verify.code, 0, verify.out);
  assert.match(verify.out, /\/healthz 200\n\/login 200/);
  assert.match(verify.out, /verify: live and well at [0-9a-f]{7}/);
  assert.match(w.calls(), /kubectl -n isnan-argocd annotate application isnan-claudepilot argocd\.argoproj\.io\/refresh=hard --overwrite/);
  assert.match(w.calls(), /curl -s -o \/dev\/null -w %\{http_code\} --max-time 10 http:\/\/portal\.test:3000\/healthz/);
});

test('a verify that fails rolls back: the previous tags on main (and integration), then Argo CD, rollout and /healthz again', () => {
  const w = world();
  w.run('gate');
  assert.equal(w.run('build').code, 0);
  assert.equal(w.run('release').code, 0);
  const bump = w.main();
  writeFileSync(join(w.root, 'bad-tag'), `${today()}-2`);
  const verify = w.run('verify');
  assert.equal(verify.code, 1);
  assert.match(verify.out, /Degraded/);
  assert.match(verify.out, /ERROR: Argo CD is not Synced and Healthy at [0-9a-f]{7}/);

  const rollback = w.run('rollback');
  assert.equal(rollback.code, 0, rollback.out);
  const back = w.main();
  assert.equal(w.git(['--git-dir', w.github, 'rev-parse', `${back}^`]), bump, 'a new commit on top: nothing forced');
  assert.equal(w.branch('integration'), back);
  assert.match(w.manifestAt('main'), new RegExp(`claudepilot/portal:${esc(manifestTag('portal'))}\\n`), 'the tag from before');
  assert.match(rollback.out, new RegExp(`rollback: back at portal ${esc(manifestTag('portal'))}`));

  // A portal whose log has a fatal line fails verify too (here on the cluster as it is: nothing released in this pretend run).
  writeFileSync(join(w.work, '.pilot/out/release.env'), 'PUSHED=0\n');
  assert.equal(w.run('verify').code, 0);
  writeFileSync(join(w.root, 'portal.log'), 'ok\n[store] LOCKED: The secret key is not loaded.\nTypeError: x is not a function\n');
  const again = w.run('verify');
  assert.equal(again.code, 1);
  assert.match(again.out, /fatal lines/);
});

test('a branch that moved on during the approval: main gets exactly the approved commit and the tags, the branch gets the release merged in (run #4, 2026-10-13)', () => {
  const w = world();
  assert.equal(w.run('build', { images: 'portal' }).code, 0);
  // A status commit pushed to integration while the release waited for its approval.
  const other = join(w.root, 'other');
  w.git(['clone', '-q', w.github, other]);
  w.git(['checkout', '-q', 'integration'], other);
  writeFileSync(join(other, 'status.md'), 'status\n');
  w.git(['add', '-A'], other);
  w.git(['commit', '-q', '-m', 'status while waiting'], other);
  w.git(['push', '-q', 'origin', 'integration'], other);
  const tip = w.branch('integration');
  const release = w.run('release');
  assert.equal(release.code, 0, release.out);
  assert.match(release.out, /integration moved on to [0-9a-f]{7} since this run started: the release is merged into it/);
  const bump = w.main();
  assert.equal(w.git(['--git-dir', w.github, 'rev-parse', `${bump}^`]), w.sha, 'main: the bump on the approved commit, nothing else');
  assert.ok(!w.git(['--git-dir', w.github, 'ls-tree', '--name-only', bump]).split('\n').includes('status.md'), 'the later commit is not deployed');
  const merged = w.branch('integration');
  assert.deepEqual(w.git(['--git-dir', w.github, 'rev-list', '--parents', '-n', '1', merged]).split(' ').slice(1), [tip, bump], 'integration: its own tip and the release, merged');
  assert.match(w.manifestAt('integration'), new RegExp(`claudepilot/portal:${today().replace(/\./g, '\\.')}-2\n`), 'integration has the new tags too');
  assert.match(outFile(w, 'release.env'), /PUSHED=1/);
  assert.match(outFile(w, 'release.env'), new RegExp(`BRANCH_SHA=${merged}`));
});

test('T-95: the deploy is the push to main alone; integration catches up as its own step, retried when it moves during the push, and a branch that will not take it only warns', () => {
  const w = world();
  assert.equal(w.run('build', { images: 'portal' }).code, 0);
  // GitHub refuses pushes to integration while refuse-integration holds a count above 0 ("always": every one), as if it moved each time.
  const hook = join(w.github, 'hooks', 'pre-receive');
  shell(hook, `#!/bin/sh
while read old new ref; do
  [ "$ref" = refs/heads/integration ] || continue
  f="$FAKE/refuse-integration"; [ -f "$f" ] || continue
  n=$(cat "$f"); [ "$n" = always ] && { echo "integration moved" >&2; exit 1; }
  [ "$n" -gt 0 ] 2>/dev/null && { echo $((n - 1)) > "$f"; echo "integration moved" >&2; exit 1; }
done
exit 0
`);
  writeFileSync(join(w.root, 'refuse-integration'), '1');
  const once = w.run('release');
  assert.equal(once.code, 0, once.out);
  assert.match(once.out, /integration moved during the push \(try 1 of 3\)/);
  const bump = w.main();
  assert.equal(w.git(['--git-dir', w.github, 'rev-parse', `${bump}^`]), w.sha, 'main: the approved commit plus the tags');
  assert.equal(w.branch('integration'), bump, 'the second try brought integration up');
  assert.match(outFile(w, 'release.env'), /PUSHED=1/);

  // A branch that never takes it: the deploy stands (no failure, so no rollback), and the run says to merge by hand.
  const w2 = world();
  assert.equal(w2.run('build', { images: 'portal' }).code, 0);
  shell(join(w2.github, 'hooks', 'pre-receive'), readFileSync(hook, 'utf8'));
  writeFileSync(join(w2.root, 'refuse-integration'), 'always');
  const never = w2.run('release');
  assert.equal(never.code, 0, never.out);
  assert.match(never.out, /WARNING: integration was not brought up to date: merge main into it by hand \(the deploy is done\)/);
  assert.notEqual(w2.main(), w2.base, 'main was released');
  assert.equal(w2.branch('integration'), w2.sha, 'integration as it was');
  assert.match(outFile(w2, 'release.env'), /PUSHED=1/);
  assert.match(outFile(w2, 'release.env'), /BRANCH_SYNC=failed/);
});

test('the gate as a Job in the cluster (T-37, the default): a Secret for its life, a Job with small requests and no node selector, the verdict from its log', () => {
  const w = world();
  Object.assign(w.env, { DEPLOY_GATE_IN_CLUSTER: 'true', GATE_IMAGE: 'registry.test/claudepilot/workspace:dev-1', GATE_JOB_POLL_S: '1', GATE_JOB_WAIT_S: '5' });
  const dry = w.run('gate', { dry_run: 'true' });
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /\[dry-run\] would run: scripts\/gate-job\.sh [0-9a-f]{7}/);
  assert.ok(!existsSync(join(w.root, 'applied.yaml')), 'a dry run applies nothing');

  writeFileSync(join(w.root, 'leftover'), ''); // a cancelled run's Job and its Secret
  const green = w.run('gate');
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, /gate: leftover stopped claudepilot-gate-aaaaaaa-0000/);
  assert.match(green.out, new RegExp(`gate job claudepilot-gate-${w.sha.slice(0, 7)}-[0-9a-f]{4}: typecheck,web-build,server-suite at ${w.sha.slice(0, 7)} on registry\\.test/claudepilot/workspace:dev-1`));
  assert.match(green.out, /GATE-VERDICT: green/);
  assert.match(green.out, /gate: green at [0-9a-f]{7}/);
  const job = readFileSync(join(w.root, 'applied.yaml'), 'utf8');
  assert.match(job, new RegExp(`value: "${w.sha}"`));
  assert.match(job, /image: registry\.test\/claudepilot\/workspace:dev-1/);
  assert.match(job, /requests: \{cpu: 100m/);
  assert.match(job, /GATE_VERDICT_SH, value: "[A-Za-z0-9+/=]{100,}"/, 'the caller’s verdict script travels with the Job');
  assert.doesNotMatch(job, /nodeSelector/);
  assert.ok(!job.includes(w.token), 'the token is in the Secret, never the Job');
  const calls = w.calls();
  assert.match(calls, /kubectl -n isnan-claudepilot create secret generic claudepilot-gate-/);
  assert.match(calls, /kubectl -n isnan-claudepilot delete secret claudepilot-gate-/, 'the Secret is deleted on exit');
  assert.match(calls, /delete job claudepilot-gate-aaaaaaa-0000/, 'a leftover of a cancelled run is stopped at the start');
  assert.match(calls, /patch secret claudepilot-gate-[0-9a-f]{7}-[0-9a-f]{4} --type merge -p \{"metadata":\{"ownerReferences":\[\{"apiVersion":"batch\/v1","kind":"Job","name":"claudepilot-gate-[0-9a-f-]+","uid":"uid-1234"\}\]/, 'the Secret belongs to its Job');
  assert.equal((calls.match(/get jobs,secrets -l app=claudepilot-gate,claudepilot-gate\/by=pipeline/g) ?? []).length, 2, 'leftovers cleared at the start, ours at the end');
  assert.match(job, /claudepilot-gate\/by: pipeline/);

  writeFileSync(join(w.root, 'gate-mode'), 'red');
  writeFileSync(join(w.root, 'leak'), '');
  const red = w.run('gate');
  assert.equal(red.code, 1);
  assert.match(red.out, /GATE-VERDICT: red: typecheck failed/);
  assert.match(red.out, /gate: red at [0-9a-f]{7}/);
  assert.ok(!red.out.includes(w.token), 'a token in the job log never reaches the run log');
});

test('refusals: a red gate, a branch that moved, a main with other commits, an unknown image; a refused release changes nothing', () => {
  const w = world();
  writeFileSync(join(w.root, 'gate-mode'), 'red');
  const gate = w.run('gate');
  assert.equal(gate.code, 1);
  assert.match(gate.out, /gate: server-suite failed/);
  assert.equal(w.run('gate', { gate: 'false' }).code, 0, 'gate=false skips it');

  const bogus = w.run('build', { images: 'portal,bogus' });
  assert.equal(bogus.code, 1);
  assert.match(bogus.out, /unknown image "bogus"/);
  assert.equal(w.run('build').code, 0);

  // Someone rewrote integration after the run started (the run's commit is gone from it): refused, nothing changes.
  const other = join(w.root, 'other');
  w.git(['clone', '-q', w.github, other]);
  w.git(['checkout', '-q', 'integration'], other);
  w.git(['reset', '-q', '--hard', 'HEAD~1'], other);
  writeFileSync(join(other, 'late.txt'), 'late\n');
  w.git(['add', '-A'], other);
  w.git(['commit', '-q', '-m', 'rewritten'], other);
  w.git(['push', '-q', '--force', 'origin', 'integration'], other);
  const moved = w.run('release');
  assert.equal(moved.code, 1);
  assert.match(moved.out, /no longer has [0-9a-f]{7}/);
  assert.equal(w.main(), w.base, 'main did not move');
  assert.match(outFile(w, 'release.env'), /PUSHED=0/);
  assert.match(w.run('rollback').out, /nothing to roll back/);
  w.git(['--git-dir', w.github, 'update-ref', 'refs/heads/integration', w.sha]); // put integration back for the cases below

  // main has a commit the run's commit lacks: refused before anything is made.
  w.git(['checkout', '-q', 'main'], other);
  writeFileSync(join(other, 'hotfix.txt'), 'x\n');
  w.git(['add', '-A'], other);
  w.git(['commit', '-q', '-m', 'hotfix'], other);
  w.git(['push', '-q', 'origin', 'main'], other);
  const behind = w.run('release');
  assert.equal(behind.code, 1);
  assert.match(behind.out, /main has commits that [0-9a-f]{7} does not/);

  // A failing build prints the end of its log; the token in it is masked.
  writeFileSync(join(w.root, 'build-fails'), '');
  writeFileSync(join(w.root, 'leak'), '');
  const failed = w.run('build');
  assert.equal(failed.code, 1);
  assert.match(failed.out, /BUILD FAILED/);
  assert.match(failed.out, /auth: \[redacted\]/);
  assert.ok(!failed.out.includes(w.token), 'never the token');
});

test('the whole pipeline through the CI service and the real runner: gate, build, held for a person, approved, released, verified', async () => {
  const h = await harness();
  const fake = world();
  try {
    // The workspace: the fakes on PATH, the cluster's names pointed at the fakes in ~/.profile (the steps' login shell reads it).
    // PATH goes in ~/.profile too: /etc/profile resets PATH in a login shell, and a real kubectl on this machine would otherwise win.
    const fakePath = `${join(fake.root, 'bin')}:/usr/local/bin:/usr/bin:/bin`;
    h.home.extraEnv.PATH = fakePath;
    writeFileSync(join(h.home.home, '.profile'), Object.entries({ PATH: fakePath, FAKE: fake.root, DEPLOY_GIT_REMOTE: fake.github, DEPLOY_URL: 'http://portal.test:3000', DEPLOY_WAIT_S: '5', DEPLOY_POLL_S: '1', DEPLOY_GATE_IN_CLUSTER: 'false' }).map(([k, v]) => `export ${k}='${v}'\n`).join(''));
    // The development repository: integration as on GitHub, pushed to its pilot remote.
    h.home.git(['fetch', '-q', fake.github, 'integration:integration'], h.src);
    h.home.git(['checkout', '-q', 'integration'], h.src);
    const repo = await h.svc.createRepo({ workspaceId: WS, name: 'claudepilot', source: h.src, connect: true });
    await h.svc.poll(WS);

    const run = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'integration', inputs: { images: 'portal' } }, 'session:s1', { sessionId: 's1', deploymentOnly: 'deployment pipelines only' });
    assert.equal(run.sha, fake.sha);
    assert.deepEqual(run.deployments.map((d) => [d.job, d.environment, d.approval]), [['release', 'production', 'pending']]);
    await h.until('the release to wait for a person', () => h.svc.get(run.id).deployments[0]!.approval === 'waiting', 120_000).catch(async (e: Error) => {
      // A wait that ran out says what the run did instead: the jobs' statuses and the tail of every failed step's log.
      const r = h.svc.get(run.id);
      const tails: string[] = [];
      for (const j of r.detail) for (const st of j.steps) if (st.status === 'failed') tails.push(`--- ${j.id} / ${st.name}:\n${(await h.svc.log(run.id, j.id, st.idx, 0)).text.slice(-2000)}`);
      throw new Error(`${e.message}; the run is ${r.status} (${r.reason ?? ''}): ${JSON.stringify(r.detail.map((j) => [j.id, j.status, j.reason]))}\n${tails.join('\n')}`);
    });
    const held = h.svc.get(run.id);
    assert.deepEqual(held.detail.map((j) => [j.id, j.status]), [['gate', 'passed'], ['build', 'passed'], ['release', 'waiting'], ['verify', 'pending'], ['rollback', 'pending']]);
    assert.equal(fake.main(), fake.base, 'nothing is released before the approval');

    await h.svc.decide(run.id, 'release', 'approve', { actor: 'user:u_owner', userId: 'u_owner' });
    await h.until('the run to finish', () => !['queued', 'running'].includes(h.svc.get(run.id).status), 120_000);
    const done = h.svc.get(run.id);
    assert.equal(done.status, 'passed', JSON.stringify(done.detail.map((j) => [j.id, j.status, j.reason])));
    assert.deepEqual(done.detail.map((j) => [j.id, j.status]), [['gate', 'passed'], ['build', 'passed'], ['release', 'passed'], ['verify', 'passed'], ['rollback', 'skipped']]);
    assert.notEqual(fake.main(), fake.base);
    assert.equal(fake.branch('integration'), fake.main());
    assert.match(fake.manifestAt('main'), new RegExp(`claudepilot/portal:${today().replace(/\./g, '\\.')}-2\\n`));
    const buildLog = (await h.svc.log(run.id, 'build', 0, 0)).text;
    assert.match(buildLog, /token in the build log: none/);
    assert.ok(!buildLog.includes(fake.token));
    assert.match((await h.svc.log(run.id, 'verify', 0, 0)).text, /verify: live and well/);
    assert.deepEqual(done.deployments.map((d) => [d.approval, d.outcome, d.decidedBy]), [['approved', 'passed', 'user:u_owner']]);
  } finally {
    h.done();
  }
});
