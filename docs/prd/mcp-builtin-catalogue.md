# PRD: Built-in MCP catalogue

| | |
| --- | --- |
| Status | **Draft v0.2, server built** (2026-10-12). The core is built and was run end to end: contracts, the template registry and its start-up validation, preview and Add, updates, the Portal MCP read tool, migration 100 and the routes (§14). Not built: the catalogue's web UI (B4), the sign-in and "Needs sign-in" status ([MCP set pool](mcpset-pool.md) M2, B3), and an agent-side `mcp_builtin_propose` (decision B1-5). ✅ = observed here (a run, a probe, a test), 📄 = documented, 🔬 = unverified (§16). Provider facts (URLs, OAuth style, scopes, header formats) live in [MCP providers](mcp-providers.md), which owns them and their marks; this PRD only uses them through the templates. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [MCP set pool](mcpset-pool.md) (catalog FR1–FR5a, sets, the compiler §10.2, OAuth §13.3), [Pools foundation](foundation-pools.md) (pool revisions, assignment), [Secrets & env](secrets-env-pool.md) (the names a token slot references, FR21) |
| Related | [MCP providers](mcp-providers.md) (the five definitions and their research), [Portal MCP server](portal-mcp.md) (the read tool, proposals I3), [Settings & policies](settings-policies.md) (allowlist matchers, FR19) |

## 1. Summary

