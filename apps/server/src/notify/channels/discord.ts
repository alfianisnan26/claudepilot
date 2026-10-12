// Discord incoming webhook (docs/prd/web-app-pwa.md §11.5): one embed (a title that links to the portal when a link address is set, one
// description line, a colour by severity), `allowed_mentions: {parse: []}` so no text can ping anyone, `username: "pilot"`; under 2,000
// characters in all (Discord: `content` 2,000, up to 10 `embeds`). No buttons (owner decision O6). Pure.

import type { NotifySeverity } from '@portal/contracts';
import type { Rendered } from '../templates.js';
import type { ChannelMessage } from './webhook.js';

export const DISCORD_MAX = 2000;
const COLOUR: Record<NotifySeverity, number> = { info: 0x5865f2, attention: 0xf0b232, urgent: 0xed4245 };

/** `https://discord.com/api/webhooks/<id>/<token>` (and discordapp.com, ptb., canary., an API version). */
export const DISCORD_URL = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d{1,2}\/)?webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/;

/** Markdown and mention characters lose their meaning. */
export const escapeDiscord = (s: string) => s.replace(/([\\*_~`|>#[\]<])/g, '\\$1');

export function discordMessage(r: Rendered, opts: { url: string | null; detail: string | null }): ChannelMessage {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const title = clip(escapeDiscord(r.title), 200);
  let description = escapeDiscord(r.body.split('\n')[0] ?? '');
  if (opts.detail) description += `\nUntrusted: ${escapeDiscord(opts.detail)}`;
  description = clip(description, DISCORD_MAX - title.length - 50);
  const embed = { title, description, color: COLOUR[r.severity], ...(opts.url ? { url: opts.url } : {}) };
  return {
    body: JSON.stringify({ username: 'pilot', allowed_mentions: { parse: [] }, embeds: [embed] }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'pilot-notify/1' },
  };
}
