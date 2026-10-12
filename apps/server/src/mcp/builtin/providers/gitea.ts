import type { McpBuiltinTemplate } from '@portal/contracts';
import { CHECKED_AT, OAUTH_CALLBACK_PORT, OAUTH_REDIRECT_URI } from './common.js';

/**
 * Gitea through gitea-mcp in HTTP mode (providers PRD §5.3), the owner's setup (the "isnan-cluster approach"): gitea-mcp
 * runs with `-oauth`, so every request carries the caller's own Gitea access token and each person sees what their Gitea
 * account sees. Gitea registers no clients dynamically, so OAuth needs the client ID of a public (PKCE) OAuth2 app created
 * by hand, and a fixed loopback port because its redirect URI matches exactly. Gitea publishes only an OIDC discovery
 * document (no RFC 8414 one), and that document's `scopes_supported` are the OIDC scopes, not the API scopes the server
 * wants, so the scopes are pinned here (Claude Code lets pinned scopes win over the metadata's). Defaults are the owner's.
 */

/** What the owner's gitea-mcp asks for (observed in its 401 challenge and its protected resource metadata). */
const SCOPES = ['write:repository', 'write:issue', 'write:user', 'write:organization', 'write:notification', 'write:package', 'write:misc'];

export const gitea: McpBuiltinTemplate = {
  id: 'gitea',
  name: 'Gitea',
  icon: 'gitea',
  summary: 'Repositories, issues and pull requests on your Gitea, through gitea-mcp.',
  docUrl: 'https://gitea.com/gitea/gitea-mcp',
  auth: ['oauth', 'token'],
  params: [
    {
      key: 'mcpUrl',
      label: 'MCP URL',
      hint: 'Where gitea-mcp runs in HTTP mode. The default is Konfersi’s.',
      kind: 'url',
      required: true,
      placeholder: 'https://gitea-mcp.example.com/mcp',
      default: 'https://gitea-mcp.konfersi.com/mcp',
    },
    {
      key: 'baseUrl',
      label: 'Gitea URL',
      hint: 'The Gitea that signs people in: the authorization server named by the MCP server. The default is Konfersi’s.',
      kind: 'url',
      required: true,
      placeholder: 'https://git.example.com',
      default: 'https://git.konfersi.com',
      auth: 'oauth',
    },
    {
      key: 'clientId',
      label: 'Client ID',
      hint: 'Of a public OAuth2 app in your Gitea (Settings, Applications, Confidential Client off). The ID is not secret.',
      kind: 'text',
      required: true,
      placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      auth: 'oauth',
    },
  ],
  servers: [
    {
      key: 'gitea',
      name: 'Gitea',
      description: 'gitea-mcp over HTTP: repositories, issues, pull requests, releases, wikis.',
      url: '{mcpUrl}',
      transport: 'http',
      oauth: {
        dcr: false,
        clientIdParam: 'clientId',
        scopes: SCOPES,
        callbackPort: OAUTH_CALLBACK_PORT,
        authServerMetadataUrl: '{baseUrl}/.well-known/openid-configuration',
      },
      token: {
        header: 'Authorization',
        slot: 'GITEA_TOKEN',
        description: 'A Gitea access token, sent as a Bearer token. It acts as its owner.',
        docUrl: 'https://docs.gitea.com/development/api-usage',
      },
      default: true,
    },
  ],
  notes: [
    `OAuth needs a public OAuth2 app in Gitea: Settings, Applications, Confidential Client off, redirect URI ${OAUTH_REDIRECT_URI}. Its client ID goes here.`,
    'Gitea has no dynamic client registration, and gitea-mcp must run with -oauth so each person acts as themselves.',
    'Gitea access tokens last one hour. Konfersi’s server answers a wrong or expired one with 401 and a challenge, so Claude Code can refresh it; gitea-mcp alone answers 200 with a tool error and shows Connected.',
    'Token mode: a personal access token as Bearer on the same URL.',
  ],
  version: 1,
  checkedAt: CHECKED_AT,
};
