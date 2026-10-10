// Chat sessions: the pure stream-json protocol (chat-sessions PRD §10.3). No I/O, fully unit-testable.
// `parseLine` turns one line of `claude -p --output-format stream-json` into what the controller must
// do; the builders turn an action into one JSON line to write into the session's stdin FIFO.

import type { ChatEvent, ChatInputState, ChatModelOption, ChatRequest, ChatSessionState, ChatTask } from '@portal/contracts';
import { redact } from './redact.js';

/** A base64 image as Claude Code carries it; the controller turns it into a blob and never stores this. */
export interface RawImage {
  mediaType: string;
  dataBase64: string;
}

/** A transcript event ready to store: a {@link ChatEvent} without the fields the store assigns (seq,
 *  at), plus the raw identifiers the controller persists in the event's own columns. */
export type StoredEvent = Omit<ChatEvent, 'seq' | 'at'> & {
  uuid?: string;
  parentToolUseId?: string | null;
  requestId?: string;
  /** The tool call a `tool_use` or `tool_result` belongs to, so the controller can name the result. */
  toolUseId?: string;
  /** Images a tool returned, still base64: the controller saves them as blobs, sets `images`, and drops these. */
  rawImages?: RawImage[];
};

/** A change to one sub-agent or background task, from a `system/task_*` line (never its prompt). */
export interface TaskPatch {
  taskId: string;
  /** The `Task` tool_use that started it; its sub-agent's lines carry this as `parent_tool_use_id`. */
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  taskType?: string;
  background?: boolean;
  status?: ChatTask['status'];
  /** `task_started`: it starts now. */
  started?: boolean;
  /** When it ended (epoch ms), from `task_updated`. */
  endedAtMs?: number;
  summary?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/** A reply to a control_request the portal sent, matched by `request_id`. Never stored or logged: some
 *  replies (`get_settings`) echo environment values, API keys included. */
export type ControlResponse = { requestId: string; ok: true; response: Record<string, unknown> } | { requestId: string; ok: false; error: string };

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
  /** Set for `system/init`: after a process's first one the controller reads the applied settings. */
  init?: boolean;
  /** A reply to one of the portal's own control requests. */
  controlResponse?: ControlResponse;
  /** Lines the portal sent moving through Claude Code's queue, by their client uuid. */
  inputs?: { uuid: string; state: ChatInputState }[];
  /** Sub-agent and background task changes. */
  tasks?: TaskPatch[];
  /** `Task`/`Agent` tool calls and their descriptions, to label sub-agent lines. */
  agents?: { toolUseId: string; description: string }[];

  /* What the integrity checks (PRD §10.4) look at. */

  /** The permission mode a main-thread `system/init` or `system/status` reports. */
  modeSeen?: string;
  /**
   * A replayed user line (`isReplay`): the uuid Claude Code read it under, and whether it's local command
   * output (`<local-command-stdout>`), which Claude Code echoes under an id of its own.
   */
  replay?: { uuid: string | null; localCommand: boolean };
  /** A `command_lifecycle` line's command uuid, whatever its state. */
  commandUuid?: string;
  /** The main thread called EnterPlanMode, which needs no approval: `plan` mode may follow. */
  enterPlan?: boolean;

  /** A text block started or ended (or its message did): held-back delta text is flushed. */
  blockEdge?: { agentLabel: string | null };
}

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** Redacted first, then clipped, so a cut never leaves part of a credential behind. */
const clean = (s: string, max: number): string => clip(redact(s), max);

/** How much of a sub-agent's description and final summary is kept. */
const MAX_LABEL = 200;
const MAX_SUMMARY = 4_000;

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
    case 'control_response':
      return parseControlResponse(obj);
    case 'command_lifecycle':
      return parseLifecycle(obj);
    case 'api_retry':
      return { stored: [{ kind: 'retry', text: 'The API is retrying (rate limit or overload).' }] };
    default:
      return { stored: [] };
  }
}

/** `system/init` sets model and mode and reports the session id; `status` lines carry the working state
 *  and mode; `task_*` and `background_tasks_changed` track sub-agents. Only main-thread lines speak for
 *  the session's model and mode. */
