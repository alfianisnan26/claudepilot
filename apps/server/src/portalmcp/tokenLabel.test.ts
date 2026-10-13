import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { PORTAL_TOKEN_LABEL_MAX } from '@portal/contracts';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import { portalMcpHarness, URL_ } from './testkit.js';

// T-6: the token's label is what the portal shows wherever the client acts, so it is required, one line of plain text, and stored as typed.

const h = await portalMcpHarness();
process.once('beforeExit', () => h.done());

const refusal = (label: unknown): string | null => {
  try {
    h.module.createToken({ label: label as string, scope: 'read' }, URL_);
    return null;
  } catch (e) {
    return isAppError(e) ? `${e.code}:${(e.details as { label?: string } | undefined)?.label ?? ''}` : String(e);
  }
};

test('a token made without a label is refused, with a message that says what the label is for', () => {
  for (const label of [undefined, null, '', '   ', 42]) assert.match(refusal(label) ?? 'accepted', /^VALIDATION_FAILED:Required\.$/, String(label));
  try {
    h.module.createToken({ scope: 'read' }, URL_);
    assert.fail('accepted');
  } catch (e) {
    assert.ok(isAppError(e));
    assert.match(e.message, /label/);
    assert.match(e.message, /shown/);
  }
  assert.equal(h.module.tokens.list().length, 0, 'nothing was made');
});

test('the label is one line of plain text of 1 to 60 characters, trimmed', () => {
  assert.match(refusal('a\nb') ?? 'accepted', /^VALIDATION_FAILED:/);
  assert.match(refusal('a\u0000b') ?? 'accepted', /^VALIDATION_FAILED:/);
  assert.match(refusal('<b>relay</b>') ?? 'accepted', /^VALIDATION_FAILED:/);
  assert.match(refusal('x'.repeat(PORTAL_TOKEN_LABEL_MAX + 1)) ?? 'accepted', /^VALIDATION_FAILED:/);
  const { token } = h.module.createToken({ label: `  ${'x'.repeat(PORTAL_TOKEN_LABEL_MAX)}  `, scope: 'read' }, URL_);
  assert.equal(token.label, 'x'.repeat(PORTAL_TOKEN_LABEL_MAX));
  assert.equal(h.module.createToken({ label: '  relay ', scope: 'read' }, URL_).token.label, 'relay');
});

test('the label stays on the audit rows of what the token did, whatever happens to the token later', async () => {
  const t = h.token('read', 'dev-sessions-supervisor');
  await h.call(t.secret, 'portal_status');
  h.module.revokeToken(t.id);
  const rows = h.module.audit.list({ tokenId: t.id });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.tokenLabel === 'dev-sessions-supervisor'));
});

test('a tool sees the token’s label as actorLabel; an agent’s per-session token has none (it is shown as its session)', async () => {
  const seen: Record<string, unknown>[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: 'who_am_i',
    title: 'Who am I',
    description: 'Returns the actor and the label a call is recorded under.',
    scope: 'agent',
    hints: { readOnly: true },
    input: z.object({}),
    handler: (ctx) => (seen.push({ actor: ctx.actor, actorLabel: ctx.actorLabel }), { summary: 'ok' }),
  });
  const k = await portalMcpHarness({ registry });
  try {
    const user = k.token('read', 'relay');
    await k.call(user.secret, 'who_am_i');
    const agent = await k.agentToken('docker/api', 's-agent');
    await k.call(agent.secret, 'who_am_i');
    assert.deepEqual(seen, [
      { actor: `portal-mcp:${user.id}`, actorLabel: 'relay' },
      { actor: 'session:s-agent', actorLabel: undefined },
    ]);
  } finally {
    k.done();
  }
});
