import { createHash } from 'node:crypto';
import type { ControlResponse } from './protocol.js';

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
  {
    id: 'control-replay-undigested',
    line: 'a second control_response for a request the portal asked (or an answer it gave) and completed before T-136, whose first copy kept no digest',
    rule:
      'ignored and logged only when it is a success whose body is one the portal\'s own requests produce (sameAnswer): empty (set_model, ' +
      'interrupt, apply_flag_settings, stop_task, cancel_async_message), {mode} for a mode the portal set or expects on this session ' +
      '(set_permission_mode), or only the keys get_settings, list_models or get_usage reply with; for an answer the portal gave, a ' +
      '{behavior} that is the outcome it recorded (allow, deny)',
    evidence:
      'orchestrator 5c9fcb5f, 2026-10-13 17:58 (raw out.1.jsonl): line 1, the set_permission_mode reply {mode: "bypassPermissions"} of ' +
      '15:46 (asked before migration 771, so no digest), read again when the follower replayed the file from byte 0 (T-265); the id ' +
      'appears once in the file, and the portal ended the session on it',
    negative:
      'a different mode, an error reply, a body of another shape, an echo whose behavior is not the recorded outcome, or an id the ' +
      'portal never asked or answered',
  },
  {
    id: 'mode-downgrade',
    line: 'a main-thread system/init or system/status whose permissionMode is LESS permissive (MODE_RANK) than the mode the portal expects',
    rule:
      'accepted as a downgrade: the expected mode becomes the reported one, the row shows it, the transcript says "Bypass is off in this ' +
      'chat" (from Bypass) or "Mode is <mode> in this chat", the session event goes out, and only the gated path (enterBypass, the ' +
      'restart and move re-assert) puts Bypass back; the agent can then do less than the portal allowed, never more',
    evidence:
      'Konfersi chat 3907db7f, 2026-10-14 02:50:24 UTC, during deploy #20 (02:43 to 02:53): after the portal restarted, the expected mode ' +
      'was rebuilt from the stored row (bypassPermissions) and a main-thread system/init or system/status reported permissionMode ' +
      '"default"; the portal ended the session "the permission mode changed to default without this portal (expected bypassPermissions)"',
    negative:
      'a more permissive report than expected (default -> acceptEdits), Bypass reported when the portal did not enter it, an unknown ' +
      'mode string (dontAsk, anything new), and a downgrade on a sub-agent thread (parent_tool_use_id set: never a mode report, so the ' +
      'expected mode stays and a later main-thread report is judged against it)',
  },
  {
    id: 'mode-resync',
    line: 'the first main-thread system/init or system/status after the portal attached to a live process again (a portal restart, a deploy)',
    rule:
      'judged against the control state STORED for that very process (migration 820: the expected mode, the mode before plan, plan ' +
      'entered, leaving plan approved), not against a mode inferred from the row; the same mode or a transition those stored flags allow ' +
      'is taken, a lower one is mode-downgrade; the comparison is made once, within RESYNC_MS, and logged with what was stored',
    evidence:
      'T-277 (2026-10-14): before layer 2 the portal rebuilt only the expected mode from the row after a restart and lost the plan flags, ' +
      'so a chat whose leaving plan mode the portal had approved (back to acceptEdits) ended "the permission mode changed to acceptEdits ' +
      'without this portal (expected plan)" when its report came after the restart (integrity.test.ts reproduces it on the testkit: the twin with no state stored)',
    negative:
      'a report more permissive than the stored state, Bypass the stored state does not expect, a state stored for ANOTHER process (its ' +
      'session id, segment or start differ: the row is used, as before), and a second differing report after the first one closed the window',
  },
  {
    id: 'control-bypass-unfinished',
    line: 'the set_permission_mode reply {mode: "bypassPermissions"} to the Bypass request the portal sent under the grant, read after a portal restart',
    rule:
      'only for the one request id stored as pending when it was sent (every Bypass gate passed: the grant was held for it) and only by a ' +
      'portal that reloaded that state at attach; the entry is NOT finished: never shown or audited as entered; the process is taken out ' +
      'of Bypass at once (set_permission_mode to the start mode, else stopped), the transcript says so and bypass.left (why ' +
      'restart_unfinished) is recorded; the same holds when the stored expected mode is Bypass but the row never recorded the entry',
    evidence:
      'T-277 layer 2 (2026-10-14): a portal stopped between sending the gated set_permission_mode and reading its reply (a deploy during ' +
      'enterBypass, the supervisor\'s re-assert or a restart\'s keep) read that reply after it came back without the grant and ended the ' +
      'session "Claude Code switched to Bypass permissions"',
    negative:
      'a Bypass reply to any other request id (one never sent under the grant), the same late reply in the SAME portal life (the grant ' +
      'is gone: it still ends), and a Bypass status report while nothing is pending',
  },
  {
    id: 'control-stale',
    line: 'a control_response for a request Claude Code raised that the portal resolved `stale` (its process was no longer the live one; T-284)',
    rule:
      'ignored and logged (the ids only), never processed: only for an id THIS session recorded as a request (chat_requests) whose outcome ' +
      'is stale, and only when the portal holds no answer of its own for it; nothing is allowed or denied by it',
    evidence:
      'T-284 (Konfersi chat 93b468c8, 2026-10-14 04:02 to 05:00 UTC): a tool request of a process that was gone stayed open, could not ' +
      'be answered and blocked Restart; T-284 resolves such requests stale. A late answer for one was not seen in a raw stream: this case ' +
      'keeps a stale request from ever reading as one "this portal never asked for" (the twins below show nothing else moved)',
    negative:
      'an id the portal never asked or answered, the same answer for a request still open (of the live process), and a stale id of ANOTHER ' +
      'session: each still ends the session "a control response for request … that this portal never asked for or answered"',
  },
];

