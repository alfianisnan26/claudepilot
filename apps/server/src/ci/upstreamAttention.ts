// A pilot remote's upstream sync that needs a person (Needs you, docs/prd/attention.md; CI PRD FR8a, T-486):
// - a branch that diverged from its upstream: the sync never overwrites it, so a person decides (push one onto the other, or reset it by
//   hand). One item per (remote, branch); its risk names both shas.
// - (S2) a sync that fails (a fetch error, a timeout, a refused host, a bad token): one item per remote, from the first failure of a row,
//   naming the remote and a short reason. It goes when a sync works again. The reason is text from a workspace: it is redacted again here
//   (chat/redact.ts), and any user or password in a URL in it is dropped, whatever the sync stored.
// Who decides: a PERSON with operate on the remote (the action is a sync now, which settles it once the cause is fixed); the `see` scope
// shows it to whoever may view the remote, read only.

import { objectRef, type AttentionItem } from '@portal/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { can } from '../authz/seam.js';
import { redact } from '../chat/redact.js';
import { clip, readsPersonOnly, verbFor, type AttentionSource } from '../attention/registry.js';
import { redactSecrets } from './text.js';
import { readState, withoutUserinfo } from './upstream.js';

interface Row {
  id: string;
  name: string;
  workspace_id: string;
  default_branch: string;
  upstream_url: string;
  upstream_state: string;
}

/** A failed sync's reason as an item shows it: one line, redacted twice, no credentials in a URL, at most 120 characters. */
export function syncReason(error: string): string {
  const line = redact(redactSecrets(error)).replace(/\s+/g, ' ').trim();
  // `scheme://user:pass@host` and `scheme://token@host`: the part before the @ goes.
  return clip(withoutUserinfo(line), 120);
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
            `SELECT id, name, workspace_id, default_branch, upstream_url, upstream_state FROM ci_repos
             WHERE removed_at IS NULL AND upstream_url IS NOT NULL AND upstream_state IS NOT NULL ORDER BY created_at, id LIMIT 100`,
          )
          .all() as unknown as Row[];
      } catch {
        // A database from before migration 782: nothing follows an upstream yet.
        return [];
      }
      return rows
        .filter((r) => can(actor, verbFor(scope, 'operate'), objectRef('ci_repo', r.id)).allow)
        .flatMap((r) => {
          const s = readState(r.upstream_state);
          const host = clip(new URL(r.upstream_url).host, 60);
          const action = { label: 'Sync now', method: 'POST' as const, path: `/api/ci/repos/${encodeURIComponent(r.id)}/sync` };
          const failed: AttentionItem[] = s.error
            ? [
                {
                  kind: 'ci_upstream',
                  // `:` never appears in a branch name, so this id never meets a diverged branch's.
                  id: `${r.id}:sync`,
                  title: `${clip(r.name, 40)}: upstream sync failed`,
                  who: [],
                  why: 'question',
                  // A failed fetch moves no branch: every branch waits, the default one included.
                  risk: `${syncReason(s.error)} · every branch (${clip(r.default_branch, 60)} too) · ${host}`,
                  since: s.errorSince ?? s.at ?? new Date(0).toISOString(),
                  link: `/admin/ci?tab=remotes&repo=${encodeURIComponent(r.id)}`,
                  action,
                },
              ]
            : [];
          return [
            ...failed,
            ...s.diverged.map(
              (b): AttentionItem => ({
                kind: 'ci_upstream',
                id: `${r.id}/${b.branch}`,
                title: `${clip(r.name, 40)}: ${clip(b.branch, 60)} diverged from upstream`,
                who: [],
                why: 'question',
                risk: `pilot ${b.local.slice(0, 7)} · upstream ${b.upstream.slice(0, 7)} · ${host}`,
                since: b.since,
                link: `/admin/ci?tab=remotes&repo=${encodeURIComponent(r.id)}&branch=${encodeURIComponent(b.branch)}`,
                action,
              }),
            ),
          ];
        });
    },
  };
}
