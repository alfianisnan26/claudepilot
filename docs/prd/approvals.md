# Approvals

v0.1 · built on T-2867 (PILOT-1000, slice S4 of PILOT-996) · not deployed.

## What it is

An agent sometimes needs the portal to do something it may not do itself. It asks with the Portal MCP tool `approval_request`.
A person sees the request on a card and allows or denies it. Allow runs the stored payload once, as the portal, and stores the result.
Deny stores the reason. Either way the agent gets a chat message (actor `portal:approval.<id>`).

## Rules

- **Requester.** An agent session (its own session id is recorded) or the portal itself (no session; nobody is messaged).
- **Decider.** Only a signed-in person (`actor.kind === 'user'`). An agent, a token (PAT included) or the system gets the same 404 as for a request that does not exist. There is no allow or deny MCP tool.
- **Once.** Allow claims the row with one conditional `UPDATE … WHERE status='pending' AND expires_at > now`; a second or concurrent Allow gets CONFLICT and the executor runs exactly once.
- **Expiry.** `ttl_minutes` defaults to 1440 and is clamped to 10080. An expired request cannot be allowed or denied; reads show it as `expired`.
- **Immutable.** No route or tool edits a payload; only status, decider, time and result change. (A trigger would be a non-additive migration, so the rule is in code and tested.)
- **No secrets.** A payload or reason holding a secret-shaped value, or a secret-named key (`token`, `password`, …) with a value, is refused at request time. A kind that needs a secret names it. The card masks such values again when it draws them.
- **Size.** Payload at most 4000 bytes, reason at most 500 characters; `approval_request` is rate limited (5 a minute, 30 an hour).

## Kinds

| Kind | Payload | Allow does |
| --- | --- | --- |
| `test.echo` | `{ text }` (≤ 200) | Stores `{ ok: true, output: { text } }`. For tests and trying the flow. |
| `session.bypass` | `{ sessionId }` | Enters Bypass on that session through the same gated path as the Bypass dialog (`enterBypass`): policy, capable session, fresh server code. The person's click is the acknowledgement. Audited as `bypass.entered` with `via: 'approval'` and the `approvalId`. |

`session.bypass`: an agent may ask only for its own session. Before the request is claimed, the person must be able to operate the session and have a fresh server code; without one the call answers `REAUTH_REQUIRED` and the request stays pending (the card asks for the code, then allows). A session that is not capable gets a stored failure (`BYPASS_NOT_CAPABLE`), nothing changes on the session.

## Tier

Every kind is tier `T2` (a person decides). The card shows the tier.

## Surfaces

- **API** (`/api/approvals`, signed in): `GET /`, `GET /:id`, `POST /:id/allow`, `POST /:id/deny { reason? }`.
- **MCP**: `approval_request { kind, payload, reason?, ttl_minutes? }`, `approval_list`, `approval_get { id }`. A session sees only its own requests.
- **Needs you**: attention kind `approval`, one item per pending request (who, kind, tier, expiry). The deck's act opens `/admin/approvals/:id`; it never allows by itself (the deck rule). Web Push comes from the existing attention bridge.
- **Card** (`/admin/approvals/:id`): kind, tier, status, who asked, the agent's reason (its words, untrusted), expiry, the payload as JSON with secrets masked, the result, and Allow and Deny (44 px, phone first, light and dark). Deny takes an optional reason.

## Storage

Migration 883 (additive): table `approvals` (STRICT, CHECKs on kind, status, tier and JSON) and two indexes.
