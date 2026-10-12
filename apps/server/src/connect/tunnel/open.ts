// Opening a stream for a service (docs/prd/targets-connect.md §9.4): the opener's first line is a `ConnectOpenRequest`, the acceptor answers
// with one `ConnectOpenResponse` line (`ok`, or `ok:false` with a typed code and then FIN). After an `ok` the stream carries what the
// service says it does (raw HTTP for `docker` and `kube`, JSON lines for `control`, records for `host`) and the opener sends nothing else
// until the answer has come. Both ends use these two functions, so they cannot disagree about the lines.
//
// Shared by the portal and the agent: only `node:*`, the contract and `../seams.ts` (an error class, no imports) are imported.

import {
  CONNECT_LIMITS,
  CONNECT_SERVICES,
  CONNECT_STREAM_ERRORS,
  type ConnectHostOpen,
  type ConnectOpenRequest,
  type ConnectOpenResponse,
  type ConnectService,
  type ConnectStreamError,
} from '@portal/contracts';
import { ConnectError } from '../seams.js';
import { LineEnded, LineMalformed, LineTimeout, LineTooLong, parseLine, readLine, writeLine } from './lines.js';
import { MuxClosedError, MuxLimitError, type MuxSession, type MuxStream } from './mux.js';

const noop = () => undefined;

export interface OpenRequest {
  service: ConnectService;
  args?: ConnectHostOpen;
  trace?: string;
}

/**
 * Opens a stream on `session` for `request.service` and waits for the acceptor's answer. Resolves with the stream, positioned after the answer
 * line (anything the acceptor already sent behind it is still in the stream). Rejects with a ConnectError: `agent_offline` when the tunnel is
 * gone, `busy` at the stream cap, `timeout`, or the acceptor's own typed refusal.
 */
export async function openService(session: MuxSession, request: OpenRequest, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<MuxStream> {
  let stream: MuxStream;
  try {
    stream = session.open();
  } catch (e) {
    if (e instanceof MuxLimitError) throw new ConnectError('busy', e.message);
    if (e instanceof MuxClosedError) throw new ConnectError('agent_offline', e.message);
    throw e;
  }
  // Nothing listens to the stream yet: an error on it (a reset, the tunnel ending) must reach the awaiting code, not the process.
  stream.on('error', noop);
  try {
    const line: ConnectOpenRequest = { v: 1, service: request.service, ...(request.args ? { args: request.args } : {}), ...(request.trace ? { trace: request.trace } : {}) };
    await writeLine(stream, line, CONNECT_LIMITS.maxOpenLine);
    const answer = await readLine(stream, CONNECT_LIMITS.maxOpenLine, { timeoutMs: opts.timeoutMs ?? CONNECT_LIMITS.openMs, signal: opts.signal });
    if (answer === null) throw new ConnectError(session.closed ? 'agent_offline' : 'internal', 'The other end closed the stream without answering.');
    const response = answerOf(answer);
    if (!response.ok) throw new ConnectError(response.code, response.message);
    stream.off('error', noop);
    return stream;
  } catch (e) {
    stream.destroy();
    throw asConnectError(e, session);
  }
}

function answerOf(line: string): ConnectOpenResponse {
  const v = (() => {
    try {
      return parseLine(line) as Partial<ConnectOpenResponse> & { code?: unknown; message?: unknown };
    } catch {
      return null;
    }
  })();
  if (!v || typeof v !== 'object' || v.v !== 1) throw new ConnectError('internal', 'The answer to a stream open is not understood.');
  if (v.ok === true) return { v: 1, ok: true };
  if (v.ok === false) {
    const code = CONNECT_STREAM_ERRORS.includes(v.code as ConnectStreamError) ? (v.code as ConnectStreamError) : 'internal';
    return { v: 1, ok: false, code, message: typeof v.message === 'string' ? v.message.slice(0, 500) : 'Refused.' };
  }
  throw new ConnectError('internal', 'The answer to a stream open is not understood.');
}

function asConnectError(e: unknown, session: MuxSession): ConnectError {
  if (e instanceof ConnectError) return e;
  if (e instanceof LineTimeout) return new ConnectError('timeout', 'The other end did not answer the stream open in time.');
  if (e instanceof LineEnded || e instanceof LineTooLong || e instanceof LineMalformed) return new ConnectError(session.closed ? 'agent_offline' : 'internal', e.message);
  if (session.closed) return new ConnectError('agent_offline', 'The tunnel is closed.');
  // a reset by the peer, or a write that failed because the stream ended
  return new ConnectError('internal', e instanceof Error ? e.message : String(e));
}

/** What the acceptor decides about a request. A refusal carries the typed code the opener will see. */
export type OpenDecision = { ok: true } | { ok: false; code: ConnectStreamError; message: string };

/**
 * The acceptor's half. Reads the opener's first line (at most 16 KiB, within `timeoutMs`), checks it is a well-formed request, asks `decide`,
 * and writes the answer. Returns the request when it was accepted (the stream is then the service's), or null when it was refused: the
 * refusal is already written and the stream ended, so there is nothing more to do with it.
 */
export async function acceptService(
  stream: MuxStream,
  decide: (request: ConnectOpenRequest) => OpenDecision | Promise<OpenDecision>,
  opts: { timeoutMs?: number } = {},
): Promise<ConnectOpenRequest | null> {
  stream.on('error', noop);
  const refuse = async (code: ConnectStreamError, message: string): Promise<null> => {
    try {
      await writeLine(stream, { v: 1, ok: false, code, message } satisfies ConnectOpenResponse);
      stream.end();
      stream.resume();
    } catch {
      stream.destroy();
    }
    return null;
  };
  let line: string | null;
  try {
    line = await readLine(stream, CONNECT_LIMITS.maxOpenLine, { timeoutMs: opts.timeoutMs ?? CONNECT_LIMITS.openMs });
  } catch (e) {
    if (e instanceof LineTimeout) return refuse('timeout', 'No open request arrived in time.');
    if (e instanceof LineTooLong) return refuse('bad_open', 'The open request is too long.');
    stream.destroy();
    return null;
  }
  if (line === null) {
    stream.destroy();
    return null;
  }
  let request: ConnectOpenRequest;
  try {
    const v = parseLine(line) as Partial<ConnectOpenRequest> | null;
    if (!v || typeof v !== 'object' || v.v !== 1 || !CONNECT_SERVICES.includes(v.service as ConnectService)) throw new LineMalformed('bad request');
    request = { v: 1, service: v.service as ConnectService };
    if (v.args !== undefined) {
      if (!v.args || typeof v.args !== 'object' || Array.isArray(v.args)) throw new LineMalformed('bad args');
      request.args = v.args;
    }
    if (typeof v.trace === 'string' && /^[0-9a-f]{8}$/.test(v.trace)) request.trace = v.trace;
  } catch {
    return refuse('bad_open', 'The open request is not understood.');
  }
  let decision: OpenDecision;
  try {
    decision = await decide(request);
  } catch (e) {
    return refuse('internal', e instanceof Error ? e.message.slice(0, 200) : 'Failed.');
  }
  if (!decision.ok) return refuse(decision.code, decision.message);
  try {
    await writeLine(stream, { v: 1, ok: true } satisfies ConnectOpenResponse);
  } catch {
    stream.destroy();
    return null;
  }
  stream.off('error', noop);
  return request;
}
