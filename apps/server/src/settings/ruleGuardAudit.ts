import { ChatStore } from '../chat/store.js';
import type { OutboxEvent } from '../delivery/outbox.js';
import type { Store } from '../store/store.js';

/** The outbox channel the rule-file guard writes (`~/.claudepilot/outbox/guard.jsonl`, `ruleGuard.ts`). */
export const GUARD_CHANNEL = 'guard';

const text = (v: unknown, max: number, re?: RegExp) => (typeof v === 'string' && (!re || re.test(v)) ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, max) : null);

/**
 * Each refusal of the rule-file guard (D-60, T-404) becomes one audit row, `guard.refused`: the workspace, the portal chat
 * session the Claude Code session belongs to (when the portal ran it), the tool, the form and the path. Never content: the
 * guard writes none, and the row is redacted like every audit row. The outbox line is written by the workspace user, so
 * the row is as good as the workspace's word (an agent can delete its own outbox file); the refusal itself does not depend on it.
 */
export function recordGuardRefusals(store: Store, workspaceId: string, events: OutboxEvent[]): number {
  if (!store.db || !store.writable) return 0;
  const chat = new ChatStore(store);
  let n = 0;
  for (const e of events) {
    if (e.type !== 'refused') continue;
    const claudeSession = text(e.session, 64, /^[A-Za-z0-9-]{1,64}$/);
    chat.addAudit({
      severity: 'high',
      kind: 'guard.refused',
      sessionId: claudeSession ? portalSession(store, claudeSession) : null,
      workspaceId,
      actor: 'agent',
      detail: {
        claudeSession,
        tool: text(e.tool, 100),
        form: text(e.form, 80, /^[A-Za-z0-9 ._+\/:?-]{1,80}$/),
        // A resolved absolute path or the guard's fixed label; anything else (an older guard's command word) is not kept.
        path: typeof e.path === 'string' && e.path ? (text(e.path, 300, /^(\/[^\s\u0000-\u001f]{0,299}|unresolved)$/) ?? 'unresolved') : null,
        agent: text(e.agent, 64),
        mode: text(e.mode, 32),
        at: text(e.t, 40),
      },
    });
    n++;
  }
  return n;
}

/** The portal chat a Claude Code session id belongs to (its first run uses the chat's own id; later runs are segments). */
function portalSession(store: Store, claudeSession: string): string | null {
  try {
    const seg = store.db!.prepare('SELECT session_id FROM chat_segments WHERE claude_session_id = ? ORDER BY n DESC LIMIT 1').get(claudeSession) as { session_id: string } | undefined;
    if (seg) return seg.session_id;
    const own = store.db!.prepare('SELECT id FROM chat_sessions WHERE id = ? OR claude_session_id = ? LIMIT 1').get(claudeSession, claudeSession) as { id: string } | undefined;
    return own?.id ?? null;
  } catch {
    return null;
  }
}
