import type { McpProposalRequest } from '@portal/contracts';
import { z } from 'zod';
import { paginate, pageInput } from '../paging.js';
import { registerPortalTool } from '../registry.js';
import { cleanText } from '../sanitize.js';
import { uiLink } from './common.js';
import type { PortalToolDeps } from './deps.js';

/**
 * The global "add MCP" flow (interface I3): an agent or a token can only PROPOSE an MCP server. The proposal
 * lands in the catalog as a draft waiting for review; a person approves it in the portal (MCP set pool
 * review gate) before any set can use it or any workspace can get it. Nothing here approves anything.
 */
export function registerCatalogTools(deps: PortalToolDeps): void {
  const mcp = deps.mcp;
  if (!mcp) return;

  const slot = z
    .object({
      name: z.string().min(1).max(80).describe('The variable (env, path) or header name the server needs.'),
      target: z.enum(['env', 'header', 'path']).optional().describe('Default env.'),
      secret: z.boolean().optional().describe('True for a credential. Only its NAME is recorded: a person gives the value in the portal.'),
      required: z.boolean().optional(),
      description: z.string().max(300).optional(),
      docUrl: z.string().max(300).optional(),
      default: z.string().max(200).optional().describe('A default for a non-secret slot.'),
      template: z.string().max(100).optional().describe('Header slots: the value around the placeholder, e.g. `Bearer {value}`.'),
    })
    .strict();

  registerPortalTool({
    name: 'mcp_propose_entry',
    title: 'Propose an MCP server for the catalog',
    description:
      'Proposes an MCP server for the portal’s global catalog (npm package at an exact version, a remote URL, or a command already in the workspace image). It is saved as a draft waiting for review: nothing can use it until a person approves it in the portal. Name the secrets it needs as slots; never include a secret value.',
    scope: 'agent',
    // A proposal fills a review queue: a looping or injected agent is stopped early (the draft is capped by the catalog, too).
    rate: { perHour: 10 },
    maxArgsBytes: 16 * 1024,
    input: z.object({
      key: z.string().min(1).max(16).regex(/^[a-z0-9-]+$/, 'Lowercase letters, digits and dashes.').describe('A short key for tool names, e.g. linear.'),
      display_name: z.string().min(1).max(80),
      description: z.string().max(500).optional(),
      kind: z.enum(['npm', 'pypi', 'remote', 'command']),
      version: z.string().max(40).optional().describe('npm and PyPI: the exact package version (no ranges, no latest).'),
      spec: z
        .object({
          package: z.string().max(214).optional(),
          bin: z.string().max(100).optional(),
          args: z.array(z.string().max(300)).max(30).optional().describe('Fixed arguments. Never secrets: they show in process listings.'),
          path: z.string().max(300).optional().describe('command: an absolute path already in the workspace image.'),
          url: z.string().max(500).optional().describe('remote: the server’s HTTPS URL.'),
          transport: z.enum(['http', 'sse']).optional(),
          auth: z.enum(['none', 'headers', 'oauth']).optional(),
        })
        .strict(),
      slots: z.array(slot).max(20).optional(),
      reason: z.string().max(500).optional().describe('Why it is wanted, in a sentence or two. The reviewer reads it as plain text.'),
    }),
    async handler(ctx, args) {
      const from = ctx.isAgent ? `by an agent (session ${ctx.sessionId}) in workspace ${ctx.workspaceId}` : `over MCP by token “${cleanText(ctx.principal.label, 60)}”`;
      // The portal states where the proposal came from; the agent's own words come after it and can't pass for it.
      const reason = `[proposed ${from}] ${args.reason ?? ''}`.trim().slice(0, 700);
      const req: Partial<McpProposalRequest> = {
        key: args.key,
        displayName: args.display_name,
        description: args.description,
        kind: args.kind,
        version: args.version,
        spec: args.spec,
        slots: args.slots,
        reason,
      };
      const r = await mcp.proposeEntry(ctx.actor, req);
      ctx.affected(`mcp-entry:${r.entryId}`);
      return {
        summary: r.duplicate ? `You already proposed this; it is still waiting for review.` : `Proposed ${r.key} ${r.version}: waiting for a person to review it.`,
        proposal: { entry_id: r.entryId, version_id: r.versionId, key: r.key, version: r.version, status: r.status, new_entry: r.newEntry, duplicate: r.duplicate, review_path: r.reviewPath, review_url: uiLink(r.reviewPath) },
        note: 'It is a draft. A person must approve it in the portal before any workspace can use it, and must give any secret it needs there.',
      };
    },
  });

  registerPortalTool({
    name: 'mcp_proposal_withdraw',
    title: 'Withdraw an MCP server proposal',
    description: 'Takes back a proposal this token made, while it still waits for review.',
    scope: 'agent',
    hints: { idempotent: true },
    input: z.object({ version_id: z.string().max(80).describe('From mcp_propose_entry.') }),
    handler(ctx, args) {
      mcp.withdrawProposal(ctx.actor, args.version_id);
      ctx.affected(`mcp-version:${args.version_id}`);
      return { summary: 'Withdrawn.', withdrawn: true };
    },
  });

  registerPortalTool({
    name: 'mcp_catalog_list',
    title: 'List the MCP catalog',
    description: 'The portal’s catalog of MCP servers: key, kind and each version’s review state, so a server is not proposed twice. Descriptions are imported text and labelled untrusted.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({ query: z.string().max(60).optional().describe('Part of a key or name.'), ...pageInput }),
    handler(ctx, args) {
      const all = mcp.catalog
        .list()
        .filter((e) => !args.query || e.key.includes(args.query.toLowerCase()) || e.displayName.toLowerCase().includes(args.query.toLowerCase()));
      const page = paginate(all, args, { q: args.query });
      return {
        summary: `${page.total} catalog entries.`,
        entries: page.items.map((e) => ({
          id: e.id,
          key: e.key,
          name: e.displayName,
          kind: e.kind,
          description: ctx.untrusted(e.description, 'imported'),
          versions: e.versions.map((v) => ({ version: v.version, state: v.reviewState, proposed_by: v.proposal?.by ?? null })),
        })),
        total: page.total,
        next_cursor: page.next_cursor,
      };
    },
  });
}
