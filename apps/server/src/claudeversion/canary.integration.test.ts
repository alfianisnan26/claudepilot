// The canary against the REAL Claude Code CLI (docs/prd/claude-version-pinning.md §13): a throwaway container from the workspace image, the in-container
// stand-in API, a fake login and no network. Every check passes on the installed version, and the failing path is shown with a version the image
// does not have. Runs on the Docker-in-Docker daemon with CLAUDEPILOT_DOCKER_TESTS=1, on `CLAUDEPILOT_CANARY_IMAGE` (default: the portal's default image,
// which must already be built: this test never builds). Run it for each Claude Code version before the pin moves.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { CLAUDE_CANARY_CHECKS } from '@portal/contracts';
import Docker from 'dockerode';
import { config } from '../config.js';
import { DockerRuntime } from '../workspaces/docker.js';
import { runCanary } from './canary/runner.js';

const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const IMAGE = process.env.CLAUDEPILOT_CANARY_IMAGE ?? config.workspaces.dockerImage;
const socket = '/var/run/docker.sock';
const docker = new Docker({ socketPath: socket });
const PREFIX = 'it-canary-';
const runtime = new DockerRuntime({ id: 'docker', label: 'Docker', socket }, IMAGE, config.workspaces.imageContext, () => 'it-portal', undefined, { canaryPrefix: PREFIX });
let version: string | null = null;
let skip: string | false = enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 to run against Docker';

before(async () => {
  if (!enabled) return;
  try {
    const info = await docker.getImage(IMAGE).inspect();
    version = info.Config?.Labels?.['claudepilot.claude-version'] ?? null;
    if (!version) skip = `${IMAGE} carries no claudepilot.claude-version label (an image from before the pin)`;
  } catch {
    skip = `the image ${IMAGE} is not built here (set CLAUDEPILOT_CANARY_IMAGE)`;
  }
});
after(async () => {
  if (!enabled) return;
  for (const l of await runtime.throwaway.leftovers().catch(() => [])) await runtime.throwaway.remove(l.name).catch(() => undefined);
});

test('the real canary on the installed image: every check passes, and the container is gone afterwards', { timeout: 400_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const out = await runCanary(runtime.throwaway, { version: version!, mode: 'image', image: IMAGE }, { note: () => undefined, results: () => undefined });
  assert.equal(out.status, 'done', out.note ?? '');
  assert.equal(out.reported, version);
  assert.deepEqual(out.results.map((r) => r.id), CLAUDE_CANARY_CHECKS.map((d) => d.id));
  for (const r of out.results) assert.equal(r.status, 'pass', `${r.id}: ${r.summary}\n${r.detail.slice(0, 600)}`);
  assert.deepEqual(await runtime.throwaway.leftovers(), []);
});

test('the failing path: a version the image does not have fails the version and stream checks, with the real output', { timeout: 400_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const out = await runCanary(runtime.throwaway, { version: '0.0.1', mode: 'image', image: IMAGE }, { note: () => undefined, results: () => undefined });
  assert.equal(out.status, 'done');
  const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.equal(by['version']!.status, 'fail');
  assert.match(by['version']!.summary, /It reports .* not the version under test, 0\.0\.1/);
  assert.match(by['version']!.detail, /Claude Code/, 'the real output is kept');
  assert.equal(by['stream-turn']!.status, 'fail');
  assert.equal(by['get-usage']!.status, 'pass', 'what does not depend on the version number still passes');
  assert.deepEqual(await runtime.throwaway.leftovers(), []);
});
