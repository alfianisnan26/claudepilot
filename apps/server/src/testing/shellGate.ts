// The shell-test gate (KONF-3073 follow-up, owner 2026-11-21). A test that spawns a shell or a host command, or plants a binary on PATH
// (the connect agent, cp-ci, cp-session, the local workspace, the real tunnel, host scripts), runs only in CI: when CI is set (the
// in-cluster gate and job-run set CI=true) or RUN_SHELL_TESTS=1. Anywhere else (a developer's laptop) it is skipped with the reason
// below. Endpoint security on the owner's Mac flagged such a probe on 2026-11-21.
//
// Use: import { test, describe, it, before, after, beforeEach, afterEach } from '<relative>/testing/shellGate.js' in place of
// 'node:test' in a file whose tests spawn. With the gate closed, every test and suite is registered as skipped and the hooks do nothing,
// so no fixture that would spawn is ever set up. With it open, these are node:test's own functions.

import * as nodeTest from 'node:test';

export const SHELL_TESTS_SKIP_REASON = 'spawns shells; runs in CI';

/** CI set to anything but empty, 0 or false; or RUN_SHELL_TESTS=1. */
export function shellTestsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = (env.CI ?? '').trim().toLowerCase();
  return (ci !== '' && ci !== '0' && ci !== 'false') || env.RUN_SHELL_TESTS === '1';
}

const open = shellTestsEnabled();

type Runner = (...args: never[]) => unknown;

/** A test or suite function that registers everything as skipped with the gate's reason: (name?, options?, fn?) in any order node allows. */
function closed<T extends Runner>(orig: T): T {
  const call = (...args: unknown[]): unknown => {
    let name: string | undefined;
    let options: Record<string, unknown> = {};
    let fn: unknown;
    for (const a of args) {
      if (typeof a === 'string') name = a;
      else if (typeof a === 'function') fn = a;
      else if (a && typeof a === 'object') options = a as Record<string, unknown>;
    }
    const label = name ?? (typeof fn === 'function' && fn.name ? fn.name : '<anonymous>');
    // The body never runs: a no-op stands in, so a suite's own setup code (which may spawn) is not executed either.
    return (orig as unknown as (n: string, o: object, f: () => void) => unknown)(label, { ...options, skip: SHELL_TESTS_SKIP_REASON }, () => {});
  };
  const out = call as unknown as Record<string, unknown>;
  const src = orig as unknown as Record<string, unknown>;
  for (const k of ['skip', 'todo', 'only']) if (typeof src[k] === 'function') out[k] = call;
  return out as unknown as T;
}

const noop = (() => {}) as unknown as typeof nodeTest.before;

export const test: typeof nodeTest.test = open ? nodeTest.test : closed(nodeTest.test);
export const it: typeof nodeTest.it = open ? nodeTest.it : closed(nodeTest.it);
export const describe: typeof nodeTest.describe = open ? nodeTest.describe : closed(nodeTest.describe);
export const suite: typeof nodeTest.suite = open ? nodeTest.suite : closed(nodeTest.suite);
export const before: typeof nodeTest.before = open ? nodeTest.before : noop;
export const after: typeof nodeTest.after = open ? nodeTest.after : (noop as unknown as typeof nodeTest.after);
export const beforeEach: typeof nodeTest.beforeEach = open ? nodeTest.beforeEach : (noop as unknown as typeof nodeTest.beforeEach);
export const afterEach: typeof nodeTest.afterEach = open ? nodeTest.afterEach : (noop as unknown as typeof nodeTest.afterEach);
export const mock = nodeTest.mock;
export default test;
