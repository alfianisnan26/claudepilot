// Evidence times (PILOT-1111): the SDK stamps console, network and interaction entries with epoch milliseconds (Date.now(), or
// performance.timeOrigin + startTime for resources). The validator capped every number at 1e12 (September 2001) and answered 422
// "network[0].ts is out of range" to every real report.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { epochMs, parseEvidence } from './validate.js';
import { evidence } from './testkit.js';

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