/**
 * How long after the portal attached to a live process again (its state reloaded from the store) the first mode report is the resync
 * comparison (INTEGRITY_CASES `mode-resync`). The comparison is made once; it accepts nothing the stored state and mode-downgrade don't.
 */
export const RESYNC_MS = 60_000;

/**
 * The permission modes by how much they let the agent do without asking (T-277): plan < default < acceptEdits < auto < bypassPermissions.
 * Any other string (dontAsk included, and anything Claude Code may add) ranks above Bypass, so it is never "less permissive". Frozen: no
 * code may add a mode or move one down at run time (T-277 review note e).
 */
export const MODE_RANK: Readonly<Record<string, number>> = Object.freeze({ plan: 0, default: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 });

/** The rank of a mode string; an unknown one ranks above Bypass. */
export function modeRank(mode: string): number {
  return Object.hasOwn(MODE_RANK, mode) ? MODE_RANK[mode]! : Number.POSITIVE_INFINITY;
}

/**
 * Whether a reported mode lets the agent do strictly LESS than the expected one (INTEGRITY_CASES `mode-downgrade`). Both must be in
 * MODE_RANK: an unknown report, or an expected mode outside the table, is never a downgrade.
 */
export function lessPermissive(reported: string, expected: string): boolean {
  return Object.hasOwn(MODE_RANK, reported) && Object.hasOwn(MODE_RANK, expected) && MODE_RANK[reported]! < MODE_RANK[expected]!;
}

/** What the portal knows of a completed control line whose first response kept no digest (asked before migration 771). */
export type ControlExpectation = { kind: 'asked'; modes: readonly string[] } | { kind: 'answered'; outcome: string | null };

/** The keys of the replies the portal's own requests read (Claude Code 2.1.296): get_settings, list_models, get_usage. */
const REPLY_KEYS: readonly (readonly string[])[] = [['applied'], ['models'], ['session', 'subscription_type', 'rate_limits_available', 'rate_limits', 'behaviors']];

/**
 * Whether a second response for a control line that kept no digest is the same answer by shape (INTEGRITY_CASES
 * `control-replay-undigested`): a success, with a body the portal's own request can have produced, and for an echo of the portal's
 * answer, the behavior it recorded. Anything else is a different answer.
 */
