Spawn: MU2 authorization layer (shadow mode) | fable | high | Tier S: default-deny authorization, one decision point, evasion tests | 2026-10-12T06:49Z
# MU2 status (the real authorization layer) - 2026-10-12
FOCUS NOW: writing apps/server/src/authz/{evaluate,store,policy,policy.routes.v0,policy.tools.v0,enforce,tools,audit,admin,testkit,index}.ts, migration 410, qa/crossuser skeleton, tests.
STANDING RULES: git read-only; env -i scratch portal 3283 (prefix mu2-); heavy jobs under flock heavy.lock nice -n 10; no secret in logs/audit/responses; uniform denials.
DECISIONS (so far):
- Appendix A/B are a FALLBACK table consulted only for keys no module declared (`effectivePolicyFor`): a module's declaration always stands, no ordering conflict, the v0 table shrinks as modules take their rows; the enumeration test checks the union and reports v0 rows a module superseded.
- The route key at request time = the last matched route without `*`, preferring a specific method; an `ALL p` entry counts only when declared (sockets, /mcp) or when it is a lone handler (no `ALL p/*`, no method route at p); nothing matched = fall through to the 404 catch-all (uniform with the strict router).
- Legacy identity (PORTAL_IDENTITY=legacy): u_owner is the one active admin; a type WITHOUT a resolver is the owner's (the seam's rule) so the suite passes under enforce; in accounts mode a type without a resolver is denied (not_found, logged once).
- A missing OPTIONAL or ABSENT body/query field is not checked (the handler validates); a present field of the wrong shape fails closed (404). Path/body disagreement: every named object is checked on its own (ANDed).
- Platform `view` is admin-only except area `version` (the pin/canary are facts every workspace runs on; V1 declared them view); any active user holds `view` on `user` objects (the username lookup).
- reauth declarations are enforced only in accounts mode (legacy has no password: the handlers' own code re-auth stays); success-audit rows from declarations are NOT written in v0 (modules write their own; avoids duplicates), only denials are (authz.denied / authz.no_policy, one row per actor+type+minute, no body, no secret).
- Fixed pool types in a path (/api/secrets/:poolId) are checked by id without poolType (ObjectCheck has no literal poolType; the handler's own tables fail for another type).
- REMOVED routes (/api/admin/state, /api/admin/code) are declared platform(registration, manage) until MU12 removes them (never signed-in: the code would reach members).
- Token epochs: `TokenEpochs` dep (epochOf(tokenId)) null until MU7 adds pmcp_tokens.owner_id/token_epoch; agent box = own session, its parent chain (attrs.parentId) or own root (attrs.rootId), own workspace.
RESUME HERE: nothing written yet; next = policy.routes.v0.ts generated from COORD/p5-tools rules, then evaluate.ts + store.ts + tests.
