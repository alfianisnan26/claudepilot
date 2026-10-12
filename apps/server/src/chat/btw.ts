// Side questions (btw), the engine (chat-sessions PRD §20): one question about a session, answered once by a SEPARATE tool-free Claude Code run
// in the session's workspace, from the session's redacted transcript up to that moment. The session itself is never touched: no line to its
// process, no event (unless the person pins), no counter, no turn. The answer goes to the person who asked and nobody else.
//
// What the engine owns: the gates (setting, one at a time, rate limit, spending gate, sign-in), the context, the run (btwRun.ts), the streamed
// and final answer through the chat's redactors, cancel and timeout, the usage row, the audit row, and Pin. What it is given (`BtwHost`): the
// session's facts, its events, a way to exec in the workspace, redaction, and the one place a card is appended to a transcript.

import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { AppError } from '@isnanme/core';
import {
  BTW_QUESTION_MAX,
  BTW_REQUIRED_LEVEL,
  sessionRef,
  type Actor,
  type BtwReason,
  type BtwServerMessage,
  type ChatBtw,
  type ChatEvent,
} from '@portal/contracts';
import { actorString, actorUserId, onAccessChange, requireCan } from '../authz/seam.js';
import { defineSetting } from '../settings/registry.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { boundAnswer, btwCommand, btwInputLine, btwInterruptLine, btwPrompt, classifyApiFailure, classifyResult, estimateTokens, failFast, parseBtwLine, toUsage, type BtwFailure, type BtwUsageReport } from './btwRun.js';
import { btwTranscript } from './btwContext.js';
import { BtwStore, snapshot, type BtwRecord } from './btwStore.js';
import type { StoredEvent } from './protocol.js';

/* ---------- Settings ---------- */

export const BTW_ENABLED = 'chat.btw.enabled';
export const BTW_LIMIT = 'chat.btw.limit';
export const BTW_WINDOW_MIN = 'chat.btw.windowMin';
export const BTW_TIMEOUT_SEC = 'chat.btw.timeoutSec';
export const BTW_CONTEXT_CHARS = 'chat.btw.contextChars';
export const BTW_MODEL = 'chat.btw.model';
export const BTW_MAX_COST = 'chat.btw.maxCostUsd';

defineSetting({
  key: BTW_ENABLED,
  type: 'boolean',
  default: true,
  scope: 'global',
  group: 'sessions',
  order: 80,
  label: 'Side questions',
  help: 'Lets a person ask one question about a chat session, answered once by a separate Claude Code run with no tools, from the session’s transcript so far. Nothing is added to the session unless they pin the answer. Each question uses the session’s Claude (its quota and cost).',
});
defineSetting({
  key: BTW_LIMIT,
  type: 'number',
  default: 6,
  min: 1,
  max: 60,
  scope: 'global',
  group: 'sessions',
  order: 81,
  label: 'Side question limit',
  help: 'How many side questions one session may start in the window below, whoever asks. The next one waits and says for how long.',
});
defineSetting({
  key: BTW_WINDOW_MIN,
  type: 'number',
  default: 10,
  min: 1,
  max: 120,
  scope: 'global',
  group: 'sessions',
  order: 82,
  label: 'Limit window',
  help: 'The window, in minutes, for the side question limit.',
});
defineSetting({
  key: BTW_TIMEOUT_SEC,
  type: 'number',
  default: 60,
  min: 10,
  max: 300,
  scope: 'global',
  group: 'sessions',
  order: 83,
  label: 'Side question time',
  help: 'How many seconds a side question may take before it is stopped (reason: took too long).',
});
defineSetting({
  key: BTW_CONTEXT_CHARS,
  type: 'number',
  default: 60_000,
  min: 4_000,
  max: 400_000,
  scope: 'global',
  group: 'sessions',
  order: 84,
  label: 'Side question context',
  help: 'How many characters of the session’s transcript a side question is given (the newest messages that fit, secrets taken out). More context costs more tokens each time.',
});
defineSetting({
  key: BTW_MODEL,
  type: 'string',
  default: '',
  max: 80,
  scope: 'global',
  group: 'sessions',
  order: 85,
  label: 'Side question model',
  help: 'The model that answers side questions. Empty uses the session’s own model.',
});
defineSetting({
  key: BTW_MAX_COST,
  type: 'number',
  default: 0.5,
  min: 0.05,
  max: 20,
  scope: 'global',
  group: 'sessions',
  order: 86,
  label: 'Side question cost cap',
  help: 'The most one side question may cost, in dollars at list price (Claude Code stops it there).',
});