function parseSystem(obj: Record<string, unknown>): ParsedLine {
  const main = !asStr(obj.parent_tool_use_id);
  switch (asStr(obj.subtype)) {
    case 'init': {
      const out: ParsedLine = { stored: [{ kind: 'system', text: 'Ready' }], init: true };
      const patch: NonNullable<ParsedLine['sessionPatch']> = {};
      const model = asStr(obj.model);
      if (model && main) patch.model = model;
      const mode = asStr(obj.permissionMode);
      if (mode && main) {
        patch.mode = mode;
        out.modeSeen = mode;
      }
      if (Object.keys(patch).length) out.sessionPatch = patch;
      const sid = asStr(obj.session_id);
      if (sid) out.sessionIdSeen = sid;
      return out;
    }
    case 'status':
      return parseStatus(obj, main);
    case 'task_started':
    case 'task_updated':
    case 'task_notification': {
      const task = parseTask(obj);
      return task ? { stored: [], tasks: [task] } : { stored: [] };
    }
    case 'background_tasks_changed': {
      const tasks: TaskPatch[] = [];
      for (const raw of Array.isArray(obj.tasks) ? obj.tasks : []) {
        const t = asObj(raw);
        const taskId = asStr(t?.task_id);
        if (!t || !taskId) continue;
        tasks.push(taskFields(t, { taskId, background: true }));
      }
      return tasks.length ? { stored: [], tasks } : { stored: [] };
    }
    default:
      return { stored: [] };
  }
}

/** `requesting` means working, and names the sent lines that request reads; any status line may carry
 *  the permission mode now in effect (e.g. after `set_permission_mode`). */
function parseStatus(obj: Record<string, unknown>, main: boolean): ParsedLine {
  const out: ParsedLine = { stored: [] };
  const patch: NonNullable<ParsedLine['sessionPatch']> = {};
  if (asStr(obj.status) === 'requesting') {
    patch.state = 'working';
    const read = asStrings(obj.user_message_uuids);
    if (read.length) out.inputs = read.map((uuid) => ({ uuid, state: 'started' }));
  }
  const mode = asStr(obj.permissionMode);
  if (mode && main) {
    patch.mode = mode;
    out.modeSeen = mode;
  }
  if (Object.keys(patch).length) out.sessionPatch = patch;
  return out;
}

/** One `task_started` / `task_updated` / `task_notification` line as a patch. The prompt is never kept. */
function parseTask(obj: Record<string, unknown>): TaskPatch | null {
  const taskId = asStr(obj.task_id);
  if (!taskId) return null;
  const subtype = asStr(obj.subtype);
  if (subtype === 'task_started') {
    const t = taskFields(obj, { taskId, started: true, status: 'running' });
    if (typeof obj.is_backgrounded === 'boolean') t.background = obj.is_backgrounded;
    return t;
  }
  if (subtype === 'task_updated') {
    const patch = asObj(obj.patch) ?? {};
    const t: TaskPatch = { taskId };
    const status = taskStatus(patch.status);
    if (status) t.status = status;
    const end = asNum(patch.end_time);
    if (end !== null) t.endedAtMs = end;
    const description = asStr(patch.description);
    if (description) t.description = clean(description, MAX_LABEL);
    if (typeof patch.is_backgrounded === 'boolean') t.background = patch.is_backgrounded;
    return t;
  }
  // task_notification: how it finished.
  const t = taskFields(obj, { taskId });
  const status = taskStatus(obj.status);
  if (status) t.status = status;
  const summary = asStr(obj.summary);
  if (summary) t.summary = clean(summary, MAX_SUMMARY);
  const usage = asObj(obj.usage);
  const tokens = asNum(usage?.total_tokens);
  if (tokens !== null) t.tokens = tokens;
  const toolUses = asNum(usage?.tool_uses);
  if (toolUses !== null) t.toolUses = toolUses;
  const durationMs = asNum(usage?.duration_ms);
  if (durationMs !== null) t.durationMs = durationMs;
  return t;
}

