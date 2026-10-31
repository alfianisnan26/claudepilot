// Annotated screenshots (PILOT-1111, owner 2026-10-31): the marks a reporter draws on a shot are vector data on the capture (validated,
// capped, text redacted) and a flattened image beside the original (x-reporter-kind: annotated). With a blur among the marks the panel
// uploads the flattened image AS the screenshot and the server refuses a second image, so the un-blurred original is never stored.
// Fixtures that look like secrets are built at runtime.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPORTER_LIMITS } from '@portal/contracts';
import { UI } from '../tickets/testkit.js';
import { describeTicket } from './describe.js';
import { cleanAnnotations, cleanCapture, hasBlur } from './validate.js';
import { PNG, REPO, STG, build, capture, evidence, reporterHarness } from './testkit.js';

type Json = { data?: any; error?: { code: string; message: string } };
const body = async (r: Response) => (await r.json()) as Json;
const RED = '#ef233c';
const pen = { type: 'pen', points: [10, 10, 20, 20, 30, 25], color: RED, width: 4 };
const box = { type: 'rect', rect: { x: 5, y: 5, w: 100, h: 40 }, color: '#1e88ff', width: 6 };
const blur = { type: 'blur', rect: { x: 0, y: 0, w: 50, h: 20 } };
/** A second, different PNG (content-addressed files: the same bytes would be one file). */
const PNG2 = () => Buffer.concat([PNG(), Buffer.from([2, 3, 4])]);
const JPEG = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);

test('annotations: every type is kept, numbers rounded, absent or empty means none', () => {
  const all = cleanAnnotations([
    pen,
    { type: 'highlight', points: [1, 1, 50, 1], color: '#ffd60a', width: 16 },
    { type: 'line', points: [0, 0, 10.123, 10], color: RED, width: 3 },
    { type: 'arrow', points: [0, 0, 100, 100], color: '#2dc653', width: 3 },
    box,
    { type: 'ellipse', rect: { x: 1, y: 2, w: 3, h: 4 }, color: '#ffffff', width: 2 },
    blur,
    { type: 'text', points: [40, 40], color: RED, width: 24, text: 'Too small' },
    { type: 'step', points: [60, 60], color: RED, width: 14, n: 2 },
  ]);
  assert.equal(all.length, 9);
  assert.deepEqual((all[2] as { points: number[] }).points, [0, 0, 10.1, 10]);
  assert.deepEqual(cleanAnnotations(undefined), []);
  assert.deepEqual(cleanAnnotations([]), []);
  assert.equal(hasBlur(all), true);
  assert.equal(hasBlur(cleanAnnotations([pen])), false);
  // A capture without marks has no `annotations` key at all (older panels, and what is stored).
  const c = capture();
  assert.equal('annotations' in cleanCapture(c, STG), false);
  assert.equal(cleanCapture({ ...c, annotations: [pen] }, STG).annotations!.length, 1);
});

test('annotations: unknown types, colours off the palette, bad points and coordinates are refused', () => {
  assert.throws(() => cleanAnnotations([{ ...pen, type: 'image' }]), /type/);
  assert.throws(() => cleanAnnotations([{ ...pen, color: 'javascript:alert(1)' }]), /color/);
  assert.throws(() => cleanAnnotations([{ ...pen, color: '#000000' }]), /color/);
  assert.throws(() => cleanAnnotations([{ ...pen, points: [1, 2, 3] }]), /points/, 'an odd count');
  assert.throws(() => cleanAnnotations([{ type: 'line', points: [1, 2, 3, 4, 5, 6], color: RED, width: 2 }]), /points/, 'a line has two points');
  assert.throws(() => cleanAnnotations([{ type: 'step', points: [1, 2], color: RED, width: 2, n: 0 }]), /n/);
  assert.throws(() => cleanAnnotations([{ ...pen, points: [1, Number.NaN] }]), /number/);
  assert.throws(() => cleanAnnotations([{ ...pen, points: [1, 1e9] }]), /range/);
  assert.throws(() => cleanAnnotations([{ ...pen, width: 0 }]), /range/);
  assert.throws(() => cleanAnnotations([{ type: 'text', points: [1, 1], color: RED, width: 20, text: '   ' }]), /text/);
  assert.throws(() => cleanAnnotations('nope'), /list/);
});

