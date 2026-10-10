// Chat sessions: the pure stream-json protocol (chat-sessions PRD §10.3). No I/O, fully unit-testable.
// `parseLine` turns one line of `claude -p --output-format stream-json` into what the controller must
// do; the builders turn an action into one JSON line to write into the session's stdin FIFO.

import type { ChatEvent, ChatRequest, ChatSessionState } from '@portal/contracts';

/** A transcript event ready to store: a {@link ChatEvent} without the fields the store assigns (seq,
 *  at), plus the raw identifiers the controller persists in the event's own columns. */
export type StoredEvent = Omit<ChatEvent, 'seq' | 'at'> & {
  uuid?: string;
  parentToolUseId?: string | null;
  requestId?: string;
};

/** What one stdout line means: events to store, an ephemeral delta, session patches, a request, etc. */
export interface ParsedLine {
  /** Events to append to the transcript, in order. */
  stored: StoredEvent[];
  /** A live token for the open block; shown but never stored (not replayed on resume). */
  delta?: { agentLabel: string | null; text: string };
  /** Fields to update on the session row. `cost` is absolute; `turnsDelta` is added. */
  sessionPatch?: { model?: string; mode?: string; state?: ChatSessionState; cost?: number; turnsDelta?: number };
  /** A permission/question request the agent raised (carries the tool_use_id for the controller). */
  request?: ChatRequest & { toolUseId?: string };
  /** The `session_id` the agent reported; the controller ends the session if it isn't the expected one. */
  sessionIdSeen?: string;
  /** A control_request the controller doesn't handle: its request_id, to answer with an error response. */
  controlError?: string;
}

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parses one stdout line. Lines to ignore (and anything malformed) come back as `{ stored: [] }`. */
export function parseLine(raw: string): ParsedLine {
  let obj: Record<string, unknown> | null;
  try {
    obj = asObj(JSON.parse(raw));
  } catch {
    return { stored: [] };
  }
  if (!obj) return { stored: [] };
  switch (asStr(obj.type)) {
    case 'system':
      return parseSystem(obj);
    case 'stream_event':
      return parseStreamEvent(obj);
    case 'assistant':
      return parseAssistant(obj);
    case 'user':
      return parseUser(obj);
    case 'result':
      return parseResult(obj);
    case 'control_request':
      return parseControlRequest(obj);
    case 'api_retry':
      return { stored: [{ kind: 'retry', text: 'The API is retrying (rate limit or overload).' }] };
    default:
      return { stored: [] };
  }
}

/** `system/init` sets model and mode and reports the session id; `system/status: requesting` means working. */
function parseSystem(obj: Record<string, unknown>): ParsedLine {
  const subtype = asStr(obj.subtype);
  if (subtype === 'init') {
    const out: ParsedLine = { stored: [{ kind: 'system', text: 'Ready' }] };
    const patch: NonNullable<ParsedLine['sessionPatch']> = {};
    const model = asStr(obj.model);
    if (model) patch.model = model;
    const mode = asStr(obj.permissionMode);
    if (mode) patch.mode = mode;
    if (Object.keys(patch).length) out.sessionPatch = patch;
    const sid = asStr(obj.session_id);
    if (sid) out.sessionIdSeen = sid;
    return out;
  }
  if (subtype === 'status' && asStr(obj.status) === 'requesting') return { stored: [], sessionPatch: { state: 'working' } };
  return { stored: [] };
}

/** Live text deltas: shown as an ephemeral delta, never stored. Other stream_event subtypes are ignored. */
function parseStreamEvent(obj: Record<string, unknown>): ParsedLine {
  const event = asObj(obj.event);
  if (event && asStr(event.type) === 'content_block_delta') {
    const delta = asObj(event.delta);
    if (delta && asStr(delta.type) === 'text_delta') return { stored: [], delta: { agentLabel: asStr(obj.parent_tool_use_id), text: asStr(delta.text) ?? '' } };
  }
  return { stored: [] };
}

/** One `assistant` line carries completed content blocks: text and tool_use are each stored. */
function parseAssistant(obj: Record<string, unknown>): ParsedLine {
  const content = asObj(obj.message)?.content;
  const agentLabel = asStr(obj.parent_tool_use_id);
  const uuid = asStr(obj.uuid) ?? undefined;
  const stored: StoredEvent[] = [];
  if (Array.isArray(content))
    for (const raw of content) {
      const block = asObj(raw);
      if (!block) continue;
      if (asStr(block.type) === 'text') stored.push({ kind: 'assistant', text: asStr(block.text) ?? '', agentLabel, uuid, parentToolUseId: agentLabel });
      else if (asStr(block.type) === 'tool_use') stored.push({ kind: 'tool_use', toolName: asStr(block.name) ?? undefined, agentLabel, uuid, parentToolUseId: agentLabel });
    }
  return { stored };
}

