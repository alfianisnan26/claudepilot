# Fake subscription testkit

Run the real Claude Code CLI as a claude.ai subscription account (Pro, Max, ...) in a test, with no sign-in and no real token.
Observed on Claude Code 2.1.296. Everything is fake and scoped to the test process.

- `makeFakeClaude({ plan, scopes, directory, signedOut })`: a temporary HOME whose Claude directory holds a `FAKE-...` login. Add
  `user:mcp_servers` to `scopes` for the claude.ai connectors; the default has `user:inference` and `user:profile`.
- `startStandIn({ host })`: a scripted `api.anthropic.com` (HTTPS with a throwaway CA, plus a CONNECT proxy that lets only that host
  through). `set({ usage, messages, routes })` scripts the answers; `requests` lists what was asked (header names only).
  `childEnv()` is `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`: give them to the child process only. Needs the `openssl` command
  (`opensslAvailable()`). For a container, listen on `0.0.0.0` and set `advertiseHost` to what the container reaches the host as.
- `localExec(env)`: `exec` on this machine with exactly that environment, in the shape of the workspaces' `exec`.

What the real CLI does against it (all observed):

| Call | Stand-in script |
| --- | --- |
| `get_usage` control request, `GET /api/oauth/usage` | `usage: { body: { five_hour: { utilization: 41, resets_at }, seven_day, seven_day_opus, extra_usage, limits: [...] } }` (percent 0 to 100, ISO times). A 429 with no copy of its own gives `rate_limits: null`. The CLI also keeps the last body in the Claude's `.claude.json` and answers from it for 60 seconds. |
| a turn, `POST /v1/messages` | `messages: { text, headers }`; with `anthropic-ratelimit-unified-status`, `-5h-utilization` (a fraction), `-5h-reset` (Unix seconds), `-7d-utilization`, `-7d-reset` the stream carries a `rate_limit_event`. `messages: { status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected', ... } }` gives the event, then an assistant line with `api_error: "usage_limit_reached"`, then an error `result`. |
| claude.ai connectors, `GET /v1/mcp_servers?limit=1000&include_additional_installs=true` | needs the `user:mcp_servers` scope; `routes: [{ prefix: '/v1/mcp_servers', body: { data: [{ type: 'mcp_server', id: 'mcpsrv_01', display_name: 'Slack', url: 'https://mcp.example.invalid/mcp', created_at }], has_more: false, next_page: null }] }` shows as the server `claude.ai Slack` (scope `claudeai`). Sent with `anthropic-beta: mcp-servers-2025-12-04`. |
| `claude auth status --json` | `loggedIn: true`, `authMethod: "claude.ai"`, and it also prints the (fake) email and organization. Calls `GET /api/oauth/profile`. |

Never set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`: it stops the usage fetch. See `claude.integration.test.ts` for a use.
