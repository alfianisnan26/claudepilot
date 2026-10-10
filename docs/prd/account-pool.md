# PRD: Account Pool

| | |
| --- | --- |
| Status | **Draft v0, skeleton.** Sections marked ⏳ are filled in after the research pass. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-10 |
| Feature area | Portal → Account Pool, Workspaces |

## 1. Summary

Account Pool lets portal admins register Claude API credentials (Anthropic API keys, and custom
Anthropic-compatible hosts), group them into pools, and assign a pool to any number of
workspaces. The portal shows each account's quota and health. When an account is limited or
rejected, the workspaces using it move to the next healthy account in their pool.

Credentials reach Claude Code in each workspace natively: through files that Claude Code itself
reads (its settings and a key helper), kept current by the portal. The portal is not a proxy. It
never sits in the request path and never sees prompts or responses.

## 2. Background and problem

- Each workspace's Claude Code must be signed in by hand from its shell. Nothing is managed
  centrally, keys get pasted into individual containers, and nobody can see who uses which key.
- There is no view of quota. When a key hits a rate limit or spend cap, work in that workspace
  stops until someone notices and swaps the key by hand.
- The portal already manages workspaces on three targets: Docker in the devcontainer (DinD),
  Docker Desktop on the host, and a Kubernetes namespace. Whatever delivers credentials has to
  work on all three, including workspaces that are stopped when a change happens.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Central accounts.** Add, edit, disable and remove accounts of two kinds: an Anthropic API key, or a custom host (base URL + key or token, optional model-name overrides). |
| G2 | **Pools.** Group accounts in priority order. One pool can serve many workspaces. Assigning or changing a workspace's pool never requires recreating the workspace. |
| G3 | **Native delivery.** In an assigned workspace, `claude` is authenticated on first launch with no login prompt, using files Claude Code reads. Works on DinD, host Docker and Kubernetes, and catches up when a stopped workspace starts. |
| G4 | **Quota visibility.** Per account: health, remaining limits and reset times, recent errors, recent usage, as far as the provider exposes them. Unknown is shown as unknown, never as zero. |
| G5 | **Automatic rotation.** When an account is limited, exhausted or rejected, its workspaces switch to the next healthy account without a restart, and switch back once it recovers. Admins can pin a workspace to an account or take an account out of rotation. |
| G6 | **Secrets stay secret.** Encrypted at rest, never returned to the browser in full, never written to logs. |

## 4. Non-goals

- **Claude.ai subscription accounts in pools.** The portal does not offer a Claude.ai login and does
  not collect, store, inject, share or rotate subscription (Free, Pro, Max, Team, Enterprise) OAuth
  credentials or session tokens. See §6.
