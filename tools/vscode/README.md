# ClaudePilot for VS Code

Your ClaudePilot agents, tickets, workspaces, approvals and usage, inside VS Code. Slice 1 of T-1974; the design and the security rules
are in `docs/prd/vscode-extension.md` of the ClaudePilot repository.

- **Sign in**: `ClaudePilot: Sign In` shows a code; approve it in the portal (signed in) at `/admin/vscode`. The token is kept in
  VS Code's SecretStorage only, lives 30 days, and is revoked by `ClaudePilot: Sign Out` or in the portal (Access, MCP tokens).
- **Views**: Agents (leads and their workers), Tickets (by bucket and status), Workspaces, and Chat (one agent's transcript; send).
- **Status bar**: the active Claude's tightest usage window and what needs you; a click lists the approvals.
- **Approvals**: each new one is a notification; Review opens the whole request read-only. Deny it here; Allow it in the portal (Open in Portal).

Setting `claudepilot.portalUrl`: `https://` for a real portal, `http://` only for this machine (a `kubectl port-forward`).

Build: `npm ci && npm test && npm run typecheck && npm run package` here, or `scripts/package.sh`. Output: `claudepilot.vsix`.
