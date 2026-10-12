/**
 * Shared by the provider templates (MCP providers PRD, docs/prd/mcp-providers.md). Every fact in a template is checked
 * against the provider's documentation and, where the provider is public, against its discovery documents; the PRD lists
 * each with its source and whether it was observed, documented or is still unverified.
 */

/** The day the facts in the templates were last checked (each template's `checkedAt`). */
export const CHECKED_AT = '2026-10-12';

/**
 * The loopback port a pre-registered OAuth client signs in on (providers PRD §4). Claude Code's redirect is
 * `http://localhost:<callbackPort>/callback` 📄 and a registered redirect URI matches exactly, so a template whose person
 * registers a client by hand pins one port for everybody. Not 8080 or another dev-server port, and below Linux's
 * ephemeral range (32768 and up), so nothing else is likely to hold it while someone signs in.
 */
export const OAUTH_CALLBACK_PORT = 24819;

/** The redirect URI a person registers at the provider for a pre-registered client (written into the templates' notes). */
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;
