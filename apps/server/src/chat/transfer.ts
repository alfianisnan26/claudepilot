// Chat sessions: what a context transfer carries (Workspace Claudes FR12, FR13). Built from the portal's
// own stored events, never from Claude Code's transcript; redacted before it is written or sent.

import type { ChatEvent } from '@portal/contracts';
import { redact } from './redact.js';

/** The conversation carried over, most recent last: whole messages, newest kept when it's too long. */
export interface TransferConversation {
  /** Markdown: one `### You` / `### Claude` section per message, tool use noted under Claude's. */
  text: string;
  messages: number;
  /** Older messages were left out to keep it within the budget. */
  truncated: boolean;
}

export interface TransferMeta {
  handoffId: string;
  at: Date;
  workspaceId: string;
  cwd: string;
  sourceSessionId: string;
  fromClaude: string;
  toClaude: string;
  path: string;
}

/** One message's share of the budget. */
const MESSAGE_MAX_CHARS = 4_000;
/** The conversation never gets less room than this, however long the framing around it is. */
const MIN_BUDGET_CHARS = 2_000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… (cut)` : text);

/** A handoff note's room in the opening (the source Claude is asked to be brief; this is the backstop). */
export const NOTE_MAX_CHARS = 6_000;
/** A tool call as the conversation names it: its name and its one-line summary, bounded. */
const TOOL_SUMMARY_MAX = 60;
const TOOLS_PER_TURN = 12;

/**
 * The main agent's conversation from stored events: what you sent, Claude's replies, and which tools a
 * turn used (by name and count, never their input or output). Sub-agent lines stay out. A transferred
 * session's own opening is carried as the earlier context it was. `maxChars` is the room it may take:
 * the newest whole messages that fit are kept.
 */
export function transferConversation(events: ChatEvent[], maxChars: number = MIN_BUDGET_CHARS * 6, messageMax: number = MESSAGE_MAX_CHARS): TransferConversation {
  const sections: string[] = [];
  let tools = new Map<string, number>();
  const flushTools = () => {
    if (!tools.size) return;
    const shown = [...tools].slice(0, TOOLS_PER_TURN).map(([call, n]) => (n > 1 ? `${call} ×${n}` : call));
    if (tools.size > TOOLS_PER_TURN) shown.push(`and ${tools.size - TOOLS_PER_TURN} more`);
    sections.push(`_Tools used: ${shown.join(', ')}_`);
    tools = new Map();
  };
  // The handoff exchange (the portal's request and the note it got) is carried as the note, not twice.
  let handoff = false;
  for (const ev of events) {
    if (ev.agentLabel) continue;
    if (ev.kind === 'user' && ev.actor === 'portal:handoff') {
      handoff = true;
      continue;
    }
    if (handoff) {
      if (ev.kind !== 'user' && ev.kind !== 'result') continue;
      handoff = false;
      if (ev.kind === 'result') continue;
    }
    if (ev.kind === 'tool_use' && ev.toolName) {
      // By name and the one-line summary the transcript shows (a command, a path): never the input or the output.
      const what = ev.text?.replace(/\s+/g, ' ').trim();
      const call = what ? `${ev.toolName} (${what.length > TOOL_SUMMARY_MAX ? `${what.slice(0, TOOL_SUMMARY_MAX - 1)}…` : what})` : ev.toolName;
      tools.set(call, (tools.get(call) ?? 0) + 1);
      continue;
    }
    const text = ev.text?.trim();
    if (!text || (ev.kind !== 'user' && ev.kind !== 'assistant')) continue;
    flushTools();
    if (ev.kind === 'user' && ev.transfer) sections.push(`### Earlier context (transferred from ${ev.transfer.fromClaude})\n\n${clip(text, messageMax)}`);
    else if (ev.kind === 'user' && ev.actor) sections.push(`### Message from ${ev.actorLabel ? `${ev.actor} “${ev.actorLabel}”` : ev.actor}\n\n${clip(text, messageMax)}`);
    else sections.push(`### ${ev.kind === 'user' ? 'You' : 'Claude'}\n\n${clip(text, messageMax)}`);
  }
  flushTools();

  // Newest first until the budget runs out; a tools line belongs to the message before it.
  const kept: string[] = [];
  let size = 0;
  let truncated = false;
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i]!;
    if (size + s.length > maxChars && kept.length) {
      truncated = true;
      break;
    }
    kept.unshift(s);
    size += s.length + 2;
  }
  if (kept[0]?.startsWith('_Tools used')) kept.shift();
  const messages = kept.filter((s) => s.startsWith('### ')).length;
  return { text: redact(kept.join('\n\n')), messages, truncated };
}

/** The context file's per-message clip (T-781, D5): a whole long answer, not the opening's 4,000. */
export const FILE_MESSAGE_MAX_CHARS = 20_000;
/** The context file's total bound (T-781): about 4 MB of text; past it the oldest whole messages are left out and the file says so. */
export const FILE_MAX_CHARS = 4_000_000;