The MCP catalog starts empty: an admin has to know a provider's remote URL, how it signs people in, which
OAuth fields Claude Code needs and which header carries a token, then type it all in. The **built-in
catalogue** ships reviewed templates for GitHub, GitLab, Gitea (the owner's own instance), Outline and
Cloudflare. **Add** turns a template into ordinary catalog entries (approved versions) and a set, after
showing the exact URL, headers and OAuth fields; the admin assigns the set like any other.

**OAuth is preferred.** It is Claude Code's own flow, run in each workspace: the portal never stores,
refreshes or relays a token or a client secret ([MCP set pool](mcpset-pool.md) §6, §13.3). A template offers
OAuth first where the provider supports it without a client secret (dynamic client registration, or a public
PKCE client whose ID is not secret), and a **token** as the fallback: a header filled from a Secrets & env
entry that the set names and the admin creates in Secrets & env (the portal never takes the value).

Nothing is relaxed: the catalog's URL checks, the SSRF guard, immutable approved versions, the FR3 flags, FR19
allowlist matchers and revocation all apply to built-in entries exactly as to manual ones.

## 2. Background and problem

- A catalog entry for a hosted MCP server is five to ten fields that must all be right (URL, transport, auth
  mode, `clientId`, `callbackPort`, scopes, metadata URL, header name and template). Each provider differs, and
  getting one wrong shows up only as a server that never connects.
- The owner runs a Gitea whose MCP server is OAuth-only with no dynamic registration, so Claude Code needs a
  pre-registered public client ID and a fixed callback port; that is the kind of detail a template can carry once.
- Which servers are worth adding is a reviewed decision (FR3). A template is code, written and reviewed by the
  portal's authors, versioned, with the date its facts were last checked against the provider.

## 3. Goals

1. Five templates: GitHub, GitLab, Gitea, Outline, Cloudflare (Cloudflare with several servers to tick).
2. "Add" in one dialog: the mode (OAuth or Token), the few non-secret values (a host, a client ID), the exact
   URL(s) shown first, then a set the admin can assign at once.
3. OAuth first where it works without a client secret; token fallback by Secrets & env **name**.
4. Idempotent: adding twice never duplicates entries or sets. A newer template version can be applied to what
   was added, through new approved catalog versions.
5. An agent or token can read the list; to ask for a server it uses the existing draft proposal (mcpset FR5a). Never add or approve.

## 4. Non-goals

- A new pool kind, a new delivery path or a proxy. Built-ins are catalog entries and mcpset sets.
- Relaying OAuth, storing tokens, client secrets, or a portal-hosted OAuth callback (that is
  [MCP set pool](mcpset-pool.md) §13.3 and the OAuth status work, not this).
- Registering OAuth apps or accounts at a provider for the admin. The templates say how, in a tooltip.
- Third-party templates, a template editor in the UI, or importing templates over the network. Templates are
  code in this repository; a new one is a code change and a review.
- Assigning a set to workspaces automatically.

## 5. Users and stories

| Id | Story |
| --- | --- |
| US1 | As an admin I open the catalog, add GitHub in OAuth mode, see the one URL it will use, add it, and assign the new set to a workspace. The first session there offers the sign-in. |
| US2 | As an admin I add Gitea: the host defaults to our instance, I paste the client ID of the public OAuth app, and I see `Needs sign-in` until a workspace signs in. |
| US3 | As an admin on a provider without secretless OAuth I choose Token, see which Secrets & env entry the set will reference and whether it exists, and add it. |
| US4 | As an admin with Cloudflare I untick the servers I don't want before adding. |
| US5 | As an admin I see "Update" when a template was improved, review the exact change, and apply it; the set gets a new revision on the new approved versions. |
| US6 | As an admin I revoke a built-in version like any other; the workspaces stop getting it, and Add will not silently bring the same definition back. |
| US7 | As an agent (or a token) I list what exists so I don't propose a duplicate, and I may propose a draft with `mcp_propose_entry`; a person reviews it. |

## 6. Scope boundary

| Allowed | Not allowed |
| --- | --- |
| Code-defined templates; non-secret params (hosts, client IDs); secret **names** (`{{secret-file:NAME}}`). | A token, client secret, password or key value anywhere: params, requests, instances, logs, audit. |
| Creating catalog entries and approving their first versions, in the same click that showed the exact URL (§7). | An agent or token adding or approving a built-in. A person in the portal does. |
| Creating a set (pool of type `mcpset`) with the template's servers, and a new revision of it on an update. | Assigning the set to a workspace, or editing a set the admin changed by hand beyond the servers the instance owns. |
| Reading the provider's public metadata during research (B2) and the DNS check of a URL at Add time. | Calling a provider at Add time, or registering a client at a provider. |

## 7. Flow

```
 Catalog page                                  Server                                          Existing pipeline
 ┌──────────────────────┐ GET /api/mcp/builtin ┌────────────────────────────────────────────┐
 │ Built-in shelf       │ ───────────────────▶ │ registry: templates (validated at load)    │
 │  GitHub  GitLab ...  │                      │ + instances (mcp_builtin_instances)        │
 │ [Add] ▸ dialog       │ preview(auth,params) │ plan: substitute params, parse spec+slots, │
 │  OAuth | Token       │ ───────────────────▶ │  SSRF check, flags, secret names           │
 │  params, servers     │ ◀─ exact URLs/flags  │                                            │
 │  [Add]               │ add(same body)       │ add: entries (create/version) → approve    │──▶ catalog (mcp_catalog*, events)
 │                      │ ───────────────────▶ │  note "Built-in catalogue v<N>", Admin     │
 │ Assign ▸ (existing)  │ ◀─ instance, pool    │ set: pools.create / pools.update           │──▶ pools (revisions) ──▶ compiler ──▶ workspaces
 └──────────────────────┘                      └────────────────────────────────────────────┘
```

The **preview is the consent**: the dialog shows each server's exact URL, header names, OAuth fields and
risk flags (FR3) before Add, and Add makes entries with approved versions in the same request (reviewer
`Admin`, note `Built-in catalogue v<N>`). Approval of a *manual* entry stays a separate, ticked review.

## 8. Functional requirements

### Templates

- **FR1** A template is a code-defined `McpBuiltinTemplate` (`packages/contracts/src/mcp.ts`): id, name, one
  line, docs URL, the auth modes it offers in preference order, params, servers, notes for an InfoTip, a
  `version` that bumps when the definition changes, and `checkedAt` (the date its facts were checked). The
  research behind each one is in [MCP providers](mcp-providers.md).
- **FR2** Every template is validated when the server starts: ids and keys (server keys `[a-z0-9-]`, at most 16,
  no Claude Code reserved names, FR5), every `{param}` placeholder resolves to a declared param, each URL
  passes the catalog's URL checks in every mode the server is offered in (with each param's default, else a sample of its
  kind), a template's own URL and its OAuth metadata URL are not plain `http://`, an OAuth server without dynamic
  registration names a required OAuth-only client ID param, token header, template (`{value}` exactly once) and
  slot name follow the catalog's slot rules, `version` is an integer of 1 or more, `checkedAt` is a date, and the
  template's `auth` list matches what its servers offer. A template that fails stops the server from starting
  and names the problem: a mistake in a template is caught in tests, never in front of an admin.
