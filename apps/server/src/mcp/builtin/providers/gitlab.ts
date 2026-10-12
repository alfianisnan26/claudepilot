import type { McpBuiltinTemplate } from '@portal/contracts';
import { CHECKED_AT, OAUTH_CALLBACK_PORT, OAUTH_REDIRECT_URI } from './common.js';

/**
 * GitLab's built-in MCP server (providers PRD §5.2): `<host>/api/v4/mcp`, OAuth 2.0 with dynamic client registration and the
 * `mcp` scope. The client ID is optional: only an instance whose admin turned registration off needs a pre-registered
 * non-confidential application, and that one needs a fixed redirect port. Token mode is offered but unconfirmed: the
 * endpoint's source gates on the OAuth-only `mcp` scope, which personal access tokens cannot carry 🔬.
 */
export const gitlab: McpBuiltinTemplate = {
  id: 'gitlab',
  name: 'GitLab',
  icon: 'gitlab',
  summary: 'Projects, merge requests, issues and CI on GitLab.com or your own instance.',
  docUrl: 'https://docs.gitlab.com/user/model_context_protocol/mcp_server/',
  auth: ['oauth', 'token'],
  params: [
    {
      key: 'host',
      label: 'GitLab URL',
      hint: 'GitLab.com, or the address of your self-managed GitLab. No /api/v4/mcp at the end.',
      kind: 'url',
      required: true,
      placeholder: 'https://gitlab.com',
      default: 'https://gitlab.com',
    },
    {
      key: 'clientId',
      label: 'Client ID',
      hint: 'Leave empty: Claude Code registers itself. Only if an admin turned dynamic client registration off, enter the Application ID of a non-confidential app with the mcp scope.',
      kind: 'text',
      required: false,
      auth: 'oauth',
    },
  ],
  servers: [
    {
      key: 'gitlab',
      name: 'GitLab',
      description: 'GitLab’s built-in MCP server (/api/v4/mcp).',
      url: '{host}/api/v4/mcp',
      transport: 'http',
      oauth: { dcr: true, clientIdParam: 'clientId', callbackPort: OAUTH_CALLBACK_PORT },
      token: {
        header: 'Authorization',
        slot: 'GITLAB_TOKEN',
        description: 'A GitLab access token, sent as a Bearer token. Unconfirmed: GitLab documents OAuth sign-in only.',
        docUrl: 'https://docs.gitlab.com/user/model_context_protocol/mcp_server/',
      },
      default: true,
    },
  ],
  notes: [
    'Needs GitLab 18.3 or later, and “Allow access to the MCP server” on: for the instance, or for the top-level group on GitLab.com. Free tier from 19.2.',
    'OAuth: each workspace registers itself (GitLab allows 10 registrations an hour per IP address).',
    `Registration turned off? Create a non-confidential application with the mcp scope and the redirect URI ${OAUTH_REDIRECT_URI}, and enter its ID.`,
    'Token mode is unconfirmed: a classic personal access token has no mcp scope, so GitLab may refuse it.',
  ],
  version: 1,
  checkedAt: CHECKED_AT,
};
