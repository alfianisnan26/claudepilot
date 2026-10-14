// T-95 item 4: a gate that passed on a rerun names its flaky tests; the portal keeps one ticket per test across runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TICKET_LIMITS } from '@portal/contracts';
import { FLAKY_EXCERPT_BYTES, flakyExcerpt, flakyTitle, parseFlaky } from './flaky.js';
import { FakeTickets } from './tickets.js';
import { harness, remote, type H } from './testkit.js';

const line = (file: string, name: string, prefix = 'note') => `${prefix}: flaky, passed on rerun: ${file};${name}`;
// Built at runtime: no token-shaped literal in the repository.
const canary = () => `sk-ant-api03-${'q'.repeat(12)}${'Z'.repeat(20)}`;

test('parse: one line, several (the pipeline\'s `gate:` form too, a test name with a `;`), none, and malformed lines', () => {
  assert.deepEqual(parseFlaky(line('src/connect/hub.test.ts', 'the control stream')), [{ file: 'src/connect/hub.test.ts', test: 'the control stream' }]);
  const many = [
    'npm-ci rc=0 12s',
    line('src/a.test.ts', 'first'),
    line('src/b.test.ts', 'waits; in quiet hours', 'gate'),
    line('src/a.test.ts', 'first'), // the same test twice is once
    '  ' + line('src/c.test.ts', 'indented'),
  ].join('\n');
  assert.deepEqual(parseFlaky(many), [
    { file: 'src/a.test.ts', test: 'first' },
    { file: 'src/b.test.ts', test: 'waits; in quiet hours' },
    { file: 'src/c.test.ts', test: 'indented' },
  ]);
  assert.deepEqual(parseFlaky('GATE-VERDICT: green\nnote: server-suite-rerun: passed alone: src/a.test.ts\n'), []);
  // The old format (names only), no test after the `;`, no file, and a line that only mentions it in passing.
  const malformed = ['note: flaky, passed on rerun: a deploy waits;the control stream', line('src/a.test.ts', ' '), 'note: flaky, passed on rerun: ;name', `echo "${line('src/a.test.ts', 'x')}"`].join('\n');
  assert.deepEqual(parseFlaky(malformed), []);
  assert.equal(parseFlaky(Array.from({ length: 15 }, (_, i) => line('src/a.test.ts', `t${i}`)).join('\n')).length, 10, 'at most 10 per log');
});

test('the excerpt: the test\'s own report, redacted, at most 2 KiB; the title fits the ticket limit', () => {
  const secret = canary();
  const log = ['=== FAILURES', 'not ok 3 - the control stream', '  ---', `  error: 'boom ${secret}'`, '  stack: |-', ...Array.from({ length: 200 }, (_, i) => `    at frame ${i} ${'x'.repeat(40)}`), '  ...', 'not ok 4 - other'].join('\n');
  const ex = flakyExcerpt(log, 'the control stream')!;
  assert.ok(ex.startsWith('not ok 3 - the control stream\n  ---\n  error:'));
  assert.ok(!ex.includes(secret), 'the canary is redacted');
  assert.ok(Buffer.byteLength(ex) <= FLAKY_EXCERPT_BYTES + 40, 'bounded');
  assert.ok(!ex.includes('not ok 4'));
  assert.equal(flakyExcerpt(log, 'not there'), null);
  const t = flakyTitle({ file: 'src/a.test.ts', test: 'n'.repeat(300) });
  assert.equal(t.length, TICKET_LIMITS.summary);
  assert.ok(t.startsWith('Flaky in the gate: src/a.test.ts nnn') && t.endsWith('…'));
});

