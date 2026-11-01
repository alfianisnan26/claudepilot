// MCP tool isolation (security near miss 2026-11-01): the Portal MCP twin of memberDoors.ts. A Portal MCP token acts as its person capped by
// its scope; for a person who is not a platform admin (an org member, a guest) the dispatch (`requireToolPolicy`, seam.ts) lets a tool through
// only when what it reaches is decided per person:
//   - `objects`: the one can() on every object the call names (the same NOT_FOUND as a missing one); a call whose checks named NO object
//     (each optional and left out) reaches its handler only when the tool is a door below;
//   - `platform`: the seam refuses anyone who is not a platform admin (the same NOT_FOUND);
//   - `signed-in`, `self`, `agent`: ONLY the doors listed here. Each was read for an unfiltered answer or a founding-user fallback before it was
//     listed; the reason says why it is per person. Every other tool answers a member's token NOT_FOUND, so a new tool is closed to members
//     until someone reads it and lists it (fail closed; authz/mcpToolIsolation.test.ts calls every tool with a member's token).
// Not doors (multi-user.md §22 "not for members yet"): repositories and the approvals queue, though their handlers filter per person.
// The live leak this closes: `workspace_list` (signed-in) answered a member's token with every workspace of every org. A platform admin (the
// founding user, an active admin account) is never held to this list; their answers are filtered by the same visible() in each handler.
// An agent's per-session token (cpst_) is not held to it either: it is boxed to its own workspace and session by can() and by its handler.

/** Tool name → why a member's token may pass this door. Parity rule: no wider than the REST doors (memberDoors.ts) for the same data. */
export const MEMBER_TOOL_DOORS: Readonly<Record<string, string>> = {
  portal_status: 'counts over visible(workspace) and visible(session); targets visible(target) (none for a member); the portal state only with view on platform system',
  workspace_list: 'visible(workspace), as GET /api/workspaces',
  session_list: 'visible(session) on every row, as GET /api/chat/sessions; a named workspace passes view at dispatch',
  autotransfer_events: 'each event passes can(view) on its session (autotransfer/portalTools.ts), as GET /api/autotransfer/events',
  attention_list: 'each source filters by its own can() for this person, as GET /api/attention',
  notify_status: 'the person’s own destinations and preferences (keyed by the token’s user id), as GET /api/notify',
  ci_runs_list: 'each run passes can(view, ci_run), as GET /api/ci/runs',
  deploy_status: 'each run passes can(view, ci_run)',
  ci_validate: 'reads nothing: checks the text it is given',
  ticket_buckets: 'visible(ticket_bucket), as GET /api/tickets/buckets',
  ticket_list: 'the tickets service keeps the buckets the person may view (#viewableBuckets), as GET /api/tickets',
  ticket_timeline: 'each row and its bucket pass view (keep), as GET /api/tickets/timeline',
  ticket_create: 'a named bucket needs operate at dispatch; none named: a bucket the person may file in (FR39 #mayFileIn), else refused',
  ticket_get: 'the tickets service #need: a ticket whose bucket the person may not view is not found; its sessions pass view',
  ticket_attachment_get: 'the tickets service #need (bucket view), like ticket_get',
  ticket_update: 'the tickets service #need (bucket view), then operate on its bucket for a token (#assertTokenOperates); a target bucket needs operate at dispatch',
  ticket_comment: 'the tickets service #need (bucket view), then operate on its bucket for a token (#assertTokenOperates)',
  ticket_attach: 'the tickets service #need (bucket view), then operate on its bucket for a token (#assertTokenOperates)',
  ticket_close: 'the tickets service #need (bucket view), then operate on its bucket for a token (#assertTokenOperates)',
  vault_list: 'the vaults the person may view (CallerScope.canView), as GET /api/knowledge/vaults',
  note_search: 'a vault the person may view only (CallerScope.canView)',
  note_read: 'a vault the person may view only (CallerScope.canView)',
  note_backlinks: 'a vault the person may view only (CallerScope.canView)',
  tag_list: 'a vault the person may view only (CallerScope.canView)',
  graph_neighbours: 'the vaults the person may view only (CallerScope.canView), as GET /api/knowledge/graph',
  graph_query: 'the vaults the person may view only (CallerScope.canView), as GET /api/knowledge/graph',
};

export const isMemberToolDoor = (name: string): boolean => Object.prototype.hasOwnProperty.call(MEMBER_TOOL_DOORS, name);
