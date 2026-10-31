// Capture modes (owner, 2026-10-31): `viewport` ("Screen": only what was on screen) is accepted everywhere `full` is, and the ticket says which.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPORTER_CAPTURE_MODES } from '@portal/contracts';
import { areaWord, describeTicket } from './describe.js';
import { parseEvidence } from './validate.js';
import { PORTAL, REPO, STG, anchor, build, capture, evidence, reporterHarness } from './testkit.js';

const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));

test('modes: the contract lists viewport, full and crop; another mode is refused', () => {
  assert.deepEqual([...REPORTER_CAPTURE_MODES], ['viewport', 'full', 'crop']);
  for (const mode of REPORTER_CAPTURE_MODES) assert.equal(parseEvidence(bytes(evidence({ anchor: { ...anchor(), mode } }))).anchor.mode, mode);
  assert.throws(() => parseEvidence(bytes(evidence({ anchor: { ...anchor(), mode: 'tab' } }))), /anchor\.mode/);
});

test('modes: a ticket filed with a viewport capture keeps the mode, and its description says "screen"', async () => {
  const h = await reporterHarness();
  try {
    const ctx = h.service.verify(h.mint().token)!;
    const c = { ...capture(), anchor: { ...anchor(), mode: 'viewport' as const } };
    const res = h.service.createTicket(ctx, { summary: 'On screen', captures: [c], build: build(), sdkVersion: '1' }, PORTAL);
    assert.equal(h.service.ticket(ctx, res.key, PORTAL).captures[0]!.anchor.mode, 'viewport');
  } finally {
    h.done();
  }
  const ev = parseEvidence(bytes(evidence({ anchor: { ...anchor(), mode: 'viewport' } })));
  const text = describeTicket({
    text: 'x',
    site: { bucketKey: 'KONF', origin: STG, environment: 'stg', repo: REPO, declaredMismatch: null },
    build: build(),
    sdkVersion: '1',
    target: { kind: 'ticket' },
    captures: [{ captureId: 'c1', index: 1, pageUrl: `${STG}/`, path: '/', note: null, evidence: ev, screenshotAttachmentId: null, evidenceAttachmentId: null }],
    ticketId: 'T-1',
    deployments: [],
    fixCommits: [],
  });
  assert.match(text, /- Area: screen \(what was visible\) at/);
  assert.equal(areaWord('full'), 'full page');
  assert.equal(areaWord('crop'), 'crop');
  assert.equal(areaWord('something-new'), 'full page', 'an unknown mode reads as the whole page');
});
