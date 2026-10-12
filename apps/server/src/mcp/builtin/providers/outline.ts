import type { McpBuiltinTemplate } from '@portal/contracts';
import { CHECKED_AT } from './common.js';

/**
 * Outline's built-in MCP endpoint, `<outline>/mcp` (providers PRD §5.4): OAuth with dynamic client registration is the
 * default, an API key as a Bearer token the fallback. Stateless streamable HTTP, POST only. Hosted workspaces and
 * self-hosted ones differ only in the address.
 */
export const outline: McpBuiltinTemplate = {
  id: 'outline',
  name: 'Outline',
  icon: 'outline',
  summary: 'Search, read and edit documents in your Outline wiki.',
  docUrl: 'https://docs.getoutline.com/s/guide/doc/mcp-6j9jtENNKL',
  auth: ['oauth', 'token'],
  params: [
    {
      key: 'outlineUrl',
      label: 'Outline URL',
      hint: 'Your Outline address, like https://docs.example.com or https://team.getoutline.com. No /mcp at the end.',
      kind: 'url',
      required: true,
      placeholder: 'https://docs.example.com',
    },
  ],
  servers: [
    {
      key: 'outline',
      name: 'Outline',
      description: 'Outline’s MCP endpoint: search, read, create and edit documents.',
      url: '{outlineUrl}/mcp',
      transport: 'http',
      oauth: { dcr: true },
      token: {
        header: 'Authorization',
        slot: 'OUTLINE_API_KEY',
        description: 'An Outline API key, sent as a Bearer token. Create one in Outline’s account settings.',
        docUrl: 'https://docs.getoutline.com/s/guide/doc/mcp-6j9jtENNKL',
      },
      default: true,
    },
  ],
  notes: [
    'Sign-in needs Outline 1.9 or later; an API key works from 1.6.1.',
    'An admin can turn MCP off for the workspace (Settings, Workspace, AI): the server then answers as if it were not there.',
    'Self-hosted Outline: registration must be on for OAuth. If it is off, use an API key.',
  ],
  version: 1,
  checkedAt: CHECKED_AT,
};
