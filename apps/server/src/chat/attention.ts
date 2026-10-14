// Sessions stuck on a tool approval (Needs you, docs/prd/attention.md; T-256 item 4): a session in the `waiting` state whose tool request
// has had no answer for ATTENTION_TOOL_WAIT_MS (ten minutes). A fresh request is the session's own card and the glance's; one that has
// waited this long blocks an agent and goes on the list. Class: a gate. Risk: the tool and what it asks, in the controller's own redacted
// summary (never the full text approved on). Who decides: operate on the session (the chat socket's own check when it is answered).

import { ATTENTION_TOOL_WAIT_MS, sessionRef, type AttentionItem } from '@portal/contracts';
import { CHAT_SOCKET_PATH } from '@portal/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { can } from '../authz/seam.js';
import { clip, present, sessionWho, type AttentionSource } from '../attention/registry.js';

interface Row {
  session_id: string;
  request_id: string;
  tool_name: string | null;
  agent_label: string | null;
  title: string;
  created_at: string;
  session_title: string;
  workspace_id: string;
}

export function toolApprovalAttentionSource(db: () => DatabaseSync | null): AttentionSource {
  return {
    kind: 'tool_approval',
    list(actor, now) {
      const d = db();
      if (!d) throw new Error('the database is not available');
      const before = new Date(now - ATTENTION_TOOL_WAIT_MS).toISOString();
      // One query: the open tool requests older than the wait, of sessions that wait.
      const rows = d
        .prepare(
          `SELECT r.session_id, r.request_id, r.tool_name, r.agent_label, r.title, r.created_at, s.title AS session_title, s.workspace_id
           FROM chat_requests r JOIN chat_sessions s ON s.id = r.session_id
           WHERE r.answered_at IS NULL AND r.kind = 'tool' AND s.state = 'waiting' AND r.created_at <= ?
           ORDER BY r.created_at, r.rowid LIMIT 500`,
        )
        .all(before) as unknown as Row[];
      return rows
        .filter((r) => can(actor, 'operate', sessionRef(r.session_id)).allow)
        .map(
          (r): AttentionItem => ({
            kind: 'tool_approval',
            id: `${r.session_id}/${r.request_id}`,
            title: clip(r.title, 80) || `Use ${clip(r.tool_name, 40) || 'a tool'}`,
            who: present([sessionWho(r.session_id, r.session_title), r.agent_label ? { label: clip(r.agent_label, 40), link: null } : null]),
            why: 'gate',
            risk: [clip(r.tool_name, 40) || 'tool', clip(r.workspace_id, 60)].join(' · '),
            since: r.created_at,
            link: `/admin/sessions/${encodeURIComponent(r.session_id)}`,
            action: { label: 'Answer', method: 'SOCKET', path: CHAT_SOCKET_PATH },
          }),
        );
    },
  };
}
