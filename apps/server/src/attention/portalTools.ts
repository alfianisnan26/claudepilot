// Needs you on the Portal MCP (docs/prd/attention.md, T-146 slice 2): `attention_list`, READ ONLY. An agent sees what blocks it and says so
// on its ticket; nothing here approves, rejects or snoozes (the walls: deciding is a person's, on each module's own route).
//
// Authorization: the registry is read with the token's own actor, and every source keeps only what that actor may decide through its
// module's `can()`. An agent's token therefore sees its own session's stuck tool approvals and nothing a person alone decides (deploys,
// approval tickets); an admin's token sees what its scope reaches. One `item` that the caller does not see is the same NOT_FOUND as one
// that does not exist. Results are short rows by default (T-282); `full: true` gives the whole item as the HTTP route does.

import { AppError } from '@isnanme/core';
import { ATTENTION_KINDS, attentionDeckPath, attentionItemKey, type AttentionItem } from '@portal/contracts';
import { actorOfPrincipal, declareToolPolicies } from '../authz/seam.js';
import { fullInput } from '../portalmcp/compact.js';
import { portalTools, z, type PortalToolContext, type ToolRegistry } from '../portalmcp/registry.js';
import type { AttentionRegistry } from './registry.js';

export function registerAttentionTools(attention: AttentionRegistry, registry: ToolRegistry = portalTools): void {
  // The registry filters by the caller's rights itself (each source's own can()); the tool decides nothing.
  declareToolPolicies('attention', { attention_list: { kind: 'signed-in' } });

  const row = (ctx: PortalToolContext, i: AttentionItem) => ({
    item: attentionItemKey(i),
    kind: i.kind,
    why: i.why,
    title: ctx.untrusted(i.title, 'attention', 120),
    since: i.since,
    link: attentionDeckPath(i),
  });
  const whole = (ctx: PortalToolContext, i: AttentionItem) => ({
    ...row(ctx, i),
    id: i.id,
    title: ctx.untrusted(i.title, 'attention', 300),
    who: i.who.map((w) => ({ label: ctx.untrusted(w.label, 'attention', 80), link: w.link })),
    risk: ctx.untrusted(i.risk, 'attention', 300),
    page: i.link,
    action: i.action.label,
  });

  registry.register({
    name: 'attention_list',
    title: 'What waits for a person',
    description:
      'Needs you: what waits for a person to decide (MCP and skill versions to review, deploys to approve, approval tickets, tool approvals stuck ten minutes or more), oldest first within each reason, as short rows (item, kind, why, title, since, link); full true for who asked, the risk line and the page. ' +
      'You see only what your token may see: an agent sees its own session\'s stuck approvals. Read only: you can not approve anything; tell the person on your ticket and give the link. `item` (kind:id) returns one.',
    scope: 'agent',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      kind: z.enum(ATTENTION_KINDS).optional(),
      item: z.string().max(240).optional().describe('One item, as `item` in a row (kind:id).'),
      limit: z.number().int().min(1).max(100).optional(),
      ...fullInput,
    }),
    handler(ctx, args) {
      const actor = actorOfPrincipal(ctx.principal);
      const list = attention.list(actor, { kind: args.kind ?? null, limit: args.item ? 200 : (args.limit ?? 30) });
      const view = (i: AttentionItem) => (args.full ? whole(ctx, i) : row(ctx, i));
      if (args.item) {
        const found = list.items.find((i) => attentionItemKey(i) === args.item);
        // Not visible and not there are one answer.
        if (!found) throw new AppError('NOT_FOUND', 'No such item.');
        return { summary: `${found.kind}: waiting since ${found.since}`, item: view(found) };
      }
      const counts = Object.fromEntries(Object.entries(list.counts).filter(([, n]) => n !== 0));
      return {
        summary: list.total ? `${list.total} waiting for a person${list.items.length < list.total ? `, ${list.items.length} shown` : ''}` : 'Nothing waits for a person that you can see.',
        counts,
        unavailable: list.unavailable,
        items: list.items.map(view),
      };
    },
  });
}