/** The identifying fields a task line may carry: tool_use_id, description, subagent and task type. */
function taskFields(obj: Record<string, unknown>, base: TaskPatch): TaskPatch {
  const t: TaskPatch = { ...base };
  const toolUseId = asStr(obj.tool_use_id);
  if (toolUseId) t.toolUseId = toolUseId;
  const description = asStr(obj.description);
  if (description) t.description = clean(description, MAX_LABEL);
  const subagentType = asStr(obj.subagent_type);
  if (subagentType) t.subagentType = subagentType;
  const taskType = asStr(obj.task_type);
  if (taskType) t.taskType = taskType;
  return t;
}

/** Claude Code's task status, folded into the four the UI shows; unknown values change nothing. */
function taskStatus(v: unknown): ChatTask['status'] | null {
  switch (asStr(v)) {
    case 'running':
    case 'pending':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'killed':
    case 'stopped':
    case 'cancelled':
      return 'killed';
    default:
      return null;
  }
}

/** Live text deltas: shown as an ephemeral delta, never stored. A block's start and stop (and its
 *  message's stop) mark where held-back text is flushed; other stream_event subtypes are ignored. */
function parseStreamEvent(obj: Record<string, unknown>): ParsedLine {
  const event = asObj(obj.event);
  const agentLabel = asStr(obj.parent_tool_use_id);
  switch (asStr(event?.type)) {
    case 'content_block_delta': {
      const delta = asObj(event?.delta);
      if (delta && asStr(delta.type) === 'text_delta') return { stored: [], delta: { agentLabel, text: asStr(delta.text) ?? '' } };
      return { stored: [] };
    }
    case 'content_block_start':
    case 'content_block_stop':
    case 'message_stop':
      return { stored: [], blockEdge: { agentLabel } };
    default:
      return { stored: [] };
  }
}

/** Tools that start a sub-agent; their `description` input names it. */
const AGENT_TOOLS = new Set(['Task', 'Agent']);

/** One `assistant` line carries completed content blocks: text and tool_use are each stored. */
function parseAssistant(obj: Record<string, unknown>): ParsedLine {
  const content = asObj(obj.message)?.content;
  const agentLabel = asStr(obj.parent_tool_use_id);
  const uuid = asStr(obj.uuid) ?? undefined;
  const stored: StoredEvent[] = [];
  const agents: NonNullable<ParsedLine['agents']> = [];
  let enterPlan = false;
  if (Array.isArray(content))
    for (const raw of content) {
      const block = asObj(raw);
      if (!block) continue;
      if (asStr(block.type) === 'text') stored.push({ kind: 'assistant', text: asStr(block.text) ?? '', agentLabel, uuid, parentToolUseId: agentLabel });
      else if (asStr(block.type) === 'tool_use') {
        const name = asStr(block.name);
        const id = asStr(block.id);
        const ev: StoredEvent = { kind: 'tool_use', toolName: name ?? undefined, agentLabel, uuid, parentToolUseId: agentLabel };
        if (id) ev.toolUseId = id;
        stored.push(ev);
        const description = asStr(asObj(block.input)?.description);
        if (name && AGENT_TOOLS.has(name) && id && description) agents.push({ toolUseId: id, description: clean(description, MAX_LABEL) });
        if (name === 'EnterPlanMode' && !agentLabel) enterPlan = true;
      }
    }
  const out: ParsedLine = { stored };
  if (agents.length) out.agents = agents;
  if (enterPlan) out.enterPlan = true;
  return out;
}

/** Local command output (`/compact`'s "Compacted", …) as Claude Code wraps it. */
const LOCAL_OUTPUT = /^\s*<local-command-(?:stdout|stderr)>/;

function isLocalOutput(content: unknown): boolean {
  if (typeof content === 'string') return LOCAL_OUTPUT.test(content);
  const first = Array.isArray(content) ? asObj(content[0]) : null;
  return asStr(first?.type) === 'text' && LOCAL_OUTPUT.test(asStr(first?.text) ?? '');
}

/** Incoming `user` lines: an array holds tool results (stored, images pulled out for the blob store); a
 *  string, or anything marked `isReplay`, is a line we sent and already stored. A replay reports the
 *  uuid it carries, which the controller checks against what it sent. */
