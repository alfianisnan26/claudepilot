// Shared by the canary's checks: the flags the chat host uses, the check and context types, and the small helpers every check leans on.

import type { ClaudeCanaryCheckDef, ClaudeCanaryMode, ClaudeCanaryStatus } from '@portal/contracts';
import { userLine } from '../../chat/protocol.js';
import type { CanaryBox, StreamLine, StreamSession } from './box.js';

/** The flags the chat controller starts every session with (`BASE_FLAGS` in chat/controller.ts, after `-p`); a test keeps the two equal. */
export const CHAT_FLAGS = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default'];

export interface CheckContext {
  /** The exact version under test. */
  version: string;
  mode: ClaudeCanaryMode;
  box: CanaryBox;
  /** What `claude --version` printed first (the `version` check), for the check that asserts nothing moved. */
  firstReported: { value: string | null };
  /** One-time setup a few checks share (the MCP fixture), made by the first that needs it. */
  shared: Map<string, Promise<unknown>>;
}

export interface CheckOutcome {
  status: ClaudeCanaryStatus;
  summary: string;
  detail?: string;
}

export interface CanaryCheck {
  def: ClaudeCanaryCheckDef;
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

export const TURN_MS = 90_000;
export const pass = (summary: string, detail = ''): CheckOutcome => ({ status: 'pass', summary, detail });
export const skip = (summary: string): CheckOutcome => ({ status: 'skipped', summary });
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const obj = (l: StreamLine | undefined): Record<string, unknown> | undefined => (l && typeof l !== 'string' ? l : undefined);
export const text = (l: StreamLine): string => (typeof l === 'string' ? l : JSON.stringify(l));
/** The last lines of a stream, for a failure's detail. */
export const tailOf = (s: StreamSession, n = 14): string => s.lines.slice(-n).map((l) => text(l).slice(0, 320)).join('\n');
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The tool results of the `user` lines after `from`, with whether each was an error. */
export function toolResults(lines: StreamLine[], from = 0): { error: boolean; content: string; id: string }[] {
  const out: { error: boolean; content: string; id: string }[] = [];
  for (const l of lines.slice(from)) {
    const o = obj(l);
    if (o?.type !== 'user') continue;
    const content = (o.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) if (isObj(c) && c.type === 'tool_result') out.push({ error: c.is_error === true, content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content), id: String(c.tool_use_id ?? '') });
  }
  return out;
}

/** Sends a message and waits for the turn's `result` (after the lines already there). */
export async function turn(s: StreamSession, message: string, ms = TURN_MS): Promise<Record<string, unknown>> {
  const from = s.lines.length;
  s.sendRaw(userLine(message));
  return s.waitFor((l) => l.type === 'result' && s.lines.indexOf(l) >= from, ms, 'the turn’s result');
}

/** Waits for the next permission request after `from` and returns it. */
export const nextRequest = (s: StreamSession, from: number, ms = 60_000) => s.waitFor((l) => l.type === 'control_request' && s.lines.indexOf(l) >= from, ms, 'a permission request');

