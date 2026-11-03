// WebMCP auto-approve grants (PILOT-1128, docs/prd/ui-reporter-webmcp.md "Auto-approve"): which grants apply to a token (person, bucket,
// origin; a session grant only its own token), expiry, revoke, sign-out, the hourly caps, the webmcp-auto tag and the audit line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPORTER_AGENT_AUTO_TAG, REPORTER_AGENT_GRANT_HEADER, REPORTER_LIMITS } from '@portal/contracts';
import { UAT, build, capture, reporterHarness } from './testkit.js';

type Json = { data?: any; error?: { code: string; message: string } };
const body = async (r: Response) => (await r.json()) as Json;
type H = Awaited<ReturnType<typeof reporterHarness>>;

const grant = async (h: H, token: string, group: string, scope: string) =>
  (await body(await h.postJson('/reporter/v1/agent-grants', token, { group, scope }))).data;
const grants = async (h: H, token: string) => (await body(await h.call('/reporter/v1/agent-grants', { token }))).data;
const file = (h: H, token: string, grantId?: string) =>
  h.call('/reporter/v1/tickets', {
    method: 'POST',
    token,
    headers: { 'content-type': 'application/json', ...(grantId ? { [REPORTER_AGENT_GRANT_HEADER]: grantId } : {}) },
    body: JSON.stringify({ summary: 'Agent report', captures: [capture()], build: build(), sdkVersion: '1', tags: ['webmcp'] }),
  });
const comment = (h: H, token: string, key: string, grantId?: string) =>
  h.call(`/reporter/v1/tickets/${key}/comments`, {
    method: 'POST',
    token,
    headers: { 'content-type': 'application/json', ...(grantId ? { [REPORTER_AGENT_GRANT_HEADER]: grantId } : {}) },
    body: JSON.stringify({ body: 'From the agent.' }),
  });
const tagsOf = (h: H, key: string) => {
  const id = h.tickets.resolve({ kind: 'system' }, key)!;
  return (h.store.db!.prepare('SELECT tag FROM ticket_tags WHERE ticket_number = ?').all(Number(id.slice(2))) as { tag: string }[]).map(
    (r) => r.tag,
  );
};
const ticketCount = (h: H) => (h.store.db!.prepare('SELECT count(*) AS n FROM reporter_ticket_evidence').get() as { n: number }).n;