- **FR3** A server with neither `oauth` nor `token` needs no sign-in and is offered in both modes. A server that
  offers only one mode is left out of the other mode, and the dialog says so by not listing it.

### Preview and Add

- **FR4** Preview (`POST /api/mcp/builtin/:id/preview`) changes nothing. For the chosen mode, params and servers
  it returns each server's exact URL, how it signs in (`oauth`, `headers` or `none`), header names (never values), OAuth fields and the catalog's risk flags
  (plain `http://`, a query in the URL, private network allowed), the Secrets & env name each token slot will
  reference with whether a secret of that name that holds a value exists, the set's name, and what Add would do
  (`create`, `update` or `unchanged`).
- **FR5** Params are non-secret and checked before they reach a URL or a field: a `url` param is an http(s)
  address with no credentials, query or fragment (a trailing slash is dropped where a `/` follows its
  placeholder); a `text` param (a client ID) uses letters, digits and `._~@:+=-`, at most 200 characters.
  Anything credential-shaped is refused (`redact`). Params the chosen mode does not use are ignored and not
  stored. Required params without a default must be given.
- **FR6** The URL each server ends up with goes through the catalog's own parse and the SSRF guard
  (`assertPublicUrl`): private, loopback and link-local hosts are refused unless the request carries an explicit
  `allowPrivateNetwork` tick, which sets the entry's flag and is shown in the preview. Cloud metadata
  addresses, Anthropic-hosted connector hosts and this portal's own address are always refused.
- **FR7** Add creates, per selected server, a catalog entry (kind `remote`; key = the template's server key,
  with the instance name added for a named instance and fitted to 16 characters) with one approved version, and
  one set (`mcpset` pool) with those servers: `enabled`, token slots as `{{secret-file:NAME}}` (the suggested
  name, or the one the request gave). Servers are on by default (`default`) and the admin may untick any.
- **FR8** Add is **idempotent**. The same template, mode, params, servers and tick find the instance they made
  and change nothing (`unchanged`). Concurrent adds are serialized. A catalog entry that already exists for a
  built-in instance is reused; a spec that is already in the catalog as an approved version is reused, not
  duplicated.
- **FR9** A definition that was **revoked or deprecated** is never brought back by Add: if the spec Add would
  create equals one that is revoked or deprecated, Add refuses and names it (the admin reviews it in the
  catalog). A draft with that spec waits for its review in the catalog.
- **FR10** Names: the first instance of a template has no label; a further one with different inputs gets 2,
  3, … or the `name` the request gives (`[a-z0-9-]`, at most 12). The label is part of the entry keys and the
  set's name (`Gitea 2`). The set's slug is derived from the template and label and made unique. A catalog key
  that exists and is not from a built-in instance is dodged by the next label when no name was given (a manual entry
  `github` makes the first GitHub instance `github-2`), and a conflict that says to pick another name when one was.

### Updates

- **FR11** `updateAvailable` is true when the template's `version` is higher than the one the instance was made
  at. Add (with `instance`, or with the same inputs) applies it: each entry whose definition changed gets a new
  version that is approved the same way (`Built-in catalogue v<N>`), the set gets a new revision pointing at the
  new versions, and the instance records the new version. Servers the instance does not own, and the `enabled`
  flag of the ones it does, are kept. `Add` with an explicit `instance` or the name of an existing instance
  also changes its inputs (another client ID, another host, more servers).
