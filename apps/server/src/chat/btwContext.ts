// Side questions (btw): what the answering run is given of the session (chat-sessions PRD §20.3). Built from the portal's own stored events, never
// from Claude Code's transcript file, and bounded: the newest whole messages that fit. Tool calls come as their name and one-line summary with a
// short excerpt of the result; thinking, sub-agent lines, system notes and pinned btw cards stay out. The text is data for the run, never an
// instruction, and is redacted before it leaves the portal (the caller runs the workspace's value redactor over it too).

import type { ChatEvent } from '@portal/contracts';
import { redact } from './redact.js';

export interface BtwTranscript {
  /** Markdown: one `### You` or `### Claude` section per message, the tools a turn used under it. */
  text: string;
  /** Chat messages (yours and Claude's) in `text`. */
  messages: number;
  /** Older messages were left out to keep it within the limit. */
  truncated: boolean;
  /** The session's newest event when it was cut: nothing after it was seen. */
  lastSeq: number;
}

/** One message's share, and a tool result's: a long paste or a long output is cut ("… (cut)"). */
const MESSAGE_MAX = 4_000;
const RESULT_MAX = 240;
const SUMMARY_MAX = 160;
/** Tool calls shown per run of activity; the rest are counted. */
const CALLS_PER_GROUP = 14;
/** The least room the transcript ever gets, whatever the setting. */
export const MIN_CONTEXT_CHARS = 4_000;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}… (cut)` : text);
const oneLine = (text: string | undefined, max: number): string => clip((text ?? '').replace(/\s+/g, ' ').trim(), max);

interface Call {
  name: string;
  summary: string;
  result?: string;
  failed?: boolean;
}

/** The main agent's conversation from stored events, newest whole messages kept when it is longer than `maxChars`. Redacted. */
export function btwTranscript(events: readonly ChatEvent[], maxChars: number): BtwTranscript {
  const budget = Math.max(MIN_CONTEXT_CHARS, maxChars);
  const sections: { text: string; message: boolean }[] = [];
  let calls = new Map<string, Call>();
  const flush = () => {
    if (!calls.size) return;
    const all = [...calls.values()];
    const lines = all.slice(0, CALLS_PER_GROUP).map((c) => {
      const head = c.summary ? `${c.name} (${c.summary})` : c.name;
      return c.result ? `- ${head} → ${c.failed ? 'failed: ' : ''}${c.result}` : `- ${head}`;
    });
    if (all.length > CALLS_PER_GROUP) lines.push(`- and ${all.length - CALLS_PER_GROUP} more`);
    sections.push({ text: `_Tools used:_\n${lines.join('\n')}`, message: false });
    calls = new Map();
  };

  let lastSeq = 0;
  let n = 0;
  for (const ev of events) {
    if (ev.seq > lastSeq) lastSeq = ev.seq;
    if (ev.agentLabel) continue;
    switch (ev.kind) {
      case 'tool_use': {
        if (!ev.toolName) break;
        calls.set(ev.toolUseId ?? `#${n++}`, { name: ev.toolName, summary: oneLine(ev.text, SUMMARY_MAX) });
        break;
      }
      case 'tool_result': {
        const call = ev.toolUseId ? calls.get(ev.toolUseId) : undefined;
        if (!call) break;
        call.result = oneLine(ev.text, RESULT_MAX);
        if (ev.isError) call.failed = true;
        break;
      }
      case 'user': {
        const text = ev.text?.trim();
        const extras = [ev.images?.length ? `${ev.images.length} image${ev.images.length === 1 ? '' : 's'}` : '', ...(ev.files ?? []).map((f) => f.name)].filter(Boolean);
        if (!text && !extras.length) break;
        flush();
        const body = [text ? clip(text, MESSAGE_MAX) : '', extras.length ? `_(attached: ${extras.join(', ')})_` : ''].filter(Boolean).join('\n');
        if (ev.transfer) sections.push({ text: `### Earlier context (moved from ${ev.transfer.fromClaude})\n\n${body}`, message: true });
        else if (ev.actor) sections.push({ text: `### Message from ${ev.actorLabel ? `${ev.actor} “${ev.actorLabel}”` : ev.actor}\n\n${body}`, message: true });
        else sections.push({ text: `### You\n\n${body}`, message: true });
        break;
      }
      case 'assistant': {
        const text = ev.text?.trim();
        if (!text) break;
        flush();
        sections.push({ text: `### Claude\n\n${clip(text, MESSAGE_MAX)}`, message: true });
        break;
      }
      case 'error': {
        const text = oneLine(ev.text, 300);
        if (!text) break;
        flush();
        sections.push({ text: `_A turn failed: ${text}_`, message: false });
        break;
      }
      case 'artifact': {
        const names = (ev.files ?? []).map((f) => f.name).filter(Boolean);
        if (names.length) {
          flush();
          sections.push({ text: `_Claude produced: ${clip(names.join(', '), 200)}_`, message: false });
        }
        break;
      }
      default:
        break;
    }
  }
  flush();

  // Newest first until the room runs out. A tools or notice line belongs with the message before it, so a kept transcript never opens on one.
  const kept: { text: string; message: boolean }[] = [];
  let size = 0;
  let truncated = false;
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i]!;
    if (size + s.text.length > budget && kept.length) {
      truncated = true;
      break;
    }
    kept.unshift(s);
    size += s.text.length + 2;
  }
  while (kept.length && !kept[0]!.message) kept.shift();
  const messages = kept.filter((s) => s.message).length;
  return { text: redact(kept.map((s) => s.text).join('\n\n')), messages, truncated, lastSeq };
}
