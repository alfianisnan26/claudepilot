import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PortalToken } from '@portal/contracts';
import { groupTokens, timeLeft, tokenState } from './labels';

const NOW = Date.now();
const at = (ms: number) => new Date(NOW + ms).toISOString();
const H = 3_600_000;
let n = 0;
const tok = (label: string, over: Partial<PortalToken> = {}): PortalToken => ({
  id: `ptk_${++n}`,
  label,
  preview: 'preview',
  scope: 'admin',
  createdAt: at(-n * H),
  expiresAt: at(24 * H),
  lastUsedAt: null,
  lastUsedIp: null,
  revokedAt: null,
  revokedReason: null,
  defaultWorkspaceId: null,
  ...over,
});

test('tokens group by label: newest first, live ones counted, the newest expiry and the latest use of any', () => {
  const a1 = tok('coordinator', { createdAt: at(-1 * H), expiresAt: at(1 * H), lastUsedAt: at(-3 * H) });
  const a2 = tok('coordinator', { createdAt: at(-5 * H), expiresAt: at(7 * 24 * H), lastUsedAt: at(-1 * H) });
  const a3 = tok('coordinator', { createdAt: at(-9 * H), revokedAt: at(-2 * H) });
  const b = tok('laptop', { createdAt: at(-2 * H), expiresAt: at(-1) });
  const groups = groupTokens([b, a3, a2, a1], NOW);
  assert.deepEqual(groups.map((g) => g.label), ['coordinator', 'laptop']);
  const [c, l] = groups;
  assert.deepEqual(c!.tokens.map((t) => t.id), [a1.id, a2.id, a3.id]);
  assert.deepEqual(c!.live.map((t) => t.id), [a1.id, a2.id]);
  assert.equal(c!.expiresAt, a2.expiresAt);
  assert.equal(c!.lastUsedAt, a2.lastUsedAt);
  assert.equal(l!.live.length, 0);
  assert.equal(l!.expiresAt, null);
  assert.deepEqual(groupTokens([], NOW), []);
});

test('time left reads in minutes, hours or days, rounded up', () => {
  assert.equal(timeLeft(14 * 60_000 + 1), '15 min');
  assert.equal(timeLeft(1000), '1 min');
  assert.equal(timeLeft(H), '60 min');
  assert.equal(timeLeft(5 * H - 1), '5 h');
  assert.equal(timeLeft(24 * H + 1), '2 days');
  assert.equal(tokenState(tok('x', { expiresAt: at(15 * 60_000) }), NOW).label, '15 min left');
  assert.equal(tokenState(tok('x', { expiresAt: at(-1) }), NOW).live, false);
});