export function sameAnswer(reply: ControlResponse, expect: ControlExpectation): boolean {
  if (!reply.ok) return false;
  const body = reply.response;
  const keys = Object.keys(body);
  if (expect.kind === 'answered') {
    const behavior = body.behavior;
    if (behavior === 'allow') return expect.outcome === 'allowed_once' || expect.outcome === 'allowed_session';
    if (behavior === 'deny') return expect.outcome === 'denied';
    return false;
  }
  if (keys.length === 0) return true;
  if (keys.length === 1 && keys[0] === 'mode') return typeof body.mode === 'string' && expect.modes.includes(body.mode);
  return REPLY_KEYS.some((shape) => keys.every((k) => shape.includes(k)));
}

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

/* ---------- The control state that decides integrity, persisted (T-277 layer 2, migration 820) ---------- */

/** The permission mode the stream must report and the changes Claude Code may make by itself (the controller's track, as stored). */
export interface StoredMode {
  expected: string;
  prePlan: string | null;
  enterPlan: boolean;
  exitPlan: boolean;
  /** The id of a `set_permission_mode` Bypass request sent under the grant whose reply was not read yet. */
  bypassPending: string | null;
}

/**
 * What `chat_sessions.control_state` holds: the process it belongs to (`proc`: Claude Code session id, segment and start, so a state is
 * never applied to another process), the mode track and the peer causes. Ids, modes and sha256 digests only: never a line's text.
 */
export interface StoredControl {
  v: 1;
  proc: string;
  mode: StoredMode;
  peers: PeerCause[];
}

/** The process a stored state belongs to. */
export function controlProc(row: { claude_session_id?: string | null; id: string; segment: number; process_started_at: string | null }): string {
  return `${row.claude_session_id || row.id}/${row.segment}/${row.process_started_at ?? ''}`;
}

/** The stored form; the peer causes are kept as the controller holds them (at most 32, digests). */
export function controlJson(proc: string, mode: StoredMode, peers: readonly PeerCause[]): string {
  const m: StoredMode = { expected: mode.expected, prePlan: mode.prePlan, enterPlan: mode.enterPlan, exitPlan: mode.exitPlan, bypassPending: mode.bypassPending };
  const p = peers.slice(-32).map((c) => ({ toolUseId: c.toolUseId, taskId: c.taskId, digest: c.digest, at: c.at, queued: c.queued }));
  return JSON.stringify({ v: 1, proc, mode: m, peers: p } satisfies StoredControl);
}

