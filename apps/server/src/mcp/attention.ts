// MCP catalog versions waiting for a person (Needs you, docs/prd/attention.md): a version an agent or a token PROPOSED that nobody has
// reviewed yet (`draft` with `proposed_by`: the catalog's own "to review" count). A person's own manual draft is their work in progress,
// not something waiting on them. Class: third-party code. Risk: kind, host or package, private network yes or no, the secret slots by NAME
// (a slot's value never exists here). Who decides: manage on the entry (the approve route's level), through the seam.

import { objectRef, type AttentionItem, type McpEntryKind, type McpSlot, type McpVersionSpec } from '@portal/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { can } from '../authz/seam.js';
import { clip, present, whoOf, verbFor, type AttentionSource } from '../attention/registry.js';

interface Row {
  id: string;
  entry_id: string;
  version: string;
  spec: string;
  slots: string;
  proposed_by: string;
  proposed_at: string | null;
  created_at: string;
  display_name: string;
  kind: McpEntryKind;
  session_title: string | null;
}

const json = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** Where it runs or connects, in a word: the remote's host, the package, the command's path. */
function place(kind: McpEntryKind, spec: McpVersionSpec): string {
  if (kind === 'remote') {
    try {
      return new URL(spec.url ?? '').host || 'no host';
    } catch {
      return 'no host';
    }
  }
  return clip(kind === 'command' ? spec.path : spec.package, 60) || kind;
}

/** The one risk line: names and facts only. */
export function mcpRisk(kind: McpEntryKind, spec: McpVersionSpec, slots: McpSlot[]): string {
  const secrets = slots.filter((s) => s.secret).map((s) => clip(s.name, 40));
  return [
    kind,
    place(kind, spec),
    kind === 'remote' ? `private network ${spec.allowPrivateNetwork ? 'yes' : 'no'}` : null,
    kind === 'npm' && spec.allowScripts ? 'install scripts on' : null,
    secrets.length ? `secrets: ${secrets.join(', ')}` : 'no secrets',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function mcpAttentionSource(db: () => DatabaseSync | null): AttentionSource {
  return {
    kind: 'mcp_version',
    list(actor, _now, scope) {
      const d = db();
      if (!d) throw new Error('the database is not available');
      // One query: the waiting versions, their entry and (for an agent's proposal) its session's title.
      const rows = d
        .prepare(
          `SELECT v.id, v.entry_id, v.version, v.spec, v.slots, v.proposed_by, v.proposed_at, v.created_at, e.display_name, e.kind, s.title AS session_title
           FROM mcp_catalog_versions v JOIN mcp_catalog e ON e.id = v.entry_id
           LEFT JOIN chat_sessions s ON v.proposed_by LIKE 'session:%' AND s.id = substr(v.proposed_by, 9)
           WHERE v.review_state = 'draft' AND v.proposed_by IS NOT NULL
           ORDER BY coalesce(v.proposed_at, v.created_at), v.id LIMIT 500`,
        )
        .all() as unknown as Row[];
      return rows
        .filter((r) => can(actor, verbFor(scope, 'manage'), objectRef('mcp_entry', r.entry_id)).allow)
        .map(
          (r): AttentionItem => ({
            kind: 'mcp_version',
            id: r.id,
            title: `${clip(r.display_name, 80)} ${clip(r.version, 30)}`,
            who: present([whoOf(r.proposed_by, r.session_title)]),
            why: 'third_party_code',
            risk: mcpRisk(r.kind, json<McpVersionSpec>(r.spec, {}), json<McpSlot[]>(r.slots, [])),
            since: r.proposed_at ?? r.created_at,
            link: `/admin/pools/mcp/catalog/${encodeURIComponent(r.entry_id)}?version=${encodeURIComponent(r.id)}`,
            action: { label: 'Review', method: 'POST', path: `/api/mcp/catalog/${encodeURIComponent(r.entry_id)}/versions/${encodeURIComponent(r.id)}/approve` },
          }),
        );
    },
  };
}