/** Incoming `user` lines: an array holds tool results (stored); a string is a replay we already stored. */
function parseUser(obj: Record<string, unknown>): ParsedLine {
  const content = asObj(obj.message)?.content;
  if (typeof content === 'string') return { stored: [] }; // isReplay: the user event was stored when we sent it
  const agentLabel = asStr(obj.parent_tool_use_id);
  const stored: StoredEvent[] = [];
  if (Array.isArray(content))
    for (const raw of content) {
      const block = asObj(raw);
      if (block && asStr(block.type) === 'tool_result') stored.push({ kind: 'tool_result', text: shortText(block.content), agentLabel, parentToolUseId: agentLabel });
    }
  return { stored };
}

/** A `result` ends the turn: store it (with cost), update totals, go idle, and flag an errored turn. */
function parseResult(obj: Record<string, unknown>): ParsedLine {
  const subtype = asStr(obj.subtype);
  const cost = asNum(obj.total_cost_usd);
  const text = asStr(obj.result) ?? undefined;
  const errored = obj.is_error === true || (subtype !== null && subtype !== 'success');
  const stored: StoredEvent[] = [{ kind: 'result', text, costUsd: cost ?? undefined }];
  if (errored) stored.push({ kind: 'error', text: text ?? `The turn ended with ${subtype ?? 'an error'}.` });
  const patch: NonNullable<ParsedLine['sessionPatch']> = { state: 'idle', turnsDelta: 1 };
  if (cost !== null) patch.cost = cost;
  const out: ParsedLine = { stored, sessionPatch: patch };
  const sid = asStr(obj.session_id);
  if (sid) out.sessionIdSeen = sid;
  return out;
}

/** `can_use_tool` becomes a request the operator must answer; any other control_request gets an error. */
function parseControlRequest(obj: Record<string, unknown>): ParsedLine {
  const requestId = asStr(obj.request_id);
  const request = asObj(obj.request);
  if (requestId && request && asStr(request.subtype) === 'can_use_tool') {
    const toolName = asStr(request.tool_name);
    const req: ChatRequest & { toolUseId?: string } = {
      requestId,
      kind: 'tool',
      toolName,
      agentLabel: asStr(obj.parent_tool_use_id),
      title: requestTitle(toolName),
      detail: requestDetail(toolName, request.input),
      createdAt: '', // the store assigns the real timestamp on insert
    };
    const toolUseId = asStr(request.tool_use_id);
    if (toolUseId) req.toolUseId = toolUseId;
    return { stored: [], request: req, sessionPatch: { state: 'waiting' } };
  }
  if (requestId) return { stored: [], controlError: requestId };
  return { stored: [] };
}

/* ---------- Outgoing lines (each ends in the newline the FIFO protocol needs) ---------- */

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** A user message turn. */
export const userLine = (text: string): string => line({ type: 'user', message: { role: 'user', content: text } });

/** Allow a tool. `updatedInput` is omitted on purpose, so the CLI runs the input it holds (PRD §10.3). */
export const allowResponse = (requestId: string): string =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow' } } });

/** Deny a tool, with a message shown to the agent. */
export const denyResponse = (requestId: string, message: string): string =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } } });

/** Refuse a control_request whose subtype we don't support. */
export const errorResponse = (requestId: string, error: string): string =>
  line({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });

/** Interrupt the running turn. */
export const interruptRequest = (uuid: string): string => line({ type: 'control_request', request_id: uuid, request: { subtype: 'interrupt' } });

/* ---------- Request summaries (redacted, short) ---------- */

const TITLES: Record<string, string> = {
  Bash: 'Run a command',
  Write: 'Write a file',
  Edit: 'Edit a file',
  MultiEdit: 'Edit a file',
  NotebookEdit: 'Edit a notebook',
  Read: 'Read a file',
};

/** A short human title for a tool request, e.g. "Run a command" for Bash. */
export function requestTitle(toolName: string | null): string {
  if (!toolName) return 'Use a tool';
  return TITLES[toolName] ?? `Use ${toolName}`;
}

const MAX_DETAIL = 200;

/** A short, redacted one-line summary of a tool's input (never the whole blob); null for unknown tools. */
export function requestDetail(toolName: string | null, input: unknown): string | null {
  const o = asObj(input);
  if (!o) return null;
  let detail: string | null;
  switch (toolName) {
    case 'Bash':
      detail = asStr(o.command);
      break;
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Read':
      detail = asStr(o.file_path) ?? asStr(o.notebook_path);
      break;
    default:
      return null; // unknown tools: don't risk echoing secrets from an unrecognised shape
  }
  if (detail === null) return null;
  const trimmed = detail.replace(/\s+/g, ' ').trim();
  return trimmed.length > MAX_DETAIL ? `${trimmed.slice(0, MAX_DETAIL - 1)}…` : trimmed;
}

/** Stringify a tool_result's content, kept short for the transcript row. */
function shortText(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > 500 ? `${s.slice(0, 499)}…` : s;
}
