// What keeps copies equal (docs/prd/claude-version-pinning.md §13): the canary's flag lists against the chat controller's and the portal's own commands, the
// generated MCP stand-in kit against its source, and the commands the canary guards against what other areas depend on.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { btwCommand } from '../chat/btwRun.js';
import { probeCommand } from '../claudeusage/probe.js';
import { buildStandalone } from '../mcp/builtin/testkit/build.js';
import { CHAT_FLAGS } from './canary/checks.js';
import { MCP_STANDIN } from './canary/kit.generated.js';

test('the canary starts a chat process with the flags the chat controller does', () => {
  const source = readFileSync(new URL('../chat/controller.ts', import.meta.url), 'utf8');
  const line = /const BASE_FLAGS = \[(.*)\];/.exec(source)?.[1];
  assert.ok(line, 'controller.ts has BASE_FLAGS');
  const flags = [...line!.matchAll(/'([^']*)'|START_MODE/g)].map((m) => (m[0] === 'START_MODE' ? 'default' : m[1]!));
  assert.equal(flags[0], '-p');
  assert.deepEqual(CHAT_FLAGS, flags.slice(1), 'CHAT_FLAGS in canary/checks.ts equals BASE_FLAGS after -p (chat/controller.ts)');
});

test('the generated MCP stand-in kit is what the source builds', () => {
  assert.equal(MCP_STANDIN, buildStandalone(), 'run: npm run gen:canary-kit -w @portal/server');
  assert.ok(MCP_STANDIN.startsWith('#!/usr/bin/env node\n'));
  assert.ok(!/require\((['"])(?!node:)[a-z@]/.test(MCP_STANDIN), 'only Node built-ins');
});

test('the portal’s own side-question and usage-probe commands carry what the canary asserts about them', () => {
  const btw = btwCommand({ claudeDir: '', model: null, effort: 'low', maxCostUsd: 0.5, limitSeconds: 60, maxOutputTokens: 1024 });
  for (const flag of ['--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--tools']) assert.ok(btw.includes(flag), `the side question passes ${flag}`);
  assert.equal(btw[btw.indexOf('--tools') + 1], '', 'with an EMPTY tool list');
  assert.ok(probeCommand('').includes('--safe-mode'), 'the usage probe passes --safe-mode (a poll must not run the user’s hooks)');
});
