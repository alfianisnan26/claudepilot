// A pilot remote's branch that diverged from its upstream (Needs you, docs/prd/attention.md; CI PRD FR8a, T-486): the sync never
// overwrites it, so a person decides (push one onto the other, or reset it by hand). One item per (remote, branch); its risk names both
// shas. Who decides: a PERSON with operate on the remote (the action is a sync now, which settles it once the person fixed the branch);
// the `see` scope shows it to whoever may view the remote, read only.

import { objectRef, type AttentionItem } from '@portal/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { can } from '../authz/seam.js';
import { clip, readsPersonOnly, verbFor, type AttentionSource } from '../attention/registry.js';
import { readState } from './upstream.js';

interface Row {
  id: string;
  name: string;
  workspace_id: string;
  upstream_url: string;
  upstream_state: string;
}

export function upstreamAttentionSource(db: () => DatabaseSync | null): AttentionSource {
  return {
    kind: 'ci_upstream',
    list(actor, _now, scope) {
      const d = db();
      if (!d) throw new Error('the database is not available');
      if (!readsPersonOnly(actor, scope)) return [];
      let rows: Row[];
      try {
        rows = d
          .prepare(
            `SELECT id, name, workspace_id, upstream_url, upstream_state FROM ci_repos
             WHERE removed_at IS NULL AND upstream_url IS NOT NULL AND upstream_state IS NOT NULL ORDER BY created_at, id LIMIT 100`,
          )
          .all() as unknown as Row[];
      } catch {
        // A database from before migration 782: nothing follows an upstream yet.
        return [];
      }
      return rows
        .filter((r) => can(actor, verbFor(scope, 'operate'), objectRef('ci_repo', r.id)).allow)
        .flatMap((r) =>
          readState(r.upstream_state).diverged.map(
            (b): AttentionItem => ({
              kind: 'ci_upstream',
              id: `${r.id}/${b.branch}`,
              title: `${clip(r.name, 40)}: ${clip(b.branch, 60)} diverged from upstream`,
              who: [],
              why: 'question',
              risk: `pilot ${b.local.slice(0, 7)} · upstream ${b.upstream.slice(0, 7)} · ${clip(new URL(r.upstream_url).host, 60)}`,
              since: b.since,
              link: `/admin/ci?tab=remotes&repo=${encodeURIComponent(r.id)}&branch=${encodeURIComponent(b.branch)}`,
              action: { label: 'Sync now', method: 'POST', path: `/api/ci/repos/${encodeURIComponent(r.id)}/sync` },
            }),
          ),
        );
    },
  };
}
