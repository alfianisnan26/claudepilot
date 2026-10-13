import { createHash } from 'node:crypto';

/**
 * The integrity checks' accepted cases (chat-sessions PRD §10.4, T-136): the ONLY lines Claude Code writes that the controller believes
 * without the portal having sent them, each with what it rests on (the raw stream it was observed in) and its negative twin, which must
 * still end the session. The tests read this table: every entry has a positive and a negative fixture, built at runtime (integrity.test.ts).
 * Anything not listed here, or listed but without its evidence in the stream, ends the session. Nothing here loosens a check for input
 * the portal did not send: each case is a line Claude Code makes itself, tied to something this process did that the portal saw.
 */
export interface IntegrityCase {
  /** A stable name, used by the tests to find the case's fixtures. */
  id: string;
  /** Which line it is. */
  line: string;
  /** When it is accepted. */
  rule: string;
  /** What it rests on: what the real stream showed. */
  evidence: string;
  /** The twin that still ends the session. */
  negative: string;
}

export const INTEGRITY_CASES: readonly IntegrityCase[] = [
  {
    id: 'replay-task-notification',
    line: 'a replayed user line with origin {kind: "task-notification", producer: "session-task"}',
    rule: 'always: Claude Code reports a background command it started finishing',
    evidence: 'Claude Code 2.1.296: every background Bash command that finished wrote this line with a fresh uuid, then a turn of its own',
    negative: 'any other producer (mcp, none), any other kind (channel), or no origin at all',
  },
  {
    id: 'replay-peer',
    line: 'a replayed user line with origin {kind: "peer", senderTaskId, body}',
    rule:
      'only when, within PEER_CAUSE_MS before it, THIS process showed a SendMessage tool use by that same sub-agent (its agent_id equals ' +
      'senderTaskId, and the task ran in this process), the tool result of exactly that call said "Message queued for the main ' +
      'conversation\'s next turn.", and the message text equals the body; each cause is used once',
    evidence:
      'orchestrator fdb140be, 2026-10-13 15:45 (raw out.1.jsonl): assistant line {parent_tool_use_id: <Agent call>, agent_id: <task>, ' +
      'tool_use SendMessage {to: "main", message}} -> user line {tool_result for that call: {"success":true,"message":"Message queued for ' +
      'the main conversation\'s next turn."}} -> system/init -> user line {isReplay, origin: {kind: "peer", from, senderTaskId, name, body}} ' +
      'with body identical to the message; the portal ended the session there',
    negative: 'a peer line with no SendMessage before it, with another body, from another task, after the window, or a second time',
  },
  {
    id: 'replay-local-command',
    line: 'a replayed user line holding local command output (<local-command-stdout>) under an id of its own',
    rule: 'only while one of the portal\'s own slash commands (/compact, …) runs',
    evidence: '/compact echoes "Compacted" this way',
    negative: 'the same line while no slash command of the portal runs',
  },
  {
    id: 'replay-model-note',
    line: 'a replayed "Set model to …" local command line',
    rule: 'only within MODEL_NOTE_MS after the portal asked for a model change',
    evidence: 'Claude Code echoes set_model this way',
    negative: 'the same line when the portal asked for no model change',
  },
  {
    id: 'command-harness-started',
    line: 'a command_lifecycle "started" for a uuid the portal never sent (and the rest of that command\'s lifecycle)',
    rule: 'only when a sub-agent or background task ran in the current process (chat_tasks since the process start); T-99',
    evidence: 'Konfersi session, 2026-10-13 12:50: a role sub-agent finished, then started with no queued and no replayed line, then system/init',
    negative: 'the same line in a process that ran no task, or a "queued" state for an unknown uuid',
  },
  {
    id: 'control-duplicate',
    line: 'a second control_response for a request the portal asked, or for an answer it gave',
    rule: 'ignored and logged only when its content is identical to the first one read for that id',
    evidence:
      'orchestrator fe3df8bc, 2026-10-13: ended "a second control response for request …"; no request id appears twice in any raw ' +
      'out.*.jsonl on the dev workspace, so the second copy was the same line read again, not a second answer',
    negative: 'a second response with different content, or a response for an id the portal never asked or answered',
  },
];

/** How long after a sub-agent's SendMessage was queued its peer line may arrive (observed: the same second). */
export const PEER_CAUSE_MS = 120_000;

/** What a sub-agent's SendMessage result says when the message waits for the main conversation (observed, Claude Code 2.1.296). */
export const PEER_QUEUED_MESSAGE = "Message queued for the main conversation's next turn.";

/** One sub-agent SendMessage this process showed: who sent it and a digest of its text (never the text). */
export interface PeerCause {
  toolUseId: string;
  taskId: string;
  digest: string;
  at: number;
  queued: boolean;
}

/** A digest of a control response as parsed (its id, outcome and body), so a second copy can be compared with the first. */
export function controlDigest(reply: unknown): string {
  return createHash('sha256').update(JSON.stringify(reply)).digest('hex');
}

/** A digest of a message's text (a sub-agent's SendMessage, a peer line's body): compared, never kept as text. */
export function textDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