test('annotations: the caps (marks per capture, points per mark, points per capture) refuse, text is truncated', () => {
  const L = REPORTER_LIMITS;
  assert.equal(cleanAnnotations(Array.from({ length: L.annotations }, () => pen)).length, L.annotations);
  assert.throws(() => cleanAnnotations(Array.from({ length: L.annotations + 1 }, () => pen)), /more than/);
  const long = Array.from({ length: L.annotationPoints + 2 }, (_, i) => i % 500);
  assert.throws(() => cleanAnnotations([{ ...pen, points: long }]), /points/);
  const big = Array.from({ length: L.annotationPoints }, (_, i) => i % 500);
  const many = Array.from({ length: Math.floor(L.annotationPointsTotal / L.annotationPoints) + 1 }, () => ({ ...pen, points: big }));
  assert.throws(() => cleanAnnotations(many), /numbers/);
  const t = cleanAnnotations([{ type: 'text', points: [1, 1], color: RED, width: 20, text: 'x'.repeat(L.annotationTextChars + 50) }])[0] as { text: string };
  assert.equal(t.text.length, L.annotationTextChars);
});

test('annotations: text marks lose control characters and credential shapes (chat/redact.ts)', () => {
  const secret = ['ghp', 'A1'.repeat(18)].join('_');
  const t = cleanAnnotations([{ type: 'text', points: [1, 1], color: RED, width: 20, text: `token here\u0007 ${secret}` }])[0] as { text: string };
  assert.ok(!t.text.includes(secret), 'redacted');
  assert.ok(!t.text.includes('\u0007'));
  assert.match(t.text, /^token here/);
});

test('description: "Annotated (N marks)", and the blur line when the screenshot is the blurred image', () => {
  const site = { bucketKey: 'KONF', origin: STG, environment: 'stg', repo: REPO, declaredMismatch: null };
  const base = { captureId: 'c1', index: 1, pageUrl: `${STG}/x`, path: '/x', note: null, evidence: null, screenshotAttachmentId: 3, evidenceAttachmentId: null };
  const d = (c: object) => describeTicket({ text: '', site, build: build(), sdkVersion: '1', target: { kind: 'ticket' }, captures: [{ ...base, ...c }], ticketId: 'T-1', deployments: [], fixCommits: [] });
  assert.match(d({ marks: 3, annotatedAttachmentId: 4 }), /- Annotated \(3 marks\)\n/);
  assert.match(d({ marks: 3, annotatedAttachmentId: 4 }), /annotated screenshot \(attachment 4\)/);
  assert.match(d({ marks: 1, blurred: true }), /Annotated \(1 mark\); blurred areas are removed from the screenshot/);
  assert.doesNotMatch(d({}), /Annotated/);
});

const upload = (h: Awaited<ReturnType<typeof reporterHarness>>, token: string, path: string, captureId: string, kind: string, bytes: Buffer, type = 'image/png') =>
  h.call(path, { method: 'POST', token, headers: { 'content-type': type, 'x-reporter-capture': captureId, 'x-reporter-kind': kind }, body: bytes });

test('ticket: marks without blur keep the original and add the annotated image; the panel, owner and agent views name it', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    const c = { ...capture(), annotations: [pen, box] };
    const made = (await body(await h.postJson('/reporter/v1/tickets', t, { summary: 'Marked', description: '', captures: [c], build: build(), sdkVersion: '1' }))).data;
    const at = `/reporter/v1/tickets/${made.key}/attachments`;
    assert.equal((await upload(h, t, at, c.captureId, 'screenshot', PNG())).status, 201);
    assert.equal((await upload(h, t, at, c.captureId, 'annotated', JPEG(), 'image/jpeg')).status, 422, 'png or webp only');
    assert.equal((await upload(h, t, at, c.captureId, 'annotated', Buffer.from('not an image'))).status, 422, 'magic bytes');
    assert.equal((await upload(h, t, at, c.captureId, 'annotated', Buffer.alloc(REPORTER_LIMITS.screenshotBytes + 1, 0x89))).status, 413, 'the size cap');
    assert.equal((await upload(h, t, at, c.captureId, 'annotated', PNG2())).status, 201);
    assert.equal((await upload(h, t, at, c.captureId, 'annotated', PNG2())).status, 409, 'one annotated image per capture');
    const view = (await body(await h.call(`/reporter/v1/tickets/${made.key}`, { token: t }))).data;
    assert.match(view.captures[0].annotatedUrl, /\/annotated$/);
    assert.equal(view.captures[0].marks, 2);
    const img = await h.call(view.captures[0].annotatedUrl.replace(/^https?:\/\/[^/]+/, ''), { token: t });
    assert.equal(img.status, 200);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG2());
    const id = h.tickets.get(UI, made.key).ticket.id;
    const ev = h.service.evidence(id)!;
    assert.ok(ev.captures[0]!.annotatedAttachmentId && ev.captures[0]!.screenshotAttachmentId, 'both kept');
    assert.equal(ev.captures[0]!.annotations!.length, 2);
    assert.match(h.tickets.get(UI, made.key).ticket.description, /Annotated \(2 marks\)/);
    const agent = h.service.evidenceForAgent(id) as { captures: { annotated_attachment_id: number; marks: number }[] };
    assert.equal(agent.captures[0]!.marks, 2);
    assert.equal(agent.captures[0]!.annotated_attachment_id, Number(ev.captures[0]!.annotatedAttachmentId));
  } finally {
    h.done();
  }
});