export interface BtwConfig {
  enabled: boolean;
  limit: number;
  windowMs: number;
  timeoutMs: number;
  contextChars: number;
  model: string;
  maxCostUsd: number;
}

const num = (v: unknown, fallback: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

/** The settings as the engine uses them; a missing or odd value is the default. */
export function readBtwConfig(get: (key: string) => unknown): BtwConfig {
  return {
    enabled: get(BTW_ENABLED) !== false,
    limit: Math.round(num(get(BTW_LIMIT), 6, 1, 60)),
    windowMs: Math.round(num(get(BTW_WINDOW_MIN), 10, 1, 120)) * 60_000,
    timeoutMs: Math.round(num(get(BTW_TIMEOUT_SEC), 60, 10, 300)) * 1000,
    contextChars: Math.round(num(get(BTW_CONTEXT_CHARS), 60_000, 4_000, 400_000)),
    model: typeof get(BTW_MODEL) === 'string' ? (get(BTW_MODEL) as string).trim() : '',
    maxCostUsd: num(get(BTW_MAX_COST), 0.5, 0.05, 20),
  };
}

/* ---------- What the engine is given ---------- */

/** What the engine needs to know of a session. */
export interface BtwSessionFacts {
  /** The session's current id (a folded session's old id resolved). */
  id: string;
  workspaceId: string;
  claudeId: string;
  /** The Claude's directory under ~/.claudepilot ('' for Default), or null when that Claude is gone. */
  claudeDir: string | null;
  cwd: string;
  /** The model in effect, when known. */
  model: string | null;
}

export interface BtwHost {
  /** The session, or null; an old id of a folded session answers as the chat that took it in. */
  session(id: string): BtwSessionFacts | null;
  /** The session's stored events, oldest first, at least the newest `limit` of them. */
  events(sessionId: string, limit: number): ChatEvent[];
  /** A command in the workspace (the same exec the other host commands use). Throws when the workspace can't be reached. */
  exec(workspaceId: string, command: string[]): Promise<ExecSession>;
  /** Text from the workspace or the person, safe to send or show: secret values out, then credential shapes. */
  scrub(workspaceId: string, text: string): string;
  /** The same for text that arrives in pieces: a tail that could become a secret waits for the next piece. */
  scrubStream(workspaceId: string): { push(text: string): string; flush(): string };
  /** Whether the session's Claude can run (signed in, or its pool set up): null when it can, else why not. Throws when the workspace can't be asked. */
  credential(workspaceId: string, claudeId: string | null): Promise<{ reason: BtwReason; note?: string } | null>;
  /** The spending gate that pauses messages (a used-up budget): its message when it refuses. */
  gate(info: { sessionId: string; workspaceId: string; claudeId: string | null }): string | null;
  /** Appends a stored event to the session's transcript and tells the tabs subscribed to it. */
  append(sessionId: string, ev: StoredEvent): ChatEvent | null;
  /** The audit trail: ids, names and numbers only. */
  audit(entry: { severity: 'info' | 'medium' | 'high'; kind: string; sessionId: string; workspaceId: string; actor: string; detail: Record<string, unknown> }): void;
  /** A side question's usage row was written (the usage track's hook; never the turns'). */
  sideUsage?(turn: { sessionId: string; workspaceId: string; claudeId: string | null; atMs: number }, rows: readonly { costUsd: number }[]): void;
}

type Listener = (userId: string, sessionId: string, msg: BtwServerMessage) => void;

/** How the run ended, before it is written down. */
interface Outcome {
  status: 'answered' | 'failed' | 'cancelled';
  reason?: BtwReason;
  note?: string;
  retryAfterMs?: number;
  answer?: string;
  report?: BtwUsageReport | null;
  model?: string | null;
}

/** One run in flight. */
interface Run {
  rec: BtwRecord;
  session: BtwSessionFacts;
  stream: { push(text: string): string; flush(): string };
  exec: ExecSession | null;
  timer: NodeJS.Timeout | null;
  seq: number;
  inited: boolean;
  exited: boolean;
  /** Its `result` arrived: nothing is in flight, so stopping needs no interrupt. */
  resulted: boolean;
  done: boolean;
  startedMs: number;
  /** An API failure Claude Code wrote as an assistant message: its `result` follows, and says the same. */
  apiError: { error: string | null; text: string } | null;
  finish(o: Outcome): void;
  /** Resolves when the run has ended (for tests and shutdown). */
  ended: Promise<void>;
}

/** A tab that subscribes gets the person's open btws asked in this window. */
const REPLAY_MS = 60 * 60_000;
const REPLAY_MAX = 3;
/** The newest stored events a context is built from: far more than a context limit can hold of an ordinary session. */
const EVENTS_WINDOW = 1_500;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
/** What a run's stdout may buffer without a newline before it is dropped (a line is one JSON object). */
const MAX_PENDING = 4 * 1024 * 1024;
/** The effort and output room of a side question: quick and short. */
const EFFORT = 'low' as const;
const MAX_OUTPUT_TOKENS = 4_000;
/** After an interrupt, how long before the connection is closed (so the line is delivered). */
const CLOSE_AFTER_MS = 300;

export interface BtwEngineOptions {
  store: BtwStore;
  host: BtwHost;
  config: () => BtwConfig;
  now?: () => Date;
}

export class BtwEngine {
  readonly #store: BtwStore;
  readonly #host: BtwHost;
  readonly #config: () => BtwConfig;
  readonly #now: () => Date;
  /** The run in flight per session: one at a time. */
  readonly #active = new Map<string, Run>();
  readonly #listeners = new Set<Listener>();
  #off: (() => void) | null = null;

  constructor(o: BtwEngineOptions) {
    this.#store = o.store;
    this.#host = o.host;
    this.#config = o.config;
    this.#now = o.now ?? (() => new Date());
  }

  /** Call once at start: a btw left running by a restart can never finish, and a revoked right ends the person's runs. */
  start(): void {
    try {
      this.#store.failRunning('Interrupted by a restart.');
    } catch {
      // a read-only store has nothing to fail
    }
    this.#off ??= onAccessChange((c) => {
      for (const run of [...this.#active.values()]) {
        if (run.rec.userId !== c.userId) continue;
        if (c.ref && !((c.ref.type === 'session' && c.ref.id === run.session.id) || (c.ref.type === 'workspace' && c.ref.id === run.session.workspaceId))) continue;
        run.finish({ status: 'cancelled' });
      }
    });
  }

  /** Stops every run (the portal is closing) and forgets the listeners. */
  async shutdown(): Promise<void> {
    this.#off?.();
    this.#off = null;
    const runs = [...this.#active.values()];
    for (const run of runs) run.finish({ status: 'cancelled' });
    await Promise.all(runs.map((r) => r.ended));
    this.#listeners.clear();
  }

  /** Resolves when no run is in flight (tests). */
  async idle(): Promise<void> {
    while (this.#active.size) await Promise.all([...this.#active.values()].map((r) => r.ended));
  }

  /** Messages for one person's tabs: the socket forwards each to its connections of that person that watch the session. */
  onMessage(cb: Listener): () => void {
    this.#listeners.add(cb);
    return () => void this.#listeners.delete(cb);
  }

  #emit(userId: string, sessionId: string, msg: BtwServerMessage): void {
    for (const cb of [...this.#listeners]) {
      try {
        cb(userId, sessionId, msg);
      } catch (e) {
        console.error(`[btw] a listener failed: ${(e as Error).message}`);
      }
    }
  }

  /** The person and session of a request, after the one authorization check every operation makes. */
  #resolve(actor: Actor, rawSession: string): { userId: string; session: BtwSessionFacts } {
    const userId = actorUserId(actor);
    if (!userId || actor.kind === 'system') throw new AppError('UNAUTHORIZED', 'Sign in again.');
    const session = typeof rawSession === 'string' ? this.#host.session(rawSession) : null;
    if (!session) throw new AppError('NOT_FOUND', 'No such session.');
    requireCan(actor, BTW_REQUIRED_LEVEL, sessionRef(session.id));
    return { userId, session };
  }

  /**
   * Asks. Throws for what makes no btw (malformed, unknown or not allowed); every other outcome is a `btw` message: `running` and the answer
   * follows, or `failed` with the reason (the gates, in order: setting, one at a time, rate limit, spending gate, sign-in, workspace).
   * Asking twice with the same id is the same ask.
   */
  async ask(actor: Actor, rawSession: string, id: string, rawQuestion: string): Promise<void> {
    const { userId, session } = this.#resolve(actor, rawSession);
    if (typeof id !== 'string' || !ID.test(id)) throw new AppError('VALIDATION_FAILED', 'Bad side question id.', { details: { btw: 'Expected an id of 8 to 64 letters, digits, - or _.' } });
    const asked = typeof rawQuestion === 'string' ? rawQuestion.replace(/\r\n?/g, '\n').trim() : '';
    if (!asked) throw new AppError('VALIDATION_FAILED', 'Ask something.', { details: { question: 'Empty.' } });
    if (asked.length > BTW_QUESTION_MAX) throw new AppError('VALIDATION_FAILED', `Keep it under ${BTW_QUESTION_MAX} characters.`, { details: { question: 'Too long.' } });

    const same = this.#recordOf(userId, session.id, id);
    if (same) return this.#emit(userId, session.id, { type: 'btw', session: session.id, item: snapshot(same) });
    // The same ask twice at once (a double tap): the first is still passing the gates and will answer; the second adds nothing, and is not "busy".
    const passing = this.#reserved.get(session.id);
    if (passing && passing.userId === userId && passing.id === id) return;

    const now = this.#now();
    const question = this.#host.scrub(session.workspaceId, asked);
    const base = { id, session: session.id, question, answer: '', askedAt: now.toISOString() };
    const refuse = (reason: BtwReason, extra: { note?: string; retryAfterMs?: number } = {}) =>
      this.#emit(userId, session.id, { type: 'btw', session: session.id, item: { ...base, status: 'failed', reason, ...extra, settledAt: now.toISOString() } });

    const cfg = this.#config();
    if (!cfg.enabled) return refuse('disabled');
    if (this.#active.has(session.id) || this.#reserved.has(session.id)) return refuse('busy');
    // The slot is taken here, before anything is awaited, so two asks at once can't both pass.
    const slot = { userId, id };
    this.#reserved.set(session.id, slot);
    let released = false;
    const release = () => {
      if (!released && this.#reserved.get(session.id) === slot) this.#reserved.delete(session.id);
      released = true;
    };
    try {
      const started = this.#store.startedSince(session.id, now.getTime() - cfg.windowMs);
      if (started.count >= cfg.limit) return refuse('rate_limit', { retryAfterMs: Math.max(1000, (started.oldestMs ?? now.getTime()) + cfg.windowMs - now.getTime()) });
      const gate = this.#host.gate({ sessionId: session.id, workspaceId: session.workspaceId, claudeId: session.claudeId || null });
      if (gate) return refuse('no_quota', { note: gate.slice(0, 200) });
      if (session.claudeDir === null) return refuse('workspace', { note: 'This Claude was removed.' });
      let credential: { reason: BtwReason; note?: string } | null;
      try {
        credential = await this.#host.credential(session.workspaceId, session.claudeId || null);
      } catch {
        return refuse('workspace');
      }
      if (credential) return refuse(credential.reason, credential.note ? { note: credential.note.slice(0, 200) } : {});

      // The context: the newest stored messages that fit, redacted by both redactors before it goes anywhere.
      const events = this.#host.events(session.id, EVENTS_WINDOW);
      const transcript = btwTranscript(events, cfg.contextChars);
      const text = this.#host.scrub(session.workspaceId, transcript.text);
      const prompt = btwPrompt({ transcript: text, question, messages: transcript.messages, truncated: transcript.truncated, folder: session.cwd, asOf: now });
      const model = cfg.model || session.model || null;
      const rec: BtwRecord = {
        ...base,
        status: 'running',
        userId,
        actor: actorString(actor),
        workspaceId: session.workspaceId,
        claudeId: session.claudeId,
        askedMs: now.getTime(),
        ...(model ? { model } : {}),
        context: { messages: transcript.messages, truncated: transcript.truncated, lastSeq: transcript.lastSeq, chars: prompt.length },
        usage: toUsage(null, { chars: prompt.length, answerChars: 0 }),
      };
      if (!this.#store.insert(rec)) return this.#emit(userId, session.id, { type: 'btw', session: session.id, item: snapshot(this.#recordOf(userId, session.id, id) ?? rec) });

      this.#emit(userId, session.id, { type: 'btw', session: session.id, item: snapshot(rec) });
      this.#launch(rec, session, prompt, cfg, model);
      this.#reserved.delete(session.id);
      released = true;
    } finally {
      release();
    }
  }

  /** Slots taken by asks that are still passing the gates, and whose ask each is. */
  readonly #reserved = new Map<string, { userId: string; id: string }>();

  #recordOf(userId: string, sessionId: string, id: string): BtwRecord | null {
    const live = this.#active.get(sessionId);
    if (live && live.rec.userId === userId && live.rec.id === id) return live.rec;
    return this.#store.get(userId, sessionId, id);
  }

  /** Builds the run and starts it in the background; its `ended` resolves when it is over. */
  #launch(rec: BtwRecord, session: BtwSessionFacts, prompt: string, cfg: BtwConfig, model: string | null): Run {
    let resolveEnded!: () => void;
    const ended = new Promise<void>((r) => (resolveEnded = r));
    const run: Run = {
      rec,
      session,
      stream: this.#host.scrubStream(session.workspaceId),
      exec: null,
      timer: null,
      seq: 0,
      inited: false,
      exited: false,
      resulted: false,
      done: false,
      startedMs: this.#now().getTime(),
      apiError: null,
      ended,
      finish: (o) => this.#finish(run, o, resolveEnded),
    };
    // In flight before anything can end it: a run that fails at once must still find itself in the map to leave it.
    this.#active.set(session.id, run);
    run.timer = setTimeout(() => run.finish({ status: 'failed', reason: 'timeout' }), cfg.timeoutMs);
    void this.#execute(run, prompt, cfg, model);
    return run;
  }

  async #execute(run: Run, prompt: string, cfg: BtwConfig, model: string | null): Promise<void> {
    let exec: ExecSession;
    try {
      const command = btwCommand({
        claudeDir: run.session.claudeDir ?? '',
        model,
        effort: EFFORT,
        maxCostUsd: cfg.maxCostUsd,
        limitSeconds: Math.ceil(cfg.timeoutMs / 1000) + 5,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      exec = await this.#host.exec(run.session.workspaceId, command);
    } catch {
      return run.finish({ status: 'failed', reason: 'workspace' });
    }
    if (run.done) {
      // Cancelled while the exec was starting: it never got its line.
      try {
        exec.close();
      } catch {
        // already gone
      }
      return;
    }
    run.exec = exec;
    const decoder = new StringDecoder('utf8');
    let pending = '';
    exec.onData((chunk) => {
      if (run.done) return;
      pending += decoder.write(chunk);
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (line) this.#line(run, line);
        if (run.done) return;
      }
      if (pending.length > MAX_PENDING) pending = '';
    });
    exec.onExit((code) => {
      run.exited = true;
      if (run.done) return;
      if (run.apiError) return run.finish({ status: 'failed', ...classifyApiFailure({ status: null, error: run.apiError.error, text: run.apiError.text }) });
      if (code === 127) return run.finish({ status: 'failed', reason: 'workspace', note: 'Claude Code isn’t installed here.' });
      if (code === 124) return run.finish({ status: 'failed', reason: 'timeout' });
      run.finish({ status: 'failed', reason: 'error' });
    });
    try {
      exec.write(btwInputLine(prompt));
    } catch {
      run.finish({ status: 'failed', reason: 'workspace' });
    }
  }

  /** One line of the run's output. */
  #line(run: Run, raw: string): void {
    const ev = parseBtwLine(raw);
    if (!ev) return;
    const rec = run.rec;
    switch (ev.kind) {
      case 'init':
        // The proof that no tool can run: the run reports none, or it is stopped before it answers anything.
        if (ev.tools.length || ev.mcpServers) return run.finish({ status: 'failed', reason: 'unsafe' });
        run.inited = true;
        if (ev.model && !rec.model) rec.model = ev.model;
        return;
      case 'tool':
        return run.finish({ status: 'failed', reason: 'unsafe' });
      case 'text': {
        if (!run.inited) return run.finish({ status: 'failed', reason: 'unsafe' });
        const safe = run.stream.push(ev.text);
        this.#appendAnswer(run, safe);
        return;
      }
      case 'retry': {
        const fast = failFast(ev);
        if (fast) run.finish({ status: 'failed', ...fast });
        return;
      }
      case 'limit':
        if (ev.rejected) run.finish({ status: 'failed', reason: 'no_quota' });
        return;
      case 'api_error':
        run.apiError = { error: ev.error, text: ev.text };
        return;
      case 'result': {
        run.resulted = true;
        if (!run.inited) return run.finish({ status: 'failed', reason: 'unsafe' });
        if (!ev.ok) {
          const why: BtwFailure = run.apiError ? classifyApiFailure({ status: ev.status, error: run.apiError.error, text: run.apiError.text }) : classifyResult(ev);
          return run.finish({ status: 'failed', ...why, report: ev.usage, model: ev.model });
        }
        const answer = boundAnswer(this.#host.scrub(run.session.workspaceId, ev.text));
        if (!answer) return run.finish({ status: 'failed', reason: 'empty', report: ev.usage, model: ev.model });
        return run.finish({ status: 'answered', answer, report: ev.usage, model: ev.model });
      }
    }
  }

  /** Streams redacted answer text to the asking person's tabs and keeps it on the record (bounded). */
  #appendAnswer(run: Run, safe: string): void {
    if (!safe) return;
    const room = 12_000 - run.rec.answer.length;
    if (room <= 0) return;
    const piece = safe.length > room ? safe.slice(0, room) : safe;
    run.rec.answer += piece;
    this.#emit(run.rec.userId, run.session.id, { type: 'btw_delta', session: run.session.id, btw: run.rec.id, text: piece, seq: ++run.seq });
  }

  /** The one place a run ends: records it, tells the person, books the usage, audits it, and stops the process if it still lives. */
  #finish(run: Run, o: Outcome, resolveEnded: () => void): void {
    if (run.done) return;
    run.done = true;
    if (run.timer) clearTimeout(run.timer);
    const rec = run.rec;
    const now = this.#now();

    // What a stopped run had said so far is kept for a cancel, a timeout or a failure after some text; `unsafe` keeps nothing.
    if (o.status !== 'answered' && o.reason !== 'unsafe') {
      const tail = run.stream.flush();
      if (tail && rec.answer.length < 12_000) rec.answer += tail.slice(0, 12_000 - rec.answer.length);
    } else if (o.status !== 'answered') rec.answer = '';
    if (o.answer !== undefined) rec.answer = o.answer;
    rec.status = o.status;
    delete rec.reason;
    delete rec.note;
    delete rec.retryAfterMs;
    if (o.status === 'failed') {
      rec.reason = o.reason ?? 'error';
      if (o.note) rec.note = o.note;
      if (o.retryAfterMs !== undefined) rec.retryAfterMs = o.retryAfterMs;
    }
    if (o.model) rec.model = o.model;
    rec.settledAt = now.toISOString();
    // Numbers only where something may have been spent: the run's own report, or (no report) an estimate for a run that probably reached the API.
    // A run that never got that far (workspace, sign-in, the guard, a limit) used nothing, and says so by showing none.
    const reachedApi = o.status === 'answered' || o.status === 'cancelled' || o.reason === 'timeout' || o.reason === 'empty' || o.reason === 'error';
    if (o.report) rec.usage = toUsage(o.report, { chars: 0, answerChars: 0 });
    else if (reachedApi && rec.usage) rec.usage = { ...rec.usage, output: estimateTokens(rec.answer.length) };
    else delete rec.usage;

    try {
      this.#store.save(rec);
    } catch (e) {
      console.error(`[btw] could not save a side question: ${(e as Error).message}`);
    }
    this.#emit(rec.userId, run.session.id, { type: 'btw', session: run.session.id, item: snapshot(rec) });

    // Usage: a run that reported it is one row among the turns', announced on its own hook (never as a turn).
    if (o.report && (o.report.costUsd ?? 0) + o.report.input + o.report.output + o.report.cacheRead + o.report.cacheWrite > 0) {
      const turn = { atMs: now.getTime(), sessionId: run.session.id, workspaceId: run.session.workspaceId, claudeId: run.session.claudeId || null };
      try {
        this.#store.recordSideUsage({ ...turn, btwId: rec.id, model: rec.model ?? 'unknown', durationMs: now.getTime() - run.startedMs }, { ...o.report, costUsd: o.report.costUsd ?? 0 });
        this.#host.sideUsage?.(turn, [{ costUsd: o.report.costUsd ?? 0 }]);
      } catch (e) {
        console.error(`[btw] could not book a side question's usage: ${(e as Error).message}`);
      }
    }
    try {
      this.#host.audit({
        severity: 'info',
        kind: 'btw.ask',
        sessionId: run.session.id,
        workspaceId: run.session.workspaceId,
        actor: rec.actor,
        detail: {
          btw: rec.id,
          outcome: rec.status,
          ...(rec.reason ? { reason: rec.reason } : {}),
          ...(rec.model ? { model: rec.model } : {}),
          ...(rec.usage ? { input: rec.usage.input, output: rec.usage.output, costUsd: rec.usage.costUsd, basis: rec.usage.basis } : {}),
          messages: rec.context?.messages ?? 0,
          ms: now.getTime() - run.startedMs,
        },
      });
    } catch {
      // the audit trail never blocks an answer
    }

    this.#stop(run);
    this.#active.delete(run.session.id);
    resolveEnded();
  }

  /** Stops the process: an interrupt for a request in flight, then the connection closes (Claude Code leaves on its input ending). `timeout` inside the workspace is the backstop. */
  #stop(run: Run): void {
    const exec = run.exec;
    if (!exec) return;
    if (!run.exited && !run.resulted) {
      try {
        exec.write(btwInterruptLine(randomUUID()));
      } catch {
        // gone already
      }
    }
    const close = () => {
      try {
        exec.close();
      } catch {
        // already closed
      }
    };
    if (run.exited || run.resulted) close();
    else setTimeout(close, CLOSE_AFTER_MS).unref();
  }

  /** Stops a running btw (the card stays, `cancelled`). Not the asker's or not running: nothing happens. */
  cancel(actor: Actor, rawSession: string, id: string): void {
    const { userId, session } = this.#resolve(actor, rawSession);
    const run = this.#active.get(session.id);
    if (run && run.rec.userId === userId && run.rec.id === id) run.finish({ status: 'cancelled' });
  }

  /** Closes the card: stops it when it still runs, and it is no longer sent to a tab that subscribes. */
  close(actor: Actor, rawSession: string, id: string): void {
    const { userId, session } = this.#resolve(actor, rawSession);
    const run = this.#active.get(session.id);
    if (run && run.rec.userId === userId && run.rec.id === id) run.finish({ status: 'cancelled' });
    const rec = this.#recordOf(userId, session.id, id);
    if (rec?.closed) return;
    if (!rec) {
      // A refusal is not stored, but every tab of the person got it: closing it on one closes it on the rest.
      const at = this.#now().toISOString();
      return this.#emit(userId, session.id, { type: 'btw', session: session.id, item: { id, session: session.id, question: '', status: 'cancelled', answer: '', askedAt: at, settledAt: at, closed: true } });
    }
    rec.closed = true;
    this.#store.save(rec);
    this.#emit(userId, session.id, { type: 'btw', session: session.id, item: snapshot(rec) });
  }

  /**
   * Pins an answered btw of the asker to the session's transcript as one card, from the portal's own copy (the tab sends no text). Throws
   * `NOT_FOUND` for one that isn't this person's, `CONFLICT` for one that isn't answered or is pinned already.
   */
  pin(actor: Actor, rawSession: string, id: string): ChatEvent {
    const { userId, session } = this.#resolve(actor, rawSession);
    const rec = this.#recordOf(userId, session.id, id);
    if (!rec) throw new AppError('NOT_FOUND', 'No such side question.');
    if (rec.status !== 'answered' || !rec.answer) throw new AppError('CONFLICT', 'Only an answer can be pinned.');
    if (rec.pinnedSeq !== undefined) throw new AppError('CONFLICT', 'Already pinned.');
    const ev = this.#host.append(session.id, {
      kind: 'system',
      text: `btw: ${rec.question}\n\n${rec.answer}`,
      btw: { id: rec.id, question: rec.question, answer: rec.answer, askedAt: rec.askedAt, askedBy: rec.actor, ...(rec.model ? { model: rec.model } : {}), ...(rec.usage ? { usage: rec.usage } : {}) },
    });
    if (!ev) throw new AppError('CONFLICT', 'This session can’t take it now.');
    rec.pinnedSeq = ev.seq;
    this.#store.save(rec);
    this.#emit(userId, session.id, { type: 'btw', session: session.id, item: snapshot(rec) });
    try {
      this.#host.audit({ severity: 'info', kind: 'btw.pin', sessionId: session.id, workspaceId: session.workspaceId, actor: rec.actor, detail: { btw: rec.id, seq: ev.seq } });
    } catch {
      // the audit trail never blocks a pin
    }
    return ev;
  }

  /** The person's open btws on a session (asked in the last hour, not closed, newest three): what a tab that subscribes is sent. Empty when they may not operate it. */
  open(actor: Actor, rawSession: string): ChatBtw[] {
    let userId: string;
    let session: BtwSessionFacts;
    try {
      ({ userId, session } = this.#resolve(actor, rawSession));
    } catch {
      return [];
    }
    const live = this.#active.get(session.id);
    return this.#store
      .open(userId, session.id, this.#now().getTime() - REPLAY_MS, REPLAY_MAX)
      .map((r) => snapshot(live && live.rec.userId === userId && live.rec.id === r.id ? live.rec : r));
  }
}