function parseUser(obj: Record<string, unknown>): ParsedLine {
  const content = asObj(obj.message)?.content;
  if (obj.isReplay === true) return { stored: [], replay: { uuid: asStr(obj.uuid), localCommand: isLocalOutput(content) } };
  if (typeof content === 'string') return { stored: [] }; // a replay: the user event was stored when we sent it
  const agentLabel = asStr(obj.parent_tool_use_id);
  const stored: StoredEvent[] = [];
  if (!Array.isArray(content)) return { stored };
  let last: StoredEvent | undefined;
  const beside: RawImage[] = [];
  for (const raw of content) {
    const block = asObj(raw);
    if (!block) continue;
    const type = asStr(block.type);
    if (type === 'tool_result') {
      const { text, images } = toolResultContent(block.content);
      last = { kind: 'tool_result', text, agentLabel, parentToolUseId: agentLabel };
      const toolUseId = asStr(block.tool_use_id);
      if (toolUseId) last.toolUseId = toolUseId; // the controller names the result from its call
      if (images.length) last.rawImages = images;
      stored.push(last);
    } else if (type === 'image') {
      const image = rawImage(block);
      if (image) beside.push(image);
    }
  }
  // Image blocks next to a tool result are what that tool returned; without one, the line isn't a tool's.
  if (last && beside.length) last.rawImages = [...(last.rawImages ?? []), ...beside];
  return { stored };
}

/** A tool_result's content as short text plus its images (base64, for the blob store — never the text). */
function toolResultContent(v: unknown): { text: string; images: RawImage[] } {
  const blocks = Array.isArray(v) ? v : asObj(v) ? [v] : null;
  if (!blocks) return { text: shortText(v), images: [] };
  const parts: string[] = [];
  const images: RawImage[] = [];
  for (const raw of blocks) {
    const block = asObj(raw);
    const type = asStr(block?.type);
    if (block && type === 'image') {
      const image = rawImage(block);
      if (image) images.push(image);
    } else if (block && type === 'text') parts.push(asStr(block.text) ?? '');
    else if (typeof raw === 'string') parts.push(raw);
    else parts.push(`[${type ?? 'content'}]`); // other blocks (documents, …) may carry base64 too: name them only
  }
  return { text: clean(parts.join('\n'), 500), images };
}

