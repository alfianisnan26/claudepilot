// UI reporter over Portal MCP: ticket_get says a ticket has reporter evidence, reporter_evidence reads it as untrusted data, ticket_close
// takes a fix commit, reporter_record_deployment records a live commit for a repo and environment a bucket's site serves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerActor } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { registerTicketTools } from '../tickets/portalTools.js';
import { Tickets } from '../tickets/service.js';
import { FakeSessions, UI } from '../tickets/testkit.js';
import { registerReporterTools } from './portalTools.js';
import { ReporterService } from './service.js';
import { REPO, STG, build, capture } from './testkit.js';

test('Portal MCP: ticket_get notes the evidence, reporter_evidence reads it, ticket_close takes a fix commit, deployments are recorded', async () => {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const tickets = new Tickets(h.store, new FakeSessions());
  tickets.start();
  const reporter = new ReporterService({ store: h.store, tickets });
  try {
    registerTicketTools(tickets, registry, {
      reporterNote: (id) => (reporter.evidence(id) ? { from: 'ui-reporter' } : null),
      onFixCommit: (id, c) => void reporter.addFixCommit(id, c, 'close'),
    });
    registerReporterTools(reporter, tickets, registry);
    if (!tickets.bucketOwner('KONF')) tickets.createBucket(UI, { key: 'KONF', name: 'Konfersi' });
    reporter.updateConfig('KONF', { enabled: true, sites: [{ origin: STG, environment: 'stg', repo: REPO, label: null, branch: 'stg' }] }, 'test');
    const ctx = reporter.verify(reporter.mint('KONF', STG, ownerActor() as never, 'Owner').token)!;
    const made = reporter.createTicket(ctx, { summary: 'From the page', captures: [capture()], build: build(), sdkVersion: '1' }, 'http://portal.test');
    const plain = tickets.create(UI, { summary: 'not from the page', bucket: 'KONF' });
    const t = h.token('operate', 'agent-ish');

    const got = await h.call(t.secret, 'ticket_get', { id: made.key });
    assert.deepEqual(got.result?.structuredContent?.reporter, { from: 'ui-reporter' });
    assert.equal((await h.call(t.secret, 'ticket_get', { id: plain.key! })).result?.structuredContent?.reporter, undefined);

    const ev = await h.call(t.secret, 'reporter_evidence', { id: made.key });
    assert.match(JSON.stringify(ev.result?.structuredContent), /platform\/konfersi-landing-page/);
    assert.match(JSON.stringify(ev.result?.structuredContent), /untrusted|Untrusted/);
    assert.equal((await h.call(t.secret, 'reporter_evidence', { id: plain.key! })).result?.structuredContent?.evidence, null);

    const fix = 'abc1234def';
    await h.call(t.secret, 'ticket_close', { id: made.key, summary: 'done', fix_commit: fix });
    assert.deepEqual(reporter.ticket(ctx, made.key, 'http://portal.test').fixCommits, [fix]);

    const rec = await h.call(t.secret, 'reporter_record_deployment', { bucket: 'KONF', repo: REPO, environment: 'stg', commit: fix });
    assert.equal(rec.result?.structuredContent?.deployment?.commit, fix);
    assert.equal(reporter.ticket(ctx, made.key, 'http://portal.test').deployments[0]!.status, 'deployed', 'the live commit is the fix');
    const refused = await h.call(t.secret, 'reporter_record_deployment', { bucket: 'KONF', repo: 'not/served', environment: 'stg', commit: fix });
    assert.ok(refused.result?.isError || refused.error, 'a repo no site serves is refused');
  } finally {
    reporter.stop();
    tickets.stop();
    h.done();
  }
});