test('ticket: with a blur the annotated kind is refused (no original stored); a capture without marks refuses it too', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    const c = { ...capture(), annotations: [pen, blur] };
    const plain = capture('/other');
    const made = (await body(await h.postJson('/reporter/v1/tickets', t, { summary: 'Secret', description: '', captures: [c, plain], build: build(), sdkVersion: '1' }))).data;
    const at = `/reporter/v1/tickets/${made.key}/attachments`;
    // The panel sends the flattened (blurred) image as the screenshot; nothing else may join it.
    assert.equal((await upload(h, t, at, c.captureId, 'screenshot', PNG2())).status, 201);
    const refused = await upload(h, t, at, c.captureId, 'annotated', PNG());
    assert.equal(refused.status, 422);
    assert.match((await body(refused)).error!.message, /blurred/);
    assert.equal((await upload(h, t, at, plain.captureId, 'annotated', PNG())).status, 422, 'no marks, no annotated image');
    const ticket = h.tickets.get(UI, made.key).ticket;
    const images = h.tickets.attachments(UI, ticket.id).filter((a) => a.mediaType.startsWith('image/'));
    assert.equal(images.length, 1, 'only the blurred screenshot is stored');
    assert.equal(h.service.evidence(ticket.id)!.captures[0]!.annotatedAttachmentId, null);
    assert.match(ticket.description, /blurred areas are removed from the screenshot/);
  } finally {
    h.done();
  }
});

test('review: a comment keeps its marks and annotated image, refuses it with a blur, and both move to the ticket on submit', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint().token;
    const rv = (await body(await h.postJson('/reporter/v1/reviews', t, { title: 'Pass', build: build(), sdkVersion: '1' }))).data;
    const marked = { ...capture('/a'), annotations: [pen] };
    const blurred = { ...capture('/b'), annotations: [blur] };
    await h.postJson(`/reporter/v1/reviews/${rv.id}/comments`, t, { capture: marked, body: 'Marked' });
    await h.postJson(`/reporter/v1/reviews/${rv.id}/comments`, t, { capture: blurred, body: 'Blurred' });
    const at = `/reporter/v1/reviews/${rv.id}/attachments`;
    assert.equal((await upload(h, t, at, marked.captureId, 'screenshot', PNG())).status, 201);
    assert.equal((await upload(h, t, at, marked.captureId, 'annotated', PNG2())).status, 201);
    assert.equal((await upload(h, t, at, blurred.captureId, 'screenshot', PNG2())).status, 201);
    assert.equal((await upload(h, t, at, blurred.captureId, 'annotated', PNG())).status, 422, 'blurred: the screenshot only');
    const r = (await body(await h.call(`/reporter/v1/reviews/${rv.id}`, { token: t }))).data;
    assert.match(r.comments[0].annotatedUrl, /\/annotated$/);
    assert.equal(r.comments[0].marks, 1);
    assert.equal(r.comments[1].annotatedUrl, null);
    assert.equal((await h.call(r.comments[0].annotatedUrl.replace(/^https?:\/\/[^/]+/, ''), { token: t })).status, 200);
    void evidence;
    const ok = (await body(await h.postJson(`/reporter/v1/reviews/${rv.id}/submit`, t, { summary: 'Pass', description: '', mode: 'single' }))).data;
    const ticket = h.tickets.get(UI, ok.ticketKeys[0]).ticket;
    const ev = h.service.evidence(ticket.id)!;
    assert.ok(ev.captures[0]!.annotatedAttachmentId, 'the annotated image moved');
    assert.equal(ev.captures[0]!.annotations!.length, 1);
    assert.equal(ev.captures[1]!.annotatedAttachmentId, null);
    assert.equal(ev.captures[1]!.annotations![0]!.type, 'blur');
    assert.match(ticket.description, /Annotated \(1 mark\)\n/);
    assert.match(ticket.description, /Annotated \(1 mark\); blurred areas/);
  } finally {
    h.done();
  }
});
