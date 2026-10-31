// Evidence times (PILOT-1111): the SDK stamps console, network and interaction entries with epoch milliseconds (Date.now(), or
// performance.timeOrigin + startTime for resources). The validator capped every number at 1e12 (September 2001) and answered 422
// "network[0].ts is out of range" to every real report.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPORTER_LIMITS } from '@portal/contracts';
import { describeTicket } from './describe.js';
import { epochMs, parseEvidence, pinEvidence } from './validate.js';
import { REPO, STG, build, evidence } from './testkit.js';

const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));

test('evidence: real epoch-ms times pass, in every list that carries one', () => {
  const now = Date.now();
  const e = parseEvidence(
    bytes(
      evidence({
        console: [{ ts: now, level: 'error', text: 'x' }],
        network: [
          { ts: now - 1000, method: 'GET', url: 'https://stg.konfersi.com/api', status: 200, durationMs: 5, initiator: 'fetch', sizeBytes: 1 },
          { ts: Math.round(performance.timeOrigin + 12.5), method: 'GET', url: 'https://stg.konfersi.com/app.js', status: null, durationMs: 3.2, initiator: 'resource', sizeBytes: null },
        ],
        interactions: [{ ts: now - 10, kind: 'click', selector: '#buy', label: 'Buy' }],
      }),
    ),
  );
  assert.equal(e.console[0]!.ts, now);
  assert.equal(e.network.length, 2);
  assert.equal(e.interactions[0]!.ts, now - 10);
});

test('evidence: a time far in the future or before 1970 is still refused', () => {
  const now = Date.now();
  assert.equal(epochMs(now + 60 * 60_000, 'ts', now), now + 60 * 60_000, 'a device clock an hour fast');
  assert.throws(() => epochMs(now + 2 * 86_400_000, 'ts', now), /out of range/);
  assert.throws(() => epochMs(-1, 'ts', now), /out of range/);
  assert.throws(() => parseEvidence(bytes(evidence({ network: [{ ts: now + 2 * 86_400_000, method: 'GET', url: 'https://stg.konfersi.com/', status: 200, durationMs: 1, initiator: 'fetch', sizeBytes: 1 }] }))), /network\[0\]\.ts/);
});

test('evidence: a site with a port accepts the SDK page.host (location.hostname, no port); another host is still refused', () => {
  const site = 'http://localhost:4700';
  const page = (host: string) => ({ url: `${site}/a`, origin: site, host, path: '/a', search: '', hash: '', title: '', referrer: '', lang: 'en', route: null, historyLength: 1 });
  const e = (host: string) => parseEvidence(bytes(evidence({ page: page(host) })));
  assert.equal(pinEvidence(e('localhost'), site).page.host, 'localhost:4700');
  assert.equal(pinEvidence(e('localhost:4700'), site).page.host, 'localhost:4700');
  assert.throws(() => pinEvidence(e('evil.example'), site), /not of this site/);
});

test('evidence: captureGaps (what the DOM shot could not draw) is kept, one line each, capped, redacted; absent stays absent', () => {
  const secret = `Bearer ${'k'.repeat(30)}`;
  const e = parseEvidence(
    bytes(evidence({ captureGaps: ['image not readable (no CORS): cdn.example', `canvas: drawn blank\nforged line ${secret}`, '', 'x'.repeat(500)] })),
  );
  assert.equal(e.captureGaps!.length, 3, 'the empty one is dropped');
  assert.equal(e.captureGaps![0], 'image not readable (no CORS): cdn.example');
  assert.ok(!e.captureGaps![1]!.includes('\n'), 'one line each');
  assert.ok(!e.captureGaps![1]!.includes('k'.repeat(30)), 'redacted like every string');
  assert.equal(e.captureGaps![2]!.length, 200, 'truncated, not refused');
  assert.equal('captureGaps' in parseEvidence(bytes(evidence())), false, 'an older SDK sends none');
  assert.equal('captureGaps' in parseEvidence(bytes(evidence({ captureGaps: [] }))), false);
  assert.throws(() => parseEvidence(bytes(evidence({ captureGaps: Array.from({ length: REPORTER_LIMITS.captureGaps + 1 }, (_, i) => `gap ${i}`) }))), /captureGaps/);
  assert.throws(() => parseEvidence(bytes(evidence({ captureGaps: 'not a list' }))), /captureGaps/);
  assert.throws(() => parseEvidence(bytes(evidence({ captureGaps: [42] }))), /captureGaps\[0\]/);
});

test('describe: the capture section names what the screenshot could not draw in one "Not captured" line', () => {
  const ev = parseEvidence(bytes(evidence({ captureGaps: ['image not readable (no CORS): cdn.example', 'canvas: drawn blank'] })));
  const input = (e: typeof ev) => ({
    text: 'Broken',
    site: { bucketKey: 'KONF', origin: STG, environment: 'stg', repo: REPO, declaredMismatch: null },
    build: build(),
    sdkVersion: '0.1.0',
    target: { kind: 'ticket' as const },
    captures: [{ captureId: 'c1', index: 1, pageUrl: `${STG}/`, path: '/', note: null, evidence: e, screenshotAttachmentId: null, evidenceAttachmentId: null }],
    ticketId: 'T-1',
    deployments: [],
    fixCommits: [],
  });
  const lines = describeTicket(input(ev)).split('\n').filter((l) => l.includes('Not captured'));
  // Page text is untrusted Markdown: inline() escapes its punctuation.
  assert.deepEqual(lines, ['- Not captured: image not readable \\(no CORS\\): cdn.example; canvas: drawn blank']);
  assert.ok(!describeTicket(input(parseEvidence(bytes(evidence())))).includes('Not captured'), 'a complete shot says nothing');
});
