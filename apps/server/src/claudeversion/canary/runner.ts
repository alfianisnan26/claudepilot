// One canary run (docs/prd/claude-version-pinning.md §11): ONE throwaway container from an image, the stand-in API and a fake login in it, and the
// checks in order. The container is always removed afterwards. With `scratch` the candidate Claude Code is installed beside the image's own in a scratch
// folder (the only moment the container has a network), then cut off before any check runs.

import type { ClaudeCanaryMode, ClaudeCanaryResult } from '@portal/contracts';
import { CLAUDE_CANARY_CHECKS } from '@portal/contracts';
import { redact } from '../../chat/redact.js';
import type { ThrowawayAccess } from '../../workspaces/runtime.js';
import { BOX_DIR, CanaryBox, CheckFailed } from './box.js';
import { canaryChecks } from './checks.js';
import type { CanaryCheck, CheckContext } from './support.js';

/** The longest one check may take; a hung CLI never holds the canary longer. */
export const CHECK_LIMIT_MS = 240_000;
/** How much of a check's real output is kept. */
export const DETAIL_MAX = 4000;
const SCRATCH = `${BOX_DIR}/cc`;
const INSTALL_LIMIT_MS = 420_000;

export interface CanaryTarget {
  /** The exact version under test. */
  version: string;
  mode: ClaudeCanaryMode;
  /** The image the container is made from: the version's own (`image`), or the installed one (`scratch`). */
  image: string;
}

export interface CanaryHooks {
  /** What it is doing now (for the run's note while it runs). */
  note(text: string): void;
  /** The results so far, after each check. */
  results(results: ClaudeCanaryResult[], reported: string | null): void;
  /** True once someone asked to stop; checked between checks. */
  cancelled?(): boolean;
}

export interface CanaryOutcome {
  /** `done` when the checks ran (some may have failed); `error` when the container or the install failed before they could. */
  status: 'done' | 'error';
  note: string | null;
  reported: string | null;
  results: ClaudeCanaryResult[];
}

/** Redacted and clipped: the real output behind a result, safe to store and to show as text. */
export function clipDetail(text: string): string {
  const clean = redact(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  return clean.length > DETAIL_MAX ? `${clean.slice(0, DETAIL_MAX - 1)}…` : clean;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs one check, never throwing: an assertion that fails is a `fail`, anything else unexpected is a `fail` with its message. */
export async function runOne(check: CanaryCheck, ctx: CheckContext, limitMs = CHECK_LIMIT_MS): Promise<ClaudeCanaryResult> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      check.run(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckFailed(`The check took longer than ${Math.round(limitMs / 1000)} s.`)), limitMs);
        timer.unref();
      }),
    ]);
    return { id: check.def.id, status: outcome.status, durationMs: Date.now() - t0, summary: clipDetail(outcome.summary).slice(0, 300), detail: clipDetail(outcome.detail ?? '') };
  } catch (e) {
    const detail = e instanceof CheckFailed ? e.detail : '';
    return { id: check.def.id, status: 'fail', durationMs: Date.now() - t0, summary: clipDetail(messageOf(e)).slice(0, 300), detail: clipDetail(detail) };
  } finally {
    clearTimeout(timer);
    await ctx.box.killClaude().catch(() => undefined);
  }
}

/** The whole run. Always removes its container. */
export async function runCanary(t: ThrowawayAccess, target: CanaryTarget, hooks: CanaryHooks, checks: CanaryCheck[] = canaryChecks()): Promise<CanaryOutcome> {
  let name: string | null = null;
  const results: ClaudeCanaryResult[] = [];
  let reported: string | null = null;
  try {
    hooks.note('Starting the container');
    const started = await t.start({ image: target.image, network: target.mode === 'scratch' ? 'bridge' : 'none', cpus: 2, memoryMb: 2048 });
    name = started.name;
    let claude = 'claude';
    let binDir: string | null = null;
    if (target.mode === 'scratch') {
      hooks.note(`Installing Claude Code ${target.version} in a scratch folder`);
      const box0 = new CanaryBox(t, name, 'claude');
      const install = await t.run(
        name,
        `mkdir -p ${SCRATCH} && cd ${SCRATCH} && npm install --no-audit --no-fund --loglevel=error --no-package-lock --prefix ${SCRATCH} @anthropic-ai/claude-code@${target.version} 2>&1 | tail -15`,
        { user: 'node', timeoutMs: INSTALL_LIMIT_MS },
      );
      void box0;
      const bin = `${SCRATCH}/node_modules/.bin/claude`;
      const check = await t.run(name, `${bin} --version 2>&1 | head -1`, { user: 'node', timeoutMs: 60_000 });
      if (!new RegExp(`^${target.version.replace(/\./g, '\\.')} \\(Claude Code\\)`).test(check.stdout.trim())) {
        return { status: 'error', note: clipDetail(`Could not install Claude Code ${target.version}: ${install.stdout.trim() || check.stdout.trim() || install.stderr.trim()}`).slice(0, 600), reported: null, results: [] };
      }
      claude = bin;
      binDir = `${SCRATCH}/node_modules/.bin`;
      // Nothing after this point needs a network: the stand-in is on the loopback.
      await t.isolate(name);
    }
    const box = new CanaryBox(t, name, claude, binDir);
    hooks.note('Starting the stand-in API');
    await box.startStandIn();
    await box.fakeLogin();
    const ctx: CheckContext = { version: target.version, mode: target.mode, box, firstReported: { value: null }, shared: new Map() };
    for (const check of checks) {
      if (hooks.cancelled?.()) {
        results.push({ id: check.def.id, status: 'skipped', durationMs: 0, summary: 'Stopped before it ran.', detail: '' });
        continue;
      }
      hooks.note(`Running: ${check.def.label}`);
      const r = await runOne(check, ctx);
      results.push(r);
      if (check.def.id === 'version') reported = ctx.firstReported.value;
      hooks.results([...results], reported);
    }
    return { status: 'done', note: null, reported, results };
  } catch (e) {
    return { status: 'error', note: clipDetail(`The canary could not run: ${messageOf(e)}`).slice(0, 600), reported, results };
  } finally {
    if (name) await t.remove(name).catch(() => undefined);
  }
}

/** The definitions the page lists, in the order they run (the contracts' list plus anything registered). */
export const checkDefinitions = () => canaryChecks().map((c) => c.def);

/** The ids of the contracts' core list, for the test that keeps the runners and the definitions equal. */
export const coreCheckIds = () => CLAUDE_CANARY_CHECKS.map((d) => d.id);