/** The conversation for the context file: every stored message (redacted, tools summarised), bounded per message and in total; the opening keeps its own, smaller budget. */
export function transferFileConversation(events: ChatEvent[]): TransferConversation {
  return transferConversation(events, FILE_MAX_CHARS, FILE_MESSAGE_MAX_CHARS);
}

/**
 * How much conversation the opening can carry. The event store cuts a stored text at `limit`
 * (`EVENT_TEXT_MAX`), and the transcript shows what is stored, so the opening, framing included, has to
 * fit: a longer one would reach Claude whole but show without its newest messages.
 */
export function conversationBudget(meta: TransferMeta, limit: number, note?: string): number {
  const framing = transferOpening(meta, { text: '', messages: 0, truncated: true }, note, { messages: 999_999, truncated: true }).length;
  return Math.max(MIN_BUDGET_CHARS, limit - framing - 200);
}

/** A handoff note as it's carried: redacted, one block, bounded. Empty when there's nothing to carry. */
export function cleanNote(raw: string | undefined): string {
  return clip(redact((raw ?? '').replace(/\r\n?/g, '\n').trim()), NOTE_MAX_CHARS);
}

/** The context file on the workspace volume (FR12): who, when and where, then the conversation. No credential, path to one, or environment value. */
export function transferFile(meta: TransferMeta, convo: TransferConversation, handoffNote?: string, facts: string[] = []): string {
  const noteText = cleanNote(handoffNote);
  const rows: [string, string][] = [
    ['Handoff', meta.handoffId],
    ['Transferred', meta.at.toISOString()],
    ['Workspace', meta.workspaceId],
    ['Folder', meta.cwd],
    ['From', `${meta.fromClaude} (session ${meta.sourceSessionId})`],
    ['To', meta.toClaude],
  ];
  const table = ['| | |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, '\\|')} |`)].join('\n');
  const note = convo.truncated ? `The last ${convo.messages} messages; older ones were left out.` : `${convo.messages} ${convo.messages === 1 ? 'message' : 'messages'}.`;
  const handoff = noteText ? `## Handoff from ${meta.fromClaude}\n\nWritten by that Claude when asked, before the move.\n\n${noteText}\n\n` : '';
  const known = facts.length ? `## What the portal knows\n\n${facts.map((f) => `- ${f.replace(/\s+/g, ' ')}`).join('\n')}\n\n` : '';
  return redact(`# Context transfer\n\n${table}\n\n${handoff}${known}## Conversation so far\n\n${convo.messages ? `${note}\n\n${convo.text}` : 'No messages yet.'}\n`);
}

/**
 * The successor's first message (FR13): the carried conversation, framed as prior context from the
 * named Claude rather than a request. Claude is asked only to confirm where things stand, so the
 * first turn is short and the person sees that the context arrived.
 */
export function transferOpening(meta: TransferMeta, convo: TransferConversation, handoffNote?: string, file?: Pick<TransferConversation, 'messages' | 'truncated'>): string {
  const noteText = cleanNote(handoffNote);
  const lines = [
    `<transferred_context from="${attr(meta.fromClaude)}" to="${attr(meta.toClaude)}">`,
    `This chat continues a conversation that ran on another Claude ("${meta.fromClaude}") on this workspace. The portal moved it here; nothing below is a new request.`,
    '',
    `- Working folder: ${meta.cwd}`,
    `- Context file: ${meta.path}`,
    ...(convo.truncated ? [`- Only the last ${convo.messages} messages are included; older ones were left out.`] : []),
    // What the file holds is said as it is: when it hit its own bound the oldest messages are missing from it too (T-781).
    file?.truncated
      ? `- The context file holds the last ${file.messages} messages of the conversation (older ones were left out of it too): Read it (use offset and limit for a long one) before you continue.`
      : '- The whole conversation, every message, is in the context file: Read it (use offset and limit for a long one) before you continue.',
    '',
    'Read it as prior context. Apart from reading the context file, do not run tools or change files. Reply with one short line saying you have it and what the next step is, then wait for my next message.',
    '',
    ...(noteText ? [`<handoff_note from="${attr(meta.fromClaude)}">`, 'Written by that Claude, with the whole conversation in view, when the portal asked for a handoff before moving it.', fence(noteText), '</handoff_note>', ''] : []),
    '<conversation>',
    convo.messages ? fence(convo.text) : '(No messages yet.)',
    '</conversation>',
    '</transferred_context>',
  ];
  return redact(lines.join('\n'));
}

const attr = (v: string) => v.replace(/["<>&]/g, '');

/** The conversation can't close its own tags: a literal one in carried text reads as text. */
const fence = (text: string) => text.replace(/<(\/?(?:conversation|transferred_context|handoff_note))[^>]*>/gi, '&lt;$1&gt;');
