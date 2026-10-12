import type { McpBuiltinTemplate } from '@portal/contracts';
import { CHECKED_AT } from './common.js';

/**
 * GitHub's remote MCP server (providers PRD §5.1): token only. GitHub registers no clients dynamically (its authorization
 * server metadata has no `registration_endpoint`) and an OAuth App's code exchange still needs its client secret, which the
 * portal never holds (PRD D1), so a personal access token in a header is the one path. Read-only is a path on the same host.
 */
export const github: McpBuiltinTemplate = {
  id: 'github',
  name: 'GitHub',
  icon: 'github',
  summary: 'Repositories, issues, pull requests and Actions on github.com.',
  docUrl: 'https://github.com/github/github-mcp-server',
  auth: ['token'],
  params: [],
  servers: [
    {
      key: 'github',
      name: 'GitHub',
      description: 'GitHub’s remote MCP server with its default toolsets.',
      url: 'https://api.githubcopilot.com/mcp',
      transport: 'http',
      token: {
        header: 'Authorization',
        slot: 'GITHUB_TOKEN',
        description: 'A GitHub personal access token, sent as a Bearer token. A fine-grained one is best: grant only the repositories and permissions you need.',
        docUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
      },
      default: true,
    },
    {
      key: 'github-ro',
      name: 'GitHub (read-only)',
      description: 'The same server with its write tools hidden.',
      url: 'https://api.githubcopilot.com/mcp/readonly',
      transport: 'http',
      token: {
        header: 'Authorization',
        slot: 'GITHUB_TOKEN',
        description: 'A GitHub personal access token, sent as a Bearer token.',
        docUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
      },
      default: false,
    },
  ],
  notes: [
    'Token only: GitHub has no client registration for other apps, and its OAuth needs a client secret.',
    'GitHub Enterprise Cloud with data residency: add the server by hand, https://copilot-api.<subdomain>.ghe.com/mcp. Enterprise Server has no remote server.',
    'Tick one of the two servers, not both: they offer the same tools.',
  ],
  version: 1,
  checkedAt: CHECKED_AT,
};
