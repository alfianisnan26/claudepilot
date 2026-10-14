// Chats left down (Needs you, docs/prd/attention.md; T-257 item 1): a chat with Keep going on that the sweep reported `down` (the cap, a
// refused start, still ended 15 minutes after it ended) and that has not run again since. The report itself is Keep going's (one ticket, one
// notification); this lists it until the chat runs again (the next look clears the report). Class: a question, a person decides how to bring
// it back. Who decides: operate on the chat (the module's own `can()`); the item opens the chat, whose page recovers or continues it.

import { CHAT_API, sessionRef, type AttentionItem } from '@portal/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { can } from '../authz/seam.js';
import { clip, present, sessionWho, ticketWho, verbFor, type AttentionSource } from '../attention/registry.js';

interface Row {
  session_id: string;
  since: string;
  ticket_id: string | null;
  session_title: string | null;
  workspace_id: string | null;
}

export function keepGoingAttentionSource(db: () => DatabaseSync | null): AttentionSource {
  return {
    kind: 'keepgoing_down',
    list(actor, _now, scope) {
      const d = db();
      if (!d) throw new Error('the database is not available');
      // One query: the standing `down` reports of chats whose policy is on, with the chat's title and workspace when the chat still exists.
      const rows = d
        .prepare(
          `SELECT r.session_id, r.since, r.ticket_id, s.title AS session_title, s.workspace_id
           FROM keepgoing_reports r JOIN keepgoing_policies p ON p.session_id = r.session_id LEFT JOIN chat_sessions s ON s.id = r.session_id
           WHERE r.cause = 'down' AND r.cleared_at IS NULL AND p.enabled = 1
           ORDER BY r.since, r.session_id LIMIT 500`,
        )
        .all() as unknown as Row[];
      return rows
        .filter((r) => can(actor, verbFor(scope, 'operate'), sessionRef(r.session_id)).allow)
        .map(
          (r): AttentionItem => ({
            kind: 'keepgoing_down',
            id: r.session_id,
            title: `${clip(r.session_title, 60) || 'A chat'}: left down`,
            who: present([sessionWho(r.session_id, r.session_title), ticketWho(r.ticket_id)]),
            why: 'question',
            risk: ['ended', clip(r.workspace_id, 60)].filter(Boolean).join(' · '),
            since: r.since,
            link: `/admin/sessions/${encodeURIComponent(r.session_id)}`,
            action: { label: 'Open', method: 'POST', path: CHAT_API.recover(r.session_id) },
          }),
        );
    },
  };
}
