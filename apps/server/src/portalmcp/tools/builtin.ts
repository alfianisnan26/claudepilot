import { z } from 'zod';
import { portalTools, type ToolRegistry } from '../registry.js';
import type { PortalToolDeps } from './deps.js';

/**
 * The built-in MCP catalogue (docs/prd/mcp-builtin-catalogue.md FR14): what exists and what an admin has added, so an
 * agent or a token doesn't propose a server twice and knows how each one signs in. Read-only: adding or updating a
 * built-in is a person's step in the portal (preview, then Add), and an agent's only way to ask for a server is
 * `mcp_propose_entry`, which makes a draft for a person to review.
 */
export function registerBuiltinTools(deps: PortalToolDeps, registry: ToolRegistry = portalTools): void {
  const builtin = deps.mcp?.builtin;
  if (!builtin) return;

  registry.register({
    name: 'mcp_builtin_list',
    title: 'List the built-in MCP servers',
    description:
      'The portal’s built-in MCP catalogue: reviewed templates (GitHub, GitLab, Gitea, Outline, Cloudflare), how each signs in (OAuth in the workspace, or a token from Secrets & env), the settings each asks for, and the instances an admin has added as MCP sets. Read-only: adding one is a person’s step in the portal.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({ id: z.string().max(40).optional().describe('One template, like gitea.') }),
    handler(ctx, args) {
      const items = builtin.list().filter((i) => !args.id || i.template.id === args.id);
      const added = items.reduce((n, i) => n + i.added.length, 0);
      return {
        summary: `${items.length} built-in server${items.length === 1 ? '' : 's'}, ${added} added.`,
        templates: items.map(({ template: t, added: instances }) => ({
          id: t.id,
          name: t.name,
          summary: t.summary,
          doc_url: t.docUrl,
          auth: t.auth,
          version: t.version,
          checked_at: t.checkedAt,
          settings: t.params.map((p) => ({ key: p.key, label: p.label, kind: p.kind, required: p.required, default: p.default ?? null, only_for: p.auth ?? null })),
          servers: t.servers.map((s) => ({
            key: s.key,
            name: s.name,
            url: s.url,
            transport: s.transport,
            on_by_default: s.default,
            sign_in: [...(s.oauth ? ['oauth'] : []), ...(s.token ? ['token'] : [])],
          })),
          notes: t.notes,
          // What a person typed (an instance's label and settings) is data. An agent sees that an instance exists and how it signs in, not its settings.
          added: instances.map((a) => ({
            id: a.id,
            name: ctx.untrusted(a.name, 'builtin:admin') ?? null,
            set_id: a.poolId,
            set_name: ctx.untrusted(a.poolName, 'builtin:admin'),
            auth: a.auth,
            servers: a.servers,
            template_version: a.templateVersion,
            update_available: a.updateAvailable,
            added_at: a.addedAt,
            ...(ctx.isAgent
              ? {}
              : {
                  settings: Object.fromEntries(Object.entries(a.params).map(([k, v]) => [k, ctx.untrusted(v, 'builtin:admin')])),
                  secret_names: a.secretNames,
                }),
          })),
        })),
        note: 'Adding or updating a built-in is done in the portal by a person. To ask for a server, propose it with mcp_propose_entry: it is a draft until a person approves it.',
      };
    },
  });
}
