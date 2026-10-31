import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReporterAnchor, ReporterDeploymentState } from '@portal/contracts';
import { countBySeverity, cropBox, deploymentText, envStrip, pathnameOf, samePage } from './shared';
import { deployCurl, emptyRow, originError, siteErrors, siteOf, sitesValid, snippet, targetsValid } from './sites';

const row = (over: Partial<ReturnType<typeof emptyRow>> = {}) => ({ ...emptyRow(), origin: 'https://stg.konfersi.com', environment: 'stg', repo: 'platform/konfersi-landing-page', branch: 'stg', ...over });

test('a site origin is exactly an origin: no path, no wildcard, https unless localhost', () => {
  assert.equal(originError('https://stg.konfersi.com'), null);
  assert.equal(originError('http://localhost:5173'), null);
  assert.match(originError('https://stg.konfersi.com/')!, /Only the origin/);
  assert.match(originError('https://stg.konfersi.com/pricing')!, /Only the origin/);
  assert.ok(originError('https://*.konfersi.com'));
  assert.match(originError('http://stg.konfersi.com')!, /https/);
  assert.ok(originError('ftp://x.example'));
  assert.equal(originError(''), 'Required.');
});

test('sites: the same origin twice is refused; environment, repo and branch are checked', () => {
  assert.ok(sitesValid([row(), row({ origin: 'https://konfersi.com', environment: 'prod', branch: 'main' })]), 'two environments of one repo');
  const e = siteErrors([row(), row({ environment: 'STG ' })]);
  assert.match(e[1]!.origin!, /row 1/);
  assert.equal(siteErrors([row({ environment: 'Staging Env Long Name Here' })])[0]!.environment !== undefined, true);
  assert.ok(siteErrors([row({ repo: 'konfersi' })])[0]!.repo);
  assert.ok(siteErrors([row({ branch: 'has space' })])[0]!.branch);
  assert.deepEqual(siteOf(row({ environment: ' STG ', branch: ' ', label: '' })), {
    origin: 'https://stg.konfersi.com',
    environment: 'stg',
    repo: 'platform/konfersi-landing-page',
    branch: null,
    label: null,
  });
});

test('direct-report targets need a name and appear once', () => {
  assert.ok(targetsValid([{ sessionId: 's1', label: 'Lead' }]));
  assert.ok(!targetsValid([{ sessionId: 's1', label: ' ' }]));
  assert.ok(!targetsValid([{ sessionId: 's1', label: 'a' }, { sessionId: 's1', label: 'b' }]));
});

test('the script tag names the portal, bucket, repo, environment and branch, escaped', () => {
  const s = snippet('https://pilot.example', 'KONF', siteOf(row()));
  assert.match(s, /src="https:\/\/pilot\.example\/reporter\/v1\/reporter\.js"/);
  assert.match(s, /data-bucket="KONF"/);
  assert.match(s, /data-repo="platform\/konfersi-landing-page"/);
  assert.match(s, /data-env="stg"/);
  assert.match(s, /data-branch="stg"/);
  assert.doesNotMatch(snippet('https://p.example"><x', 'KONF', siteOf(row())), /"><x/);
});

test('the deploy hook posts repo, environment and the commit from the shell', () => {
  const c = deployCurl('https://pilot.example', siteOf(row()));
  assert.match(c, /^curl -fsS -X POST https:\/\/pilot\.example\/api\/reporter\/deployments /);
  assert.match(c, /\$PILOT_TOKEN/);
  assert.match(c, /"commit":"'"\$COMMIT"'"/);
  assert.match(c, /"environment":"stg"/);
});

const dep = (environment: string, status: ReporterDeploymentState['status'], reason: ReporterDeploymentState['reason'] = null): ReporterDeploymentState => ({
  environment,
  status,
  currentCommit: status === 'unknown' ? null : 'c'.repeat(40),
  seenAt: null,
  fixCommit: status === 'deployed' ? 'f'.repeat(40) : null,
  reason,
});

test('the environment strip and its words never claim more than the server proved', () => {
  const list = [dep('stg', 'deployed'), dep('uat', 'not-deployed'), dep('prod', 'unknown', 'no-build-seen')];
  assert.equal(envStrip(list), 'stg ✓ · uat – · prod ?');
  assert.equal(deploymentText(list[0]!), 'stg: deployed (fix fffffff) in ccccccc');
  assert.equal(deploymentText(list[1]!), 'uat: not deployed (live ccccccc)');
  assert.equal(deploymentText(list[2]!), 'prod: unknown, no build seen in this environment');
});

test('pages match on the path alone', () => {
  assert.equal(pathnameOf('/pricing?plan=pro#faq'), '/pricing');
  assert.equal(pathnameOf('https://stg.konfersi.com/about/'), '/about');
  assert.equal(pathnameOf('/'), '/');
  assert.ok(samePage('/pricing/', '/pricing?x=1'));
  assert.ok(!samePage('/pricing', '/pricing-old'));
});

test('UI check findings are counted by severity', () => {
  const f = (severity: 'critical' | 'minor') => ({ source: 'axe' as const, rule: 'r', severity, message: 'm', selector: null, help: null });
  assert.deepEqual(countBySeverity([f('critical'), f('minor'), f('minor')]), { critical: 1, serious: 0, moderate: 0, minor: 2 });
});

const anchor = (over: Partial<ReporterAnchor> = {}): ReporterAnchor => ({
  path: '/',
  selector: null,
  relative: null,
  rect: { x: 39, y: 1000, w: 195, h: 84.4 },
  viewport: { w: 390, h: 844, dpr: 2 },
  mode: 'crop',
  ...over,
});

test('the crop box on a screen shot is offset by the scroll at capture time', () => {
  // A phone Snap: 780x1688 (390x844 at 2x), scrolled to y=950.
  const b = cropBox({ w: 780, h: 1688 }, anchor(), { x: 0, y: 950 })!;
  assert.equal(Math.round(b.left), 10);
  assert.equal(Math.round(b.top), 6);
  assert.equal(Math.round(b.width), 50);
  assert.equal(Math.round(b.height), 10);
});

test('the crop box on a full-page shot uses document coordinates; none for a full report or a shot that is the crop', () => {
  const b = cropBox({ w: 390, h: 3000 }, anchor({ viewport: { w: 390, h: 844, dpr: 1 } }), { x: 0, y: 950 })!;
  assert.equal(Math.round(b.top), 33);
  assert.equal(cropBox({ w: 390, h: 3000 }, anchor({ mode: 'full' }), null), null);
  assert.equal(cropBox({ w: 390, h: 169 }, anchor(), null), null, 'the image has the crop’s aspect: it is the crop');
  assert.equal(cropBox({ w: 0, h: 0 }, anchor(), null), null);
});
