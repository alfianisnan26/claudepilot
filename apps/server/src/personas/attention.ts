// Persona proposals waiting for a person (Needs you, docs/prd/attention.md, T-146 slice 3; Persona PRD I11): what a session asked to change
// about its own persona (its instructions, name or avatar) and nobody has decided yet. Instructions are never approved by themselves, so a
// pending one always waits on a person; a name or an avatar waits only when the persona's own switch does not let it through. Class: a gate
// (only a person may change what agents are told). Risk: what would change, the persona, the revision it was made against, the workspace.
// Who decides: a person (the decide route is a signed-in person's, `POST /api/personas/proposals/:id/approve`) with manage on the persona.
// Read only, next to the module and without touching its service: one query on persona_proposals.

import { objectRef, type AttentionItem, type PersonaProposalKind } from '@portal/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { can } from '../authz/seam.js';
import { clip, present, readsPersonOnly, sessionWho, verbFor, type AttentionSource } from '../attention/registry.js';

interface Row {
  id: string;
  pool_id: string;
  kind: PersonaProposalKind;
  workspace_id: string;
  session_id: string;
  payload: string;
  base_revision: number | null;
  created_at: string;
  pool_name: string;
  session_title: string | null;
}

const WHAT: Record<PersonaProposalKind, string> = { instructions: 'new instructions', name: 'a new name', avatar: 'a new avatar' };

/** How big an instructions change is, in facts: `adds 120 chars, 2 replacements`. Never the text itself (it is the agent's). */
export function instructionsSize(payload: string): string {
  let edits: { append?: unknown; replace?: unknown } = {};
  try {
    const p = JSON.parse(payload) as { edits?: typeof edits };
    edits = p.edits && typeof p.edits === 'object' ? p.edits : {};
  } catch {
    // an unreadable payload says nothing
  }
  const parts: string[] = [];
  if (typeof edits.append === 'string' && edits.append.length) parts.push(`adds ${edits.append.length} chars`);
  const n = Array.isArray(edits.replace) ? edits.replace.length : 0;
  if (n) parts.push(`${n} replacement${n === 1 ? '' : 's'}`);
  return parts.join(', ') || 'no edits read';
}

export function personaAttentionSource(db: () => DatabaseSync | null): AttentionSource {
  return {
    kind: 'persona_proposal',
    list(actor, _now, scope) {
      const d = db();
      if (!d) throw new Error('the database is not available');
      if (!readsPersonOnly(actor, scope)) return [];
      // One query: the pending proposals, with the persona's name and the asking session's title.
      const rows = d
        .prepare(
          `SELECT pp.id, pp.pool_id, pp.kind, pp.workspace_id, pp.session_id, pp.payload, pp.base_revision, pp.created_at,
                  p.name AS pool_name, s.title AS session_title
           FROM persona_proposals pp JOIN pools p ON p.id = pp.pool_id
           LEFT JOIN chat_sessions s ON s.id = pp.session_id
           WHERE pp.status = 'pending'
           ORDER BY pp.created_at, pp.id LIMIT 500`,
        )
        .all() as unknown as Row[];
      return rows
        .filter((r) => can(actor, verbFor(scope, 'manage'), objectRef('pool', r.pool_id, 'persona')).allow)
        .map(
          (r): AttentionItem => ({
            kind: 'persona_proposal',
            id: r.id,
            title: `${clip(r.pool_name, 60)}: ${WHAT[r.kind] ?? clip(r.kind, 20)}`,
            who: present([sessionWho(r.session_id, r.session_title)]),
            why: 'gate',
            risk: [
              r.kind,
              r.kind === 'instructions' ? instructionsSize(r.payload) : null,
              r.base_revision !== null ? `against revision ${r.base_revision}` : null,
              clip(r.workspace_id, 60),
            ]
              .filter(Boolean)
              .join(' · '),
            since: r.created_at,
            link: `/admin/pools?tab=personas&proposal=${encodeURIComponent(r.id)}`,
            action: { label: 'Review', method: 'POST', path: `/api/personas/proposals/${encodeURIComponent(r.id)}/approve` },
          }),
        );
    },
  };
}
