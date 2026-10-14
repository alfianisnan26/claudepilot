// Skill versions waiting for a person (Needs you, docs/prd/attention.md): every imported or proposed version whose content (its tree
// hash) has no decision yet, `needs_review` in the library. An agent's proposal is the same thing with who asked and why. Class:
// third-party code. Risk: the scan's result (risk level, scripts, network, hooks, how many findings). Who decides: manage on the version.

import { objectRef, type AttentionItem, type SkillRisk } from '@portal/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { can } from '../authz/seam.js';
import { clip, present, whoOf, verbFor, type AttentionSource } from '../attention/registry.js';

interface Row {
  id: string;
  name: string;
  risk: SkillRisk;
  scripted: number;
  findings: string;
  details: string;
  imported_at: string;
  source_label: string | null;
  actor: string | null;
  proposed_at: string | null;
  session_title: string | null;
}

const json = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** The scan's result in one line. */
export function skillRisk(r: Pick<Row, 'risk' | 'scripted' | 'findings' | 'details'>): string {
  const d = json<{ network?: boolean; hooks?: boolean; allowedTools?: boolean }>(r.details, {});
  const findings = json<unknown[]>(r.findings, []);
  const n = Array.isArray(findings) ? findings.length : 0;
  return [
    `${r.risk} risk`,
    r.scripted ? 'scripts' : 'text only',
    d.network ? 'network' : null,
    d.hooks ? 'hooks' : null,
    d.allowedTools ? 'pre-allowed tools' : null,
    n ? `${n} finding${n === 1 ? '' : 's'}` : 'no findings',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function skillAttentionSource(db: () => DatabaseSync | null): AttentionSource {
  return {
    kind: 'skill_version',
    list(actor, _now, scope) {
      const d = db();
      if (!d) throw new Error('the database is not available');
      // One query: versions whose content has no decision (any decision ends the wait), their source, the proposal and its session.
      const rows = d
        .prepare(
          `SELECT v.id, v.name, v.risk, v.scripted, v.findings, v.details, v.imported_at, src.label AS source_label,
                  p.actor, p.proposed_at, s.title AS session_title
           FROM skill_versions v
           LEFT JOIN skill_sources src ON src.id = v.source_id
           LEFT JOIN skill_proposals p ON p.version_id = v.id
           LEFT JOIN chat_sessions s ON p.actor LIKE 'session:%' AND s.id = substr(p.actor, 9)
           WHERE NOT EXISTS (SELECT 1 FROM skill_reviews r WHERE r.tree_hash = v.tree_hash)
           ORDER BY coalesce(p.proposed_at, v.imported_at), v.id LIMIT 500`,
        )
        .all() as unknown as Row[];
      return rows
        .filter((r) => can(actor, verbFor(scope, 'manage'), objectRef('skill_version', r.id)).allow)
        .map(
          (r): AttentionItem => ({
            kind: 'skill_version',
            id: r.id,
            title: clip(r.name, 80),
            who: present([r.actor ? whoOf(r.actor, r.session_title) : r.source_label ? { label: clip(r.source_label, 60), link: null } : null]),
            why: 'third_party_code',
            risk: skillRisk(r),
            since: r.proposed_at ?? r.imported_at,
            link: `/admin/pools/skills/review/${encodeURIComponent(r.id)}`,
            action: { label: 'Review', method: 'POST', path: `/api/skills/versions/${encodeURIComponent(r.id)}/review` },
          }),
        );
    },
  };
}