/** `{type: "image", source: {type: "base64", media_type, data}}` → a raw image, else null. */
function rawImage(block: Record<string, unknown>): RawImage | null {
  const source = asObj(block.source);
  if (!source || asStr(source.type) !== 'base64') return null;
  const mediaType = asStr(source.media_type);
  const dataBase64 = asStr(source.data);
  return mediaType && dataBase64 ? { mediaType, dataBase64 } : null;
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

/** Claude Code's answer to a control request the portal sent: success (with an optional body) or error. */
function parseControlResponse(obj: Record<string, unknown>): ParsedLine {
  const response = asObj(obj.response);
  const requestId = asStr(response?.request_id);
  if (!response || !requestId) return { stored: [] };
  if (asStr(response.subtype) === 'success') return { stored: [], controlResponse: { requestId, ok: true, response: asObj(response.response) ?? {} } };
  return { stored: [], controlResponse: { requestId, ok: false, error: asStr(response.error) ?? 'Claude Code refused the request.' } };
}

/** The `command_lifecycle` states a sent line can report. */
const LIFECYCLE = new Set<string>(['queued', 'started', 'completed', 'cancelled', 'discarded']);

/** `command_lifecycle`: a line the portal sent was queued, started, completed or cancelled. Its uuid is
 *  reported for the integrity check whatever the state. */
function parseLifecycle(obj: Record<string, unknown>): ParsedLine {
  const uuid = asStr(obj.command_uuid);
  if (!uuid) return { stored: [] };
  const state = asStr(obj.state);
  if (!state || !LIFECYCLE.has(state)) return { stored: [], commandUuid: uuid };
  return { stored: [], commandUuid: uuid, inputs: [{ uuid, state: state as ChatInputState }] };
}

/* ---------- Control replies, reduced to what may be kept ---------- */

/** The applied settings the session shows (from `get_settings.applied`). */
export interface AppliedSettings {
  model?: string;
  effort?: string | null;
  ultracode?: boolean;
  ultracodeAvailable?: boolean;
}

/** Only `applied` from a `get_settings` reply — never `effective` or `sources`, which echo env values
 *  (API keys included) in plain text. Null when the reply has no `applied`. */
export function pickApplied(response: Record<string, unknown>): AppliedSettings | null {
  const applied = asObj(response.applied);
  if (!applied) return null;
  const out: AppliedSettings = {};
  const model = asStr(applied.model);
  if (model) out.model = model;
  if (applied.effort === null) out.effort = null;
  else {
    const effort = asStr(applied.effort);
    if (effort) out.effort = effort;
  }
  if (typeof applied.ultracode === 'boolean') out.ultracode = applied.ultracode;
  if (typeof applied.ultracodeAvailable === 'boolean') out.ultracodeAvailable = applied.ultracodeAvailable;
  return out;
}

/** The models a `list_models` reply offers, as picker rows. */
export function pickModels(response: Record<string, unknown>): ChatModelOption[] {
  const out: ChatModelOption[] = [];
  for (const raw of Array.isArray(response.models) ? response.models : []) {
    const m = asObj(raw);
    const value = asStr(m?.value);
    if (!m || !value) continue;
    out.push({ value, displayName: asStr(m.displayName) ?? value, description: asStr(m.description), resolvedModel: asStr(m.resolvedModel), effortLevels: asStrings(m.supportedEffortLevels) });
  }
  return out;
}

/* ---------- Outgoing lines (each ends in the newline the FIFO protocol needs) ---------- */

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/**
 * A user message. `uuid` (the client's) lets `command_lifecycle` report on it; `priority` `next` steers
 * the running turn and `later` waits for it to end. With images the content is an array: the text (when
 * there is any) and then one base64 image block each.
 */
export function userLine(text: string, opts: { uuid?: string; priority?: 'next' | 'later'; images?: RawImage[] } = {}): string {
  const images = opts.images ?? [];
  const content = images.length
    ? [
        ...(text.trim() ? [{ type: 'text', text }] : []),
        ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.dataBase64 } })),
      ]
    : text;
  const msg: Record<string, unknown> = { type: 'user' };
  if (opts.uuid) msg.uuid = opts.uuid;
  if (opts.priority) msg.priority = opts.priority;
  msg.message = { role: 'user', content };
  return line(msg);
}

/** Allow a tool. `updatedInput` is omitted on purpose, so the CLI runs the input it holds (PRD §10.3). */
export const allowResponse = (requestId: string): string =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow' } } });

/** Deny a tool, with a message shown to the agent. */
export const denyResponse = (requestId: string, message: string): string =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } } });

/** Refuse a control_request whose subtype we don't support. */
export const errorResponse = (requestId: string, error: string): string =>
  line({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });

/** A control request; Claude Code answers with a `control_response` carrying the same `request_id`. */
export const controlRequest = (requestId: string, subtype: string, fields: Record<string, unknown> = {}): string =>
  line({ type: 'control_request', request_id: requestId, request: { ...fields, subtype } });

/** Interrupt the running turn. */
export const interruptRequest = (uuid: string): string => controlRequest(uuid, 'interrupt');

/** `apply_flag_settings` settings, built only from the allowlisted keys — never a caller's raw settings. */
export function flagSettings(input: { effort?: unknown; ultracode?: unknown }): { effortLevel?: string; ultracode?: boolean } {
  const settings: { effortLevel?: string; ultracode?: boolean } = {};
  if (typeof input.effort === 'string') settings.effortLevel = input.effort;
  if (typeof input.ultracode === 'boolean') settings.ultracode = input.ultracode;
  return settings;
}

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
  return clean(detail.replace(/\s+/g, ' ').trim(), MAX_DETAIL);
}

/** Stringify a tool_result's content, redacted and kept short for the transcript row. */
function shortText(v: unknown): string {
  return clean(typeof v === 'string' ? v : JSON.stringify(v ?? ''), 500);
}
