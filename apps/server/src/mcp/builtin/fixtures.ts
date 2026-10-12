import type { McpBuiltinTemplate } from '@portal/contracts';

/**
 * Small stand-in templates for tests, one per style of sign-in the catalogue has to carry: a token-only provider, a public
 * PKCE client that needs a client ID and a fixed callback port, dynamic registration with a self-hosted host, a built-in
 * endpoint on the admin's own host, and several servers of which one needs no sign-in. Fake hosts; the real definitions are
 * in `providers/` (MCP providers PRD).
 */

const github: McpBuiltinTemplate = {
  id: 'github',
  name: 'GitHub',
  icon: 'github',
  summary: 'Repositories, issues and pull requests.',
  docUrl: 'https://docs.example.com/github-mcp',
  auth: ['token'],
  params: [],
  servers: [
    {
      key: 'github',
      name: 'GitHub',
      description: 'The hosted GitHub MCP server.',
      url: 'https://api.githubcopilot.com/mcp/',
      transport: 'http',
      token: { header: 'Authorization', slot: 'GITHUB_TOKEN', description: 'A GitHub token.', docUrl: 'https://github.com/settings/tokens' },
      default: true,
    },
  ],
  notes: ['Token only: GitHub offers no OAuth to a third-party host without a client secret.'],
  version: 1,
  checkedAt: '2026-10-12',
};

const gitea: McpBuiltinTemplate = {
  id: 'gitea',
  name: 'Gitea',
  icon: 'gitea',
  summary: 'Repositories and issues on a Gitea.',
  docUrl: 'https://docs.example.com/gitea-mcp',
  auth: ['oauth', 'token'],
  params: [
    { key: 'baseUrl', label: 'Gitea', kind: 'url', required: true, default: 'https://git.example.com', hint: 'The Gitea that signs people in.' },
    { key: 'mcpUrl', label: 'MCP URL', kind: 'url', required: true, default: 'https://gitea-mcp.example.com/mcp' },
    { key: 'clientId', label: 'Client ID', kind: 'text', required: true, auth: 'oauth', placeholder: 'Public OAuth app ID', hint: 'Create a public (PKCE) OAuth app in Gitea.' },
  ],
  servers: [
    {
      key: 'gitea',
      name: 'Gitea',
      description: 'Gitea’s MCP server.',
      url: '{mcpUrl}',
      transport: 'http',
      oauth: { dcr: false, clientIdParam: 'clientId', scopes: ['write:repository', 'write:issue'], callbackPort: 8765, authServerMetadataUrl: '{baseUrl}/.well-known/openid-configuration' },
      token: { header: 'Authorization', slot: 'GITEA_TOKEN' },
      default: true,
    },
  ],
  notes: ['The OAuth app is public: no client secret.'],
  version: 1,
  checkedAt: '2026-10-12',
};

const gitlab: McpBuiltinTemplate = {
  id: 'gitlab',
  name: 'GitLab',
  icon: 'gitlab',
  summary: 'Projects, issues and merge requests.',
  docUrl: 'https://docs.example.com/gitlab-mcp',
  auth: ['oauth', 'token'],
  params: [
    { key: 'gitlabUrl', label: 'GitLab', kind: 'url', required: true, default: 'https://gitlab.example.com' },
    { key: 'clientId', label: 'Client ID', kind: 'text', required: false, auth: 'oauth' },
  ],
  servers: [
    {
      key: 'gitlab',
      name: 'GitLab',
      description: 'GitLab’s built-in MCP server.',
      url: '{gitlabUrl}/api/v4/mcp',
      transport: 'http',
      oauth: { dcr: true, clientIdParam: 'clientId' },
      token: { header: 'PRIVATE-TOKEN', template: '{value}', slot: 'GITLAB_TOKEN' },
      default: true,
    },
  ],
  notes: [],
  version: 1,
  checkedAt: '2026-10-12',
};

const outline: McpBuiltinTemplate = {
  id: 'outline',
  name: 'Outline',
  icon: 'outline',
  summary: 'Search and edit documents.',
  docUrl: 'https://docs.example.com/outline-mcp',
  auth: ['token'],
  params: [{ key: 'outlineUrl', label: 'Outline', kind: 'url', required: true, placeholder: 'https://docs.example.com' }],
  servers: [
    {
      key: 'outline',
      name: 'Outline',
      description: 'The MCP endpoint built into Outline.',
      url: '{outlineUrl}/mcp',
      transport: 'http',
      token: { header: 'Authorization', slot: 'OUTLINE_API_KEY' },
      default: true,
    },
  ],
  notes: [],
  version: 1,
  checkedAt: '2026-10-12',
};

const cloudflare: McpBuiltinTemplate = {
  id: 'cloudflare',
  name: 'Cloudflare',
  icon: 'cloudflare',
  summary: 'Docs, the API and bindings.',
  docUrl: 'https://docs.example.com/cloudflare-mcp',
  auth: ['oauth', 'token'],
  params: [],
  servers: [
    { key: 'cf-docs', name: 'Cloudflare docs', description: 'Search Cloudflare’s documentation.', url: 'https://docs.mcp.cloudflare.com/mcp', transport: 'http', default: true },
    {
      key: 'cf-api',
      name: 'Cloudflare API',
      description: 'Search and call the whole API.',
      url: 'https://mcp.cloudflare.com/mcp',
      transport: 'http',
      oauth: { dcr: true },
      token: { header: 'Authorization', slot: 'CLOUDFLARE_API_TOKEN' },
      default: true,
    },
    {
      key: 'cf-bindings',
      name: 'Cloudflare bindings',
      description: 'Workers, KV, R2 and D1.',
      url: 'https://bindings.mcp.cloudflare.com/mcp',
      transport: 'http',
      oauth: { dcr: true },
      token: { header: 'Authorization', slot: 'CLOUDFLARE_API_TOKEN' },
      default: false,
    },
  ],
  notes: [],
  version: 1,
  checkedAt: '2026-10-12',
};

export const FIXTURE_TEMPLATES: readonly McpBuiltinTemplate[] = [github, gitea, gitlab, outline, cloudflare];