- **A proxy or gateway in the data path** (9router's model). This is a user requirement, and it also
  keeps the portal out of the availability path for every Claude request.
- **More capacity than the accounts are entitled to.** Keys in the same Anthropic organization share
  that organization's rate limits, so rotating among them adds nothing. Rotation exists to fail over
  across organizations or hosts and to recover from revoked or broken keys.
- Billing, chargeback, or reselling usage.
- Multiple users with different roles. The portal keeps its single shared admin code for now.
- Other agent CLIs (Codex, Gemini CLI and so on).

## 5. Users and stories

**Admin**: runs the portal and manages workspaces and credentials. **Workspace user**: opens a
workspace shell and runs `claude`. Today these are often the same person.

| ID | Story |
| --- | --- |
| US1 | As an admin, I add an Anthropic API key with a name. The portal checks that it works and shows its status. |
| US2 | As an admin, I add a custom host: base URL, token, and optionally which model names to use. |
| US3 | As an admin, I create a pool, order its accounts, and assign it to workspaces, either when creating them or later. |
| US4 | As a workspace user, I open the shell, run `claude`, and it works with no login prompt. |
| US5 | As an admin, I see each account's health and quota: remaining requests and tokens, reset time, recent errors, last used. |
| US6 | When an account hits a limit, the workspaces using it switch to the next healthy account within a bounded time (⏳ target set after research) without restarting, and I can see each switch in an event log. |
| US7 | As an admin, I disable or remove an account, and the workspaces using it move off it straight away. |
| US8 | As a workspace user with my own Claude subscription, I leave my workspace without a pool and run `/login` in it. The portal shows the workspace as "own login" and never touches that login. |
| US9 | As an admin, I unassign a pool. The injected configuration is removed and the workspace falls back to whatever login it has. |

## 6. Scope boundary and compliance

This boundary is a requirement, not a preference. It comes from Anthropic's published terms.

| Allowed | Not allowed |
| --- | --- |
| Storing the organization's own Anthropic API keys and using them in its own workspaces, for its own authorized users, billed to the key owner. | Collecting, storing, or relaying Claude.ai subscription credentials or session tokens. Sign-in to a Claude account must go through Anthropic's own flow. |
| Rotating between API keys or hosts the operator is entitled to use. | Rotating subscription accounts to get past usage limits, or sharing one account's login across people or machines. |
| A user signing in to the unmodified Claude Code CLI with their own subscription, inside their own workspace. | The portal reading, copying, or managing that personal login. |

Sources:
[Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
[Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
[Usage Policy](https://www.anthropic.com/legal/aup),
[API rate limits](https://platform.claude.com/docs/en/api/rate-limits).

What this means for the product:

- The add-account form offers only "Anthropic API key" and "Custom host". There is no
  "Sign in with Claude".
- Workspaces without a pool are left alone. The portal doesn't inspect or show the user's
  personal credentials, only that the workspace isn't managed by a pool.
- If people other than the operator use these workspaces, running Claude Code on hosted
  infrastructure falls under Anthropic's Commercial Terms. Confirming coverage with Anthropic is
  listed in §17.

## 7. Solution overview ⏳

## 8. Functional requirements ⏳

## 9. Data model and storage ⏳

## 10. Delivery to Claude Code, per target ⏳

## 11. Quota monitoring ⏳

## 12. Rotation policy ⏳

## 13. User experience ⏳

## 14. Security requirements

Settled now; details for injection paths and storage are filled in with §9 and §10.

- **At rest:** account secrets are encrypted with AES-256-GCM under a key from
  `PORTAL_SECRET_KEY`. The portal refuses to start the Account Pool feature without that key and
  never stores it next to the data.
- **In the browser:** secrets are write-only. After saving, the UI shows a masked form
  (`sk-ant-…a1b2`) and can replace a secret but never reveal it.
- **In logs and errors:** never include secrets. Error messages from providers are shown with
  any echoed key redacted.
- **Inside workspaces:** whatever Claude Code reads, a user with a shell in that workspace can read
  too. This can't be avoided, because the CLI needs the key. The product therefore treats
  every key in a pool as shared with every user of the workspaces assigned to it, and recommends
  giving each pool its own keys, ideally in a dedicated Anthropic workspace with a spend limit.
- **Injected files** are readable only by the workspace user, and are removed when the pool is
  unassigned.

## 15. Observability and audit ⏳

## 16. Rollout and milestones ⏳

## 17. Success metrics

| Metric | Target |
| --- | --- |
| Time from adding a key to `claude` working in an assigned workspace | under 1 minute |
| Time for a rotation to take effect in running workspaces | ⏳ bound set after research |
| Secrets in API responses, logs or the browser | zero, checked by tests |
| Quota data freshness while a workspace is active | ⏳ set after research |

## 18. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | Will people other than the operator use these workspaces? If yes, confirm Commercial Terms coverage with Anthropic. | Operator |
| Q2 | Where does the portal run in production? Delivery to the remote Kubernetes cluster must not depend on workspaces calling back to a portal they can't reach. | Operator |
| Q3 | Is an Anthropic Admin API key available for organization-level usage and cost reports? | Operator |
| ⏳ | More questions from the research pass. | |