test('grants: a session grant is its token only; an always grant is the person on this origin; another origin sees none', async () => {
  const h = await reporterHarness();
  try {
    const t1 = h.mint();
    const s = await grant(h, t1.token, 'file', 'session');
    const a = await grant(h, t1.token, 'comment', 'always');
    assert.equal(s.expiresAt, t1.expiresAt, 'a session grant ends with its sign-in');
    const days = (Date.parse(a.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(
      days > REPORTER_LIMITS.agentAlwaysDays - 0.01 && days <= REPORTER_LIMITS.agentAlwaysDays,
      `always lasts ${REPORTER_LIMITS.agentAlwaysDays} days (${days})`,
    );
    const mine = await grants(h, t1.token);
    assert.deepEqual(mine.items.map((g: { group: string; scope: string }) => `${g.group}:${g.scope}`).sort(), [
      'comment:always',
      'file:session',
    ]);
    assert.deepEqual(mine.caps, { reports: REPORTER_LIMITS.agentReportsPerHour, actions: REPORTER_LIMITS.agentActionsPerHour });

    // Another sign-in of the same person in another browser profile: only the always grant.
    const t2 = h.mint();
    assert.deepEqual(
      (await grants(h, t2.token)).items.map((g: { id: string }) => g.id),
      [a.id],
    );
    // Another origin (uat) of the same bucket: nothing, and a grant id from stg is refused there.
    const u = h.mint(UAT);
    assert.deepEqual((await grants(h, u.token)).items, []);
    assert.equal((await body(await comment(h, u.token, 'KONF-1', a.id))).error?.code, 'CONFIRMATION_REQUIRED');
    // A session grant named by another sign-in is refused, and nothing is filed.
    const before = ticketCount(h);
    assert.equal((await body(await file(h, t2.token, s.id))).error?.code, 'CONFIRMATION_REQUIRED');
    assert.equal(ticketCount(h), before);
    // Bad input.
    for (const bad of [
      { group: 'delete', scope: 'session' },
      { group: 'file', scope: 'forever' },
    ]) {
      const r = await h.postJson('/reporter/v1/agent-grants', t1.token, bad);
      assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(bad)} refused (${r.status})`);
    }
  } finally {
    h.done();
  }
});

test('auto-approved: tagged webmcp-auto, counted, audited with who, tool and grant; a grant of another group does not apply', async () => {
  const audits: { kind: string; detail: Record<string, unknown> }[] = [];
  const h = await reporterHarness({ audit: (kind, detail) => audits.push({ kind, detail }) });
  try {
    const t = h.mint();
    const g = await grant(h, t.token, 'file', 'session');
    const r = await file(h, t.token, g.id);
    assert.equal(r.status, 201);
    const key = (await body(r)).data.key as string;
    assert.ok(tagsOf(h, key).includes(REPORTER_AGENT_AUTO_TAG) && tagsOf(h, key).includes('webmcp'), JSON.stringify(tagsOf(h, key)));
    const line = audits.find((a) => a.kind === 'reporter.agent_auto_approved');
    assert.deepEqual(
      [line?.detail.tool, line?.detail.grantId, line?.detail.who, line?.detail.ticket],
      ['reporter_create_report', g.id, 'u_owner', key],
    );
    assert.ok(audits.some((a) => a.kind === 'reporter.agent_grant_made' && a.detail.grantId === g.id));
    // Asked in the sheet (no header): no auto tag.
    const plain = (await body(await file(h, t.token))).data.key as string;
    assert.ok(!tagsOf(h, plain).includes(REPORTER_AGENT_AUTO_TAG));
    // The file grant does not cover a comment.
    assert.equal((await body(await comment(h, t.token, key, g.id))).error?.code, 'CONFIRMATION_REQUIRED');
    // A comment grant does, and tags the ticket.
    const c = await grant(h, t.token, 'comment', 'session');
    assert.equal((await comment(h, t.token, plain, c.id)).status, 201);
    assert.ok(tagsOf(h, plain).includes(REPORTER_AGENT_AUTO_TAG));
  } finally {
    h.done();
  }
});

test('revoke: one grant, every grant, sign-out; another token cannot revoke a session grant it does not see (404)', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint();
    const g = await grant(h, t.token, 'file', 'session');
    const other = h.mint();
    assert.equal((await h.call(`/reporter/v1/agent-grants/${g.id}`, { method: 'DELETE', token: other.token })).status, 404);
    assert.equal((await h.call(`/reporter/v1/agent-grants/${g.id}`, { method: 'DELETE', token: t.token })).status, 200);
    assert.equal((await body(await file(h, t.token, g.id))).error?.code, 'CONFIRMATION_REQUIRED', 'revoked');

    // A new grant replaces the one of the same group and scope.
    const g1 = await grant(h, t.token, 'attach', 'always');
    const g2 = await grant(h, t.token, 'attach', 'always');
    assert.deepEqual(
      (await grants(h, t.token)).items.map((x: { id: string }) => x.id),
      [g2.id],
    );
    assert.notEqual(g1.id, g2.id);
    await grant(h, t.token, 'comment', 'session');
    assert.equal((await body(await h.call('/reporter/v1/agent-grants', { method: 'DELETE', token: t.token }))).data.revoked, 2);
    assert.deepEqual((await grants(h, t.token)).items, []);

    // Sign-out ends the token's session grants with it.
    const s = await grant(h, t.token, 'file', 'session');
    await h.call('/reporter/v1/me', { method: 'DELETE', token: t.token });
    const row = h.store.db!.prepare('SELECT revoked_at FROM reporter_agent_grants WHERE id = ?').get(s.id) as { revoked_at: string | null };
    assert.ok(row.revoked_at, 'revoked at sign-out');
  } finally {
    h.done();
  }
});

test('expiry: a grant past its time no longer applies', async () => {
  let now = Date.now();
  const h = await reporterHarness({ now: () => new Date(now) });
  try {
    const t = h.mint();
    const g = await grant(h, t.token, 'file', 'always');
    // Past the always grant's 30 days (the token would be gone too: read the service directly with a fresh token's scope).
    now += (REPORTER_LIMITS.agentAlwaysDays + 1) * 86_400_000;
    const fresh = h.mint();
    assert.deepEqual((await grants(h, fresh.token)).items, []);
    assert.equal((await body(await file(h, fresh.token, g.id))).error?.code, 'CONFIRMATION_REQUIRED');
  } finally {
    h.done();
  }
});

test('caps: over the hourly cap an auto-approval is refused (LIMIT_REACHED) and nothing is filed; the person can still allow it', async () => {
  let now = Date.now();
  const h = await reporterHarness({ now: () => new Date(now), agentCaps: { reports: 2, actions: 1 } });
  try {
    const t = h.mint();
    const g = await grant(h, t.token, 'file', 'session');
    assert.equal((await file(h, t.token, g.id)).status, 201);
    assert.equal((await file(h, t.token, g.id)).status, 201);
    const before = ticketCount(h);
    const over = await body(await file(h, t.token, g.id));
    assert.equal(over.error?.code, 'LIMIT_REACHED');
    assert.match(over.error?.message ?? '', /2 reports an hour/);
    assert.equal(ticketCount(h), before, 'nothing filed over the cap');
    assert.equal((await file(h, t.token)).status, 201, 'asked in the sheet: filed');
    // Comments and screenshot additions share the action cap.
    const key = (await body(await file(h, t.token))).data.key as string;
    const c = await grant(h, t.token, 'comment', 'session');
    assert.equal((await comment(h, t.token, key, c.id)).status, 201);
    assert.equal((await body(await comment(h, t.token, key, c.id))).error?.code, 'LIMIT_REACHED');
    // An hour later the cap has room again.
    now += 61 * 60_000;
    assert.equal((await comment(h, t.token, key, c.id)).status, 201);
  } finally {
    h.done();
  }
});
