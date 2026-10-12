// Claude usage: who is asking (PLAN-10, multi-user). Until users exist every request is made as the owner. The reports, the summary and the
// recommendation take an `actorId` and filter through `UsageOptions.canUseClaude` (default: allow), so "a Claude's usage is visible to the users who
// may use that Claude" is added in one place when the authorization seam lands; today's single-owner behaviour is unchanged (docs §20.14).

/** The one user until multi-user: what the routes and the tools pass as `actorId`. */
export const OWNER_ACTOR = 'u_owner';