/** A pipeline whose gate step passes and prints what the gate prints after a rerun-pass, with a canary in a failure report. */
const pipeline = (secret: string) => `on: push
jobs:
  gate:
    steps:
      - name: Release gate
        run: |
          echo "not ok 3 - the control stream"
          echo "  ---"
          echo "  error: 'connection reset ${secret}'"
          echo "  ..."
          echo "${line('src/connect/hub.test.ts', 'the control stream')}"
          echo "${line('src/notify/pipeline.test.ts', 'a deploy waits')}"
          echo "${line('src/notify/pipeline.test.ts', 'a deploy waits')}"
  other:
    steps:
      - name: Fails
        run: |
          echo "${line('src/x.test.ts', 'never a ticket: the step failed')}"
          exit 1
`;

async function pushAndPass(h: H, branch: string): Promise<string> {
  h.home.git(['checkout', '-q', '-B', branch, 'main'], h.src);
  h.home.commit(h.src, { [`${branch}.txt`]: branch }, 'a change');
  h.home.git(['push', '-q', 'pilot', branch], h.src);
  await h.until('the run to end with its logs kept', () => {
    const r = h.svc.list({ branch }).items[0];
    return !!r && !['queued', 'running'].includes(r.status) && h.svc.get(r.id).archived;
  });
  return h.svc.list({ branch }).items[0]!.id;
}

test('one ticket per distinct test across runs: a second sighting comments with the run and a count, a closed ticket is reopened; the run shows flaky: N and the tickets', async () => {
  const secret = canary();
  const tickets = new FakeTickets();
  const h = await harness({ tickets });
  try {
    await remote(h, { '.pilot/ci.yml': pipeline(secret) });
    const first = await pushAndPass(h, 'a');
    assert.equal(tickets.opened.length, 2, 'one ticket per distinct test; the failed step names none');
    const [hub, notify] = tickets.opened;
    assert.equal(hub!.summary, 'Flaky in the gate: src/connect/hub.test.ts the control stream');
    assert.deepEqual(hub!.tags, ['flaky', 'area-qa', 'app'], 'the remote\'s name is a tag (claudepilot for the portal\'s own)');
    assert.equal(hub!.workspaceId, 'docker/test');
    assert.match(hub!.description, new RegExp(`\\[#\\d+\\]\\(/admin/ci/runs/${first}\\)`));
    assert.match(hub!.description, /untrusted output/);
    assert.match(hub!.description, /20 times in a Job/);
    assert.match(hub!.description, / {4}not ok 3 - the control stream/, 'the failure report, indented as a block');
    assert.ok(!hub!.description.includes(secret), 'a canary never reaches the ticket');
    assert.match(notify!.description, /no failure report/);
    const run = h.svc.get(first);
    assert.match(hub!.description, new RegExp(`Commit: ${run.sha}`));
    assert.deepEqual(run.flaky, [{ job: 'gate', tests: 2, tickets: [hub!.id, notify!.id] }]);

    // A second run that sees the same tests: comments, no new ticket.
    const second = await pushAndPass(h, 'b');
    assert.equal(tickets.opened.length, 2);
    const notes = tickets.notes.filter((n) => n.actor === `ci:${second}`);
    assert.deepEqual(notes.map((n) => n.ticketId).sort(), [hub!.id, notify!.id].sort());
    assert.match(notes[0]!.text, /^Seen again: run \[#\d+\]/);
    assert.match(notes[0]!.text, /Runs that saw it: 2\./);
    assert.deepEqual(h.svc.get(second).flaky, [{ job: 'gate', tests: 2, tickets: [hub!.id, notify!.id] }]);

    // Closed since: the next sighting reopens it, with a comment.
    tickets.closedIds.add(hub!.id);
    const third = await pushAndPass(h, 'c');
    assert.deepEqual(tickets.reopened, [hub!.id]);
    const reopenNote = tickets.notes.find((n) => n.actor === `ci:${third}` && n.ticketId === hub!.id)!;
    assert.match(reopenNote.text, /^Seen again after it was closed, so reopened/);
    assert.match(reopenNote.text, /Runs that saw it: 3\./);
    assert.equal(tickets.opened.length, 2);
  } finally {
    h.done();
  }
});
