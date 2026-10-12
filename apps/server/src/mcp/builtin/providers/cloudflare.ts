import type { McpBuiltinTemplate, McpBuiltinServer } from '@portal/contracts';
import { CHECKED_AT } from './common.js';

/**
 * Cloudflare's official remote MCP servers (providers PRD §5.5). The API server is the recommended one: two tools, `search` and
 * `execute`, reach every API endpoint (code mode), plus `docs` and `whoami`. OAuth uses dynamic client registration and the
 * person picks the permissions at Cloudflare; an API token as a Bearer token is the fallback. The documentation server needs no
 * sign-in. Cloudflare marks the Developer Platform (bindings) and Observability servers deprecated in favour of the API server;
 * they stay off unless ticked. Keys carry a `cf-` prefix because catalog entry keys are global.
 */

const token = (description: string): NonNullable<McpBuiltinServer['token']> => ({
  header: 'Authorization',
  slot: 'CLOUDFLARE_API_TOKEN',
  description,
  docUrl: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
});

export const cloudflare: McpBuiltinTemplate = {
  id: 'cloudflare',
  name: 'Cloudflare',
  icon: 'cloudflare',
  summary: 'The whole Cloudflare API through search and execute, and the docs.',
  docUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
  auth: ['oauth', 'token'],
  params: [],
  servers: [
    {
      key: 'cf-api',
      name: 'Cloudflare API',
      description: 'Every API endpoint through search and execute, plus docs and whoami.',
      url: 'https://mcp.cloudflare.com/mcp',
      transport: 'http',
      oauth: { dcr: true },
      token: token('A Cloudflare API token (user or account), sent as a Bearer token. Give it only the permissions you need.'),
      default: true,
    },
    {
      key: 'cf-docs',
      name: 'Cloudflare Docs',
      description: 'Current Cloudflare documentation. No sign-in.',
      url: 'https://docs.mcp.cloudflare.com/mcp',
      transport: 'http',
      default: true,
    },
    {
      key: 'cf-bindings',
      name: 'Developer Platform',
      description: 'Workers, D1, KV, R2 and Hyperdrive as typed tools. Deprecated by Cloudflare.',
      url: 'https://bindings.mcp.cloudflare.com/mcp',
      transport: 'http',
      oauth: { dcr: true },
      token: token('A Cloudflare API token, sent as a Bearer token.'),
      default: false,
    },
    {
      key: 'cf-observability',
      name: 'Observability',
      description: 'Worker logs and analytics. Deprecated by Cloudflare.',
      url: 'https://observability.mcp.cloudflare.com/mcp',
      transport: 'http',
      oauth: { dcr: true },
      token: token('A Cloudflare API token, sent as a Bearer token.'),
      default: false,
    },
  ],
  notes: [
    'OAuth: sign in at Cloudflare and choose the permissions to grant. Token: a user or account API token; tokens with IP address filtering are not supported.',
    'With OAuth or a user token the agent passes the account ID itself. An account token needs the Account Resources: Read permission so the account is found.',
    'Developer Platform and Observability are deprecated upstream: the API server covers them. Off unless ticked.',
  ],
  version: 1,
  checkedAt: CHECKED_AT,
};
