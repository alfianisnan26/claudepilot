// Chat in the widget (PILOT-1111): a session's stored transcript as the reporter panel shows it. Pure: no I/O, no access decision (the service
// decides which sessions a token may see). The rule is "never more than the portal shows the owner": the person's and the assistant's text
// (redacted when it was stored, and again here with the same chat/redact.ts shapes), a tool call as its name and one short line, an approval
// as a line saying one waits (answered in pilot only), images by reference. Sub-agent lines, thinking, tool output, costs, system notes,
// a move's context and side questions are left out.

import type { ChatEvent, ReporterChatMessage } from '@portal/contracts';
import { redact } from '../chat/redact.js';

/** The most of one line of text the panel gets (a long answer is cut; "Open in pilot" has the whole of it). */
export const CHAT_TEXT_MAX = 6000;
/** One line of a tool call's input. */
export const CHAT_TOOL_LINE_MAX = 120;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The field of a tool's input that says what it did, in the order the portal's row reads them. */
const TOOL_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'skill', 'subject'];

export function toolLine(input: ChatEvent['toolInput']): string {
  if (!input) return '';
  for (const f of TOOL_FIELDS) {
    const v = input[f];
    if (typeof v === 'string' && v.trim()) return cut(oneLine(redact(v)), CHAT_TOOL_LINE_MAX);
  }
  return '';
}

/** A sender other than the owner at the keyboard, as the transcript names it; never the raw actor id. */
function fromOf(ev: ChatEvent): string | null {
  if (!ev.actor) return null;
  if (ev.actorLabel) return cut(oneLine(redact(ev.actorLabel)), 120);
  if (ev.actor.startsWith('session:')) return 'Another session';
  if (ev.actor.startsWith('ticket:')) return 'A ticket';
  return 'pilot';
}

/** One stored event as a panel line, or null for what the panel does not show. `blobUrl` builds an image's address. */
export function toChatMessage(ev: ChatEvent, blobUrl: (blobId: string) => string): ReporterChatMessage | null {
  if (ev.agentLabel || ev.parentToolUseId) return null;
  const images = (ev.images ?? []).filter((i) => /^image\/(png|jpeg|gif|webp)$/.test(i.mediaType)).map((i) => ({ url: blobUrl(i.blobId), mediaType: i.mediaType, width: i.width ?? null, height: i.height ?? null }));
  const base = { seq: ev.seq, at: ev.at, from: null, tool: null, images };
  switch (ev.kind) {
    case 'user':
      if (ev.transfer || ev.handoffId) return null;
      if (!ev.text && !images.length) return null;
      return { ...base, kind: 'user', text: cut(redact(ev.text ?? ''), CHAT_TEXT_MAX), from: fromOf(ev) };
    case 'assistant':
      if (ev.handoffId || (!ev.text && !images.length)) return null;
      return { ...base, kind: 'assistant', text: cut(redact(ev.text ?? ''), CHAT_TEXT_MAX) };
    case 'tool_use':
      if (ev.handoffId) return null;
      return { ...base, images: [], kind: 'tool', tool: cut(oneLine(ev.toolName ?? 'tool'), 60), text: toolLine(ev.toolInput) };
    case 'request': {
      const r = ev.request;
      const what = r ? [r.title, r.detail].filter(Boolean).join(': ') : (ev.toolName ?? '');
      return { ...base, images: [], kind: 'approval', text: cut(oneLine(redact(what || 'An answer is needed')), 200) };
    }
    case 'error':
      return { ...base, images: [], kind: 'error', text: cut(oneLine(redact(ev.text ?? 'Something failed.')), 300) };
    default:
      return null;
  }
}

export function toChatMessages(events: readonly ChatEvent[], blobUrl: (blobId: string) => string): ReporterChatMessage[] {
  const out: ReporterChatMessage[] = [];
  for (const ev of events) {
    const m = toChatMessage(ev, blobUrl);
    if (m) out.push(m);
  }
  return out;
}

/** A message's client id: what the portal's own composer sends (a UUID). */
export const CHAT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
