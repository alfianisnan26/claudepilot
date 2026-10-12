// Slack incoming webhook (docs/prd/web-app-pwa.md §11.5): `{text, blocks}` with a section (title and body), a context line, and a link
// `<url|Open>` in mrkdwn; at most 3,000 characters of text. No buttons (owner decision O6). Pure.

import type { Rendered } from '../templates.js';
import type { ChannelMessage } from './webhook.js';

export const SLACK_MAX = 3000;

/** `https://hooks.slack.com/services/T…/B…/…` (and the workflow and trigger webhooks). */
export const SLACK_URL = /^https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{20,300}$/;

/** Slack's three control characters; mentions written as text never resolve once escaped. */
export const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackMessage(r: Rendered, opts: { url: string | null; detail: string | null; kindLabel: string; when: string }): ChannelMessage {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const title = escapeSlack(r.title);
  let body = escapeSlack(r.body.split('\n')[0] ?? '');
  if (opts.detail) body += `\nUntrusted: ${escapeSlack(opts.detail)}`;
  const section = clip(`*${title}*\n${body}`, SLACK_MAX - 200);
  const link = opts.url && /^https?:\/\/[^\s|<>]+$/.test(opts.url) ? ` · <${opts.url}|Open>` : '';
  const text = clip(`${title}: ${escapeSlack(r.body.split('\n')[0] ?? '')}`, 300);
  return {
    body: JSON.stringify({
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: section } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${escapeSlack(opts.kindLabel)} · ${escapeSlack(opts.when)}${link}` }] },
      ],
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'pilot-notify/1' },
  };
}