- **FR12** An updated set is an ordinary edit of a set: it becomes current and reaches assigned workspaces like
  one, and "Upgrade available", "Try in set" and revocation (mcpset FR4, FR13b) work on its entries as on any.

### Surfaces

- **FR13** Routes (§10), all behind the portal's sign-in and Origin checks. An agent token cannot reach them.
- **FR14** Portal MCP: `mcp_builtin_list` (read tier; agents too, like `mcp_catalog_list`) lists the templates (settings, servers,
  how each signs in, notes) and the instances. What a person typed (an instance's label and settings) is labelled as untrusted
  data; an agent sees that an instance exists and how it signs in, not its settings or secret names. It is an adapter over the same
  service as the routes. There is **no** agent-side Add or approve, and no `mcp_builtin_propose` (decision B1-5): an agent asks for
  a server with `mcp_propose_entry` (mcpset FR5a), which makes a draft for a person.
- **FR15** Audit: every Add that makes or changes an instance is a catalog event (`mcp_events`, §17 of the MCP set PRD):
  `builtin_added` and `builtin_updated`, with template, template version, mode, instance, label, set and the server, entry and
  version of each; never a value. The catalog's own events (`entry_created`, `version_created`, `version_approved`) are recorded
  as usual. A refused Add (§10) is only the 409 or 422 the admin sees; it is not logged.
- **FR16** Web, the shelf (`apps/web/src/features/mcp/BuiltinShelf.tsx`), under the portal's text diet (one-or-two-word
  labels, long text behind an ⓘ, no card in a card, phone first): a **Built-in** shelf at the top of the catalog, one flat
  card per template: an inline mark (drawn in the web, no external images), the name with an ⓘ (the template's notes and
  its docs link), one line, and one action. A template with no instance shows **Add**; with instances it shows **+** (Add
  another) and one flat line per instance: the set's name (a link to the set's page), `OAuth` or `Token`, then at most one
  button, **Update** when the template is newer, else **Assign** while no workspace has the set; **Assign…** and **Edit…**
  are always in its menu. The shelf loads again on the live `pools` message. In the Pools hub's MCP tab a **Built-in**
  button (icon and one word) links to it: beside Catalog in the header once there are sets, beside `New MCP set` in the
  empty state before that (one of the two, never both; `MultiPoolUi.headerAction` may be a function of whether the tab has
  pools, and `emptyAction` is the empty state's).
- **FR16a** Web, the dialog (`BuiltinDialog.tsx`): one dialog for Add, Update and Edit (`Add GitHub`, `Update Gitea`,
  `Edit Outline 2`; the notes behind an ⓘ in the title). In order: `OAuth | Token` (OAuth first where offered; not shown
  when only one is), the params the mode asks for as bare labelled fields (the hint behind an ⓘ in the field, defaults
  filled in, `Optional` where not required), **Name** for a further instance (also when the server asks for one), the
  servers (switches with their exact URL, only for a multi-server template; the servers the mode doesn't offer are not
  listed), the exact URL in one copyable line with the catalog's risk flags under it (a single-server template), in Token
  mode the Secrets & env name (editable) with `In Secrets & env` or `Not in Secrets & env yet. Open`, **Allow private
  network** only after the server has refused an address as private (or when the instance has it on), and **Details**
  (collapsed: how it signs in, header names, the OAuth fields it pins). The server's preview of exactly this form runs a
  moment after each change (not shown in the page's activity bar), the primary button waits for it, and the server's
  field errors (`params.<key>`, `secretNames.<slot>`, `servers`, `name`) show under their fields; other refusals (a
  revoked definition, a key that isn't a built-in's) show as one line at the top. A dialog with unsaved changes asks
  before it closes. Nothing is made until Add: the preview is the consent (D2).
- **FR16b** Web, after Add: the dialog says **Added**, **Updated** or **Up to date**, shows the set's name, warns when a
  token's Secrets & env name doesn't exist yet, and offers **Assign…**, which closes it and opens the Pools hub's assign
  dialog (`AssignWorkspacesDialog`, type `mcpset`) for that set. A set made here is an ordinary set: the Pools hub lists it.
- **FR16c** Web, sign-in state and the Sign in dialog (`AuthChip.tsx`, `SignInDialog.tsx`, in the workspace's
  Configuration under MCP sets; the server side is [MCP set pool](mcpset-pool.md) §13.3): in place of "Delivered", each
  delivered OAuth server shows **Connected**, **Needs sign-in**, **Failed** or **Not checked** (Claude Code's own word),
  with one action: **Sign in** (needs sign-in, failed), a check icon (not checked), a sign-out icon with a confirmation
  (connected); all wait for the workspace to run. **Sign in** opens a dialog like the Claude Code sign-in: `1. Open the
  sign-in page` (a link, and a copy button), `2. Paste the address it ends on` (the page it ends on cannot load on the
  person's device: that is expected, and its address is what Claude Code needs), **Done**. The link is only offered for
  an https address (or http on this machine); the pasted address carries a one-time code, goes to the portal in a request
  body once, and the dialog keeps no copy after it is sent. A refused address is explained under the field and can be
  pasted again; an ended or expired sign-in says so and offers **Start again**; closing the dialog ends the sign-in in the
  workspace. It opens over the Configuration sheet, so Escape closes only the top dialog. It signs in the workspace's
  Default Claude (the routes also take `?claude=`).

### UI copy

| Where | Visible text | Behind an ⓘ |
| --- | --- | --- |
| Shelf | `Built-in`; each template's name and one line; `Add` · `+` (aria: `Add another <name>`); in the Pools hub's MCP tab a `Built-in` button | The template's notes and `Docs` |
| Instance line | The set's name, `OAuth` or `Token`; `Update` or `Assign`; menu `Assign…`, `Edit…` | |
| Dialog | `Add <name>` · `Update <name>` · `Edit <set>`; `OAuth` `Token`; the params' labels; `Name`; `Servers`; `URL`; `Secret`; `In Secrets & env` · `Not in Secrets & env yet. Open`; `Allow private network`; `Details`; `Cancel`; `Add` · `Update` · `Added` | A param's hint; a server's description; what a name is for; what the secret is; what the private network tick does |
| After Add | `Added` · `Updated` · `Up to date`; the set's name; `Not in Secrets & env yet: <NAME>. Open`; `Close`, `Assign…` | After assigning, sign in once in each workspace |
| Sign-in state | `Connected`, `Needs sign-in`, `Failed`, `Not checked`; `Sign in`; icons `Check sign-in`, `Sign out` | |
| Sign in dialog | `Sign in · <server>`; `1. Open the sign-in page`; `2. Paste the address it ends on`; `The page won’t load. Copy its address.`; `Starting…`; `Cancel` · `Close`; `Done` · `Try again` · `Start again` | Why the page fails to load, what to copy, and that its one-time code is passed on and not kept |
| Sign out | `Sign out of <server>?` `Sessions in this workspace lose access to it until you sign in again.` `Cancel` `Sign out` | |

**Multi-user** (PLAN-10, light touch): Add, Update and Approve become admin-level acts and assigning a set needs manage rights on the set and the workspace, so the UI never assumes an action is allowed. A 403 from the list, the preview, Add, the sign-in routes or opening a set for assignment shows the portal's own reason instead of failing again on every tap: a banner in the dialog (Add stays off, Sign in offers only Close), the refused actions disabled with the reason on the control and behind an ⓘ by the shelf's title, a muted line where the list itself is refused (`access.ts`, `WithReason.tsx`). The single owner is never refused, so today none of it shows. The catalogue UI stores nothing in the browser, so there are no per-user preferences to key; one added later takes the `userId` prefix (`u_owner` today).

## 9. Data model

Migration 100 (`apps/server/src/store/migrations.ts`), nothing in it secret:

| Column | Meaning |
| --- | --- |
| `id` | Instance id. |
| `template_id`, `template_version` | The template and the version the instance was last made or updated at. |
| `name` | The label (empty for the first instance); unique with `template_id`. |
| `auth` | `oauth` or `token`. |
| `params` | JSON of the non-secret params, as stored (mode-relevant only). |
| `servers` | JSON map: template server key → catalog entry id. |
| `secret_names` | JSON map: token slot → Secrets & env entry name (names only). |
| `allow_private_network` | The explicit tick. |
| `fingerprint` | Hash of mode, params, servers and tick: how Add finds "the same inputs". |
| `pool_id` | The set (`ON DELETE CASCADE`): a set deleted in the Pools hub takes the row with it. Its catalog entries stay (approved versions are never deleted), and the next Add reuses them. |
| `added_at`, `added_by`, `updated_at` | `Admin` while there is one shared sign-in (Q9 of the MCP set PRD). |

## 10. API

| Route | Does |
| --- | --- |
| `GET /api/mcp/builtin` | `McpBuiltinItem[]`: every template with its instances (sets that still exist). |
| `POST /api/mcp/builtin/:id/preview` | `McpBuiltinAddRequest` → `McpBuiltinPreview`. |
| `POST /api/mcp/builtin/:id/add` | `McpBuiltinAddRequest` → `McpBuiltinAddResult` (`created`, `updated` or `unchanged`). |

Errors use the portal's usual shape: 422 `VALIDATION_FAILED` with `details` keyed `auth`, `servers`, `name`,
`params.<key>`, `secretNames.<slot>`; 404 `NOT_FOUND` for an unknown template or instance; 409 `CONFLICT` for a key
that is not a built-in's, a revoked, deprecated or waiting definition, or names that are all taken. Add answers 201 for
`created` and 200 for `updated` and `unchanged`.

## 11. Security requirements

1. No secret value anywhere (§6). Token slots hold `{{secret-file:NAME}}` references only; names are checked
   against the Secrets & env name rules; a param that looks like a credential is refused.
2. Params cannot reshape a URL: no credentials, query or fragment; text params have a closed alphabet; every
   resulting URL goes through the catalog's checks and the SSRF guard (FR6).
3. Only a person (the session guard + Origin check) adds or updates. Agents and tokens can read and propose
   drafts; a draft is never deliverable (mcpset FR5a).
4. No safeguard of the MCP set pool is relaxed: FR3 flags, immutable approved versions, revocation and the FR19
   matchers behave the same for these entries.
5. Template text comes from the repository, but anything a person typed (instance names, params) is shown to
   agents as untrusted data.

## 12. Observability and audit

`mcp_events` rows `builtin_added` and `builtin_updated` (§9 of this PRD lists the fields), plus the catalog's own
events. Nothing else is logged; no request body is.

## 13. Testing and verification

Server tests: the template validator (good and bad definitions), every real template instantiated in each of
its modes with sample params through the catalog's own validation, idempotency, the update path, revoked and
deprecated definitions refused, naming and key fitting, param injection attempts, token slots and secret-name
existence, the compiler output for an assigned built-in (OAuth fields, headers helper), routes, the Portal MCP
tools. Then the portal run on a scratch data directory: list, preview, add in both modes for each template,
add twice, the set in the Pools hub, assignment to a workspace and its compiled files, revocation.

Web tests (`node --test`, `apps/web/src/features/mcp/*.test.ts`): which servers and params each mode offers, the form a
dialog opens with, the request it sends, where the server's 422 details belong, when "Allow private network" is offered,
what the details show, the primary button's label; the sign-in's links (https or this machine only) and how the
answer to a pasted address is read (retry or start again); and which failures count as a refusal for lack of rights (403 only). Then the UI in a real browser (see B4 in §14).

## 14. Rollout and milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| B1 | Contracts, registry and start-up validation, preview and Add (idempotent, updates in place), migration 100, routes, Portal MCP read tool, tests. | **Built.** Files: `packages/contracts/src/mcp.ts` (the `McpBuiltin*` types, `MCP_API.builtin*`), `apps/server/src/mcp/builtin/{template,registry,instantiate,routes,fixtures,templates}.ts`, `catalog.ts` (`findByKey`, `versionsOf`, `check`), `McpSets.builtin`, migration 100, `portalmcp/tools/builtin.ts`. ✅ 27 server tests (`builtin.test.ts`, `tools/builtin.test.ts`): template rules, preview, Add in both modes, idempotency, labels, updates, revoked and deprecated definitions, the SSRF guard, routes, each real template instantiated in each of its modes through the catalog, and a manual entry under each of the nine real server keys left untouched. The full server suite (1,259 tests) passed with them. ✅ Scratch portal (port 3201): all five templates in both modes were previewed and added (201), a second Add answered 200 `unchanged` with the same instance, nine sets appeared in the Pools hub and twelve entries in the catalog, each with one version approved by `Admin` with the note `Built-in catalogue v1`; the pool preview compiled the OAuth set to a `.mcp.json` entry with `clientId`, `callbackPort`, `scopes` (one space-separated string) and `authServerMetadataUrl`, and a token set to a `headersHelper` entry with a server map of parts (`Bearer ` and a secret file name), no value. ✅ A real Docker workspace (image `claudepilot-workspace:latest`, Claude Code 2.1.296, no login) got three of those sets through the portal's own delivery; `claude mcp list` printed `plugin:cpm-cloudflare:cf-api: https://mcp.cloudflare.com/mcp (HTTP) - ! Needs authentication`, `plugin:cpm-cloudflare:cf-docs: https://docs.mcp.cloudflare.com/mcp (HTTP) - ✔ Connected`, `plugin:cpm-gitea:gitea: https://gitea-mcp.konfersi.com/mcp (HTTP) - ! Needs authentication` and, for a token set on a made-up host, `✘ Failed to connect — ENOTFOUND`. Revoking the Gitea version took its plugin folder and its `enabledPlugins` entry out of the workspace, added the deny rule `mcp__plugin_cpm-gitea_gitea__*`, and `claude mcp list` stopped listing it; Add and its preview then answered 409 `Gitea v1 was revoked in the catalog, so Add won’t bring it back. Review it there.` Not done: signing in (B3), the web UI (B4), `mcp_builtin_propose` (B1-5), and the update path against a real portal (covered by tests only: no template has had a second version yet). |
| B2 | The five definitions and the provider research ([MCP providers](mcp-providers.md)). | **Built.** The five definitions pass start-up validation and were run against real Claude Code 2.1.296 with the stand-in provider kit (`mcp/builtin/testkit`); what still needs a real account is listed in that PRD (🔬). |
| B3 | Sign-in status and guided sign-in for OAuth servers ([MCP set pool](mcpset-pool.md) M2). | Owned by that PRD |
| B4 | The catalog's Built-in shelf and Add dialog, the OAuth status chips and the Sign in dialog (FR16, FR16a-c). | **Built.** Files (`apps/web/src/features/mcp/`): `BuiltinShelf.tsx`, `BuiltinDialog.tsx`, `BuiltinIcon.tsx`, `BuiltinNotes.tsx`, `builtin.ts` (the dialog's logic as pure functions), `SignInDialog.tsx`, `signIn.ts`, `AuthChip.tsx`, `useEscapeFirst.ts`, `access.ts`, `WithReason.tsx`; edited `api.ts`, `labels.ts`, `CatalogPage.tsx` (the shelf, a `Servers` label, `Add manually` on phones too), `McpConfiguration.tsx` (the chip in place of Delivered, Sign in, check, Sign out), `tab.tsx` and, surgically, `features/pools/{types,PoolList}.tsx` (the Built-in shortcut in the Pools hub's MCP tab). ✅ 20 web tests (`builtin.test.ts`, `signIn.test.ts`, `access.test.ts`); typecheck and the web build clean. ✅ Looked at in a real browser at 390 and 1280 px, light and dark, on a scratch portal: the shelf (empty, with instances, with an Update), each template's dialog (OAuth and Token, the multi-server Cloudflare, a private address and its tick, a second instance with a Name, Edit and Update, the done step with a missing secret), the assign dialog, the Configuration chips in all four states, the Sign in dialog (starting, ready, a refused paste, success), the sign-out confirmation, Escape over the stacked dialogs. ✅ End to end with a real Claude Code 2.1.296 in a Docker workspace and the stand-in provider: Add Outline (private address ticked) → Assign → delivered → `Needs sign-in` → Sign in → the real redirect address pasted → `Connected` (the portal's log: `sign-in finished`) → Sign out → `Needs sign-in`. Not built: a Sign in button in a chat transcript's "needs sign-in" note (the chat is the chat owner's; `SignInDialog` is reusable for it), a picker for a Claude other than Default, a picker that adds a built-in without leaving the Pools hub (the shortcut opens the catalog page, where the shelf is). |

## 15. Decisions taken for the owner (2026-10-12), provisional

- **D1** OAuth is the native Claude Code flow in each workspace; the portal never holds tokens or client
  secrets. A template offers OAuth first only where it works without a client secret; otherwise token only, and
  it says so.
- **D2** Built-ins are code-defined templates. Add instantiates a template into the catalog with approved
  versions (reviewer Admin, note "Built-in catalogue v<N>") after showing the exact URL; no safeguard relaxed;
  an agent or token can only propose drafts.
- **D3** Per-instance values (a host, a client ID) are non-secret params asked at Add time; several instances of
  one template are allowed.
- **D4** Token slots are referenced as `{{secret-file:NAME}}` with a suggested name; Add shows whether the name
  exists and never takes a value.
- **D5** Gitea is the owner's: defaults point at their instance, every default is overridable.
- **B1-1** Add is an idempotent converge (§8 FR8, FR11); an explicit `instance` or an existing name changes an
  instance in place.
- **B1-2** An identical definition found revoked or deprecated is refused, never silently recreated (FR9).
- **B1-3** `exists` for a token's secret name means a Secrets & env **secret** entry of that name with a stored
  value exists in any set (not that a particular workspace has it).
- **B1-4** The Portal MCP read tool lives in `apps/server/src/portalmcp/tools/builtin.ts`, wired by one line.
- **B1-5** No `mcp_builtin_propose`. The assignment made it optional; a draft made from a template would carry no built-in
  provenance, so a later Add would meet a catalog key that is not a built-in's and make a second copy under a label. An agent
  that wants a server reads `mcp_builtin_list` and proposes with `mcp_propose_entry`; a person adds the built-in.
- **B1-6** Add refuses an `http://` OAuth metadata URL (a template whose metadata URL is built from a param, like Gitea's
  `{baseUrl}/.well-known/openid-configuration`): Claude Code rejects it when it loads the config and the server would silently be
  missing. The message names the param. The template validator refuses a static `http://` there too.

## 16. Open questions

1. 🔬 **Signing in.** A real OAuth sign-in against the owner's Gitea (a public client ID, the fixed callback port) and Cloudflare
   (dynamic registration) needs a real account and is B3's experiment ([MCP set pool](mcpset-pool.md) Q2). What is ✅ here is that
   Claude Code accepts the delivered entries and reports `Needs authentication`.
2. 🔬 **Two sets, one URL.** The compiler refuses the same remote URL from two sets in one workspace (mcpset FR11), so a GitHub
   instance in OAuth mode and another in token mode cannot both be assigned to one workspace. Add does not know about
   workspaces and does not warn; the workspace's MCP status says it.
3. 🔬 **Instances the admin edited.** An update rewrites the servers the instance owns and keeps the rest of the set; an admin who
   pinned an owned server to an older version by hand gets the template's version back on the next update, since the set is
   an edit like any other.
4. **Secret "exists".** It answers for any Secrets & env set, not for a particular workspace: assigning the set to a workspace
   is still the admin's step, and the workspace's status shows `missing_secret` until its sets provide the name.
5. **Refusals are not audited** (FR15); an admin-only route, so the 409 in the dialog is the record.
