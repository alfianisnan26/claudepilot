// Channels: the X-Pilot-Signature vector (computed with openssl and node in the PRD), Discord's allowed_mentions and length, Slack's
// payload, and the webhook body size.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NotifyEvent } from '@portal/contracts';
import { DISCORD_URL, discordMessage } from './channels/discord.js';
import { SLACK_URL, slackMessage } from './channels/slack.js';
import { newSigningSecret, signature, webhookMessage, WEBHOOK_BODY_MAX } from './channels/webhook.js';
import { render } from './templates.js';

const event: NotifyEvent = { id: 'evt_0123456789abcdef', kind: 'ci_failed', at: '2026-10-12T10:00:00.000Z', subject: { type: 'ci_run', id: 'run_1', workspaceId: 'docker/api-dev' }, facts: { repo: 'api', number: 14, pipeline: 'test' } };

test('X-Pilot-Signature: the PRD vector (secret s3cret, timestamp 1700000000, body {"v":1})', () => {
  assert.equal(signature('s3cret', 1700000000, '{"v":1}'), 'v1=bf81b0df9ab63212348caadf6ab8b1fc3d2c0c0cb838b2f767a6c1f11d1fa717');
  assert.match(newSigningSecret(), /^cpws_[A-Za-z0-9_-]{43}$/);
});

test('webhook: the documented JSON and headers; signed over timestamp.body; under 8 KB', () => {
  const r = render(event);
  const m = webhookMessage(event, r, { url: 'https://pilot.example.test/admin/ci/runs/run_1', deliveryId: 'dlv_1', nowS: 1700000000, secret: 's3cret', detail: null });
  const body = JSON.parse(m.body) as Record<string, unknown>;
  assert.deepEqual(body, { v: 1, id: event.id, kind: 'ci_failed', at: event.at, title: 'CI failed', body: 'api · #14 · test', url: 'https://pilot.example.test/admin/ci/runs/run_1', subject: { type: 'ci_run', id: 'run_1', workspaceId: 'docker/api-dev' }, severity: 'attention' });
  assert.equal(m.headers['X-Pilot-Event'], 'ci_failed');
  assert.equal(m.headers['X-Pilot-Delivery'], 'dlv_1');
  assert.equal(m.headers['X-Pilot-Timestamp'], '1700000000');
  assert.equal(m.headers['X-Pilot-Signature'], signature('s3cret', 1700000000, m.body));
  const unsigned = webhookMessage(event, r, { url: null, deliveryId: 'dlv_1', nowS: 1, secret: null, detail: null });
  assert.equal(unsigned.headers['X-Pilot-Signature'], undefined);
  const huge = webhookMessage(event, r, { url: null, deliveryId: 'd', nowS: 1, secret: null, detail: { text: 'x'.repeat(9000), truncated: false } });
  assert.ok(Buffer.byteLength(huge.body) <= WEBHOOK_BODY_MAX);
});

test('Discord: one embed, no mention can ping (allowed_mentions parse []), markdown escaped, under 2,000 characters', () => {
  const r = { ...render(event), title: '@everyone **look**', body: 'x'.repeat(5000) };
  const m = JSON.parse(discordMessage(r, { url: 'https://pilot.example.test/admin/ci/runs/run_1', detail: null }).body) as { username: string; allowed_mentions: { parse: string[] }; embeds: { title: string; description: string; url: string; color: number }[] };
  assert.equal(m.username, 'pilot');
  assert.deepEqual(m.allowed_mentions, { parse: [] });
  assert.equal(m.embeds.length, 1);
  assert.equal(m.embeds[0]!.title, '@everyone \\*\\*look\\*\\*');
  assert.equal(m.embeds[0]!.url, 'https://pilot.example.test/admin/ci/runs/run_1');
  assert.ok(m.embeds[0]!.title.length + m.embeds[0]!.description.length < 2000);
  assert.ok(DISCORD_URL.test('https://discord.com/api/webhooks' + '/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'));
  assert.ok(DISCORD_URL.test('https://canary.discordapp.com/api/v10/webhooks' + '/123456789012345678/AbCdEfGhIjKlMnOpQrSt'));
  assert.ok(!DISCORD_URL.test('https://discord.com.evil.test/api/webhooks/1234567/AbCdEfGhIjKlMnOpQrStUvWx'));
  assert.ok(!DISCORD_URL.test('http://discord.com/api/webhooks' + '/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz'));
});

test('Slack: {text, blocks} with a section, a context line and an <url|Open> link; control characters escaped; at most 3,000', () => {
  const r = { ...render(event), title: '<!channel> & co' };
  const m = JSON.parse(slackMessage(r, { url: 'https://pilot.example.test/admin/ci/runs/run_1', detail: null, kindLabel: 'CI failed', when: '10:00 UTC' }).body) as { text: string; blocks: { type: string; text?: { text: string }; elements?: { text: string }[] }[] };
  assert.equal(m.blocks[0]!.type, 'section');
  assert.equal(m.blocks[0]!.text!.text, '*&lt;!channel&gt; &amp; co*\napi · #14 · test');
  assert.equal(m.blocks[1]!.type, 'context');
  assert.equal(m.blocks[1]!.elements![0]!.text, 'CI failed · 10:00 UTC · <https://pilot.example.test/admin/ci/runs/run_1|Open>');
  assert.ok(!m.text.includes('<!channel>'));
  const long = JSON.parse(slackMessage({ ...r, body: 'y'.repeat(9000) }, { url: null, detail: null, kindLabel: 'x', when: 'y' }).body) as { blocks: { text?: { text: string } }[] };
  assert.ok(long.blocks[0]!.text!.text.length <= 3000);
  assert.ok(SLACK_URL.test('https://hooks.slack.com/services' + '/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX'));
  assert.ok(!SLACK_URL.test('https://hooks.slack.com.evil.test/services/T00000000/B00000000/XXXXXXXXXXXX'));
});