const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * The stored state for the process `proc`, or null: nothing stored, another process's state, or anything unreadable or out of shape
 * (then the controller uses the row's mode, as before layer 2). Strict: every field has its type and bounds, digests are sha256 hex.
 */
export function readControl(stored: string | null | undefined, proc: string): StoredControl | null {
  if (!stored) return null;
  let v: unknown;
  try {
    v = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || o.proc !== proc || !o.mode || typeof o.mode !== 'object' || !Array.isArray(o.peers) || o.peers.length > 32) return null;
  const m = o.mode as Record<string, unknown>;
  if (!str(m.expected, 40) || !(m.prePlan === null || str(m.prePlan, 40)) || typeof m.enterPlan !== 'boolean' || typeof m.exitPlan !== 'boolean') return null;
  if (!(m.bypassPending === null || str(m.bypassPending))) return null;
  const peers: PeerCause[] = [];
  for (const p of o.peers as unknown[]) {
    if (!p || typeof p !== 'object') return null;
    const c = p as Record<string, unknown>;
    if (!str(c.toolUseId) || !str(c.taskId) || typeof c.digest !== 'string' || !/^[0-9a-f]{64}$/.test(c.digest) || typeof c.at !== 'number' || !Number.isFinite(c.at) || typeof c.queued !== 'boolean') return null;
    peers.push({ toolUseId: c.toolUseId, taskId: c.taskId, digest: c.digest, at: c.at, queued: c.queued });
  }
  return { v: 1, proc, mode: { expected: m.expected, prePlan: (m.prePlan as string | null) ?? null, enterPlan: m.enterPlan, exitPlan: m.exitPlan, bypassPending: (m.bypassPending as string | null) ?? null }, peers };
}

/** A digest of a control response as parsed (its id, outcome and body), so a second copy can be compared with the first. */
export function controlDigest(reply: unknown): string {
  return createHash('sha256').update(JSON.stringify(reply)).digest('hex');
}

/** A digest of a message's text (a sub-agent's SendMessage, a peer line's body): compared, never kept as text. */
export function textDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/* ---------- What an integrity ending was for (T-136 slice 2, recover in place) ---------- */

/**
 * The cases an integrity ending is recorded under (`chat_sessions.ended_for`), and whether each is HARMLESS: a near miss of an accepted
 * case above, where the line still came from this process's own machinery. Only a harmless ending may be recovered by an agent (the MCP
 * tool, the supervisor); a suspicious one needs a person, after a sheet that shows the origin and this classification. Default suspicious.
 */
export const ENDING_CASES = {
  /** A peer line from a sub-agent that ran in THIS process, whose SendMessage cause was not matched (the window, the body): `replay-peer`'s near miss. */
  'replay-peer': { classified: 'harmless', origin: 'a sub-agent of this process' },
  /** The same control response read twice by the portal before T-265 healed the follower (5c9fcb5f, fe3df8bc): `control-duplicate`. Legacy rows only. */
  'control-duplicate': { classified: 'harmless', origin: 'the portal read the same line twice' },
  'replay-peer-unknown': { classified: 'suspicious', origin: 'peer: not a task of this process' },
  'replay-unknown': { classified: 'suspicious', origin: 'unknown origin' },
  'command-unknown': { classified: 'suspicious', origin: 'a command this portal never sent' },
  'control-different': { classified: 'suspicious', origin: 'a different control answer' },
  'control-unknown': { classified: 'suspicious', origin: 'a control answer for an id never asked' },
  'request-duplicate': { classified: 'suspicious', origin: 'a tool request id seen twice' },
  'session-id': { classified: 'suspicious', origin: 'another Claude Code session' },
  'mode-bypass': { classified: 'suspicious', origin: 'Bypass the portal did not enter' },
  'mode-changed': { classified: 'suspicious', origin: 'a mode the portal did not set' },
  unknown: { classified: 'suspicious', origin: 'unclassified' },
} as const satisfies Record<string, { classified: 'harmless' | 'suspicious'; origin: string }>;

export type EndingCase = keyof typeof ENDING_CASES;

/** What is stored with an integrity ending: the case, the classification, the origin in words, and whether the session was in Bypass. */
export interface EndingRecord {
  case: EndingCase;
  classified: 'harmless' | 'suspicious';
  origin: string;
  bypass: boolean;
}

export function endingRecord(c: EndingCase, o: { origin?: string; bypass: boolean }): EndingRecord {
  const d = ENDING_CASES[c] ?? ENDING_CASES.unknown;
  return { case: c, classified: d.classified, origin: o.origin ?? d.origin, bypass: o.bypass };
}

/**
 * The record of an ending as stored, or, for a row that ended before slice 2 (none stored), read from its reason: only the pre-T-265
 * "a second control response" (the same line read twice; evidence on T-136 and T-265) is harmless; every other legacy reason is
 * suspicious. Null when the row did not end for integrity.
 */
export function readEnding(endedReason: string | null | undefined, stored: string | null | undefined): EndingRecord | null {
  if (!endedReason?.startsWith('integrity: ')) return null;
  if (stored) {
    try {
      const v = JSON.parse(stored) as Partial<EndingRecord>;
      if (v && typeof v.case === 'string' && v.case in ENDING_CASES) return endingRecord(v.case as EndingCase, { origin: typeof v.origin === 'string' ? v.origin.slice(0, 80) : undefined, bypass: v.bypass === true });
    } catch {
      // unreadable: classified from the reason below
    }
  }
  const why = endedReason.slice('integrity: '.length);
  if (/^a second control response for request \S+$/.test(why)) return endingRecord('control-duplicate', { bypass: false });
  if (/^a message this portal didn't send reached Claude Code/.test(why)) return endingRecord('replay-unknown', { bypass: false });
  if (/^Claude Code queued a message this portal didn't send/.test(why)) return endingRecord('command-unknown', { bypass: false });
  if (/^a tool request id arrived twice/.test(why)) return endingRecord('request-duplicate', { bypass: false });
  return endingRecord('unknown', { bypass: false });
}
