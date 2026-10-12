import { AppError } from '@isnanme/core';
import {
  approxTokens,
  PERSONA_AGENT_NAME,
  PERSONA_EFFORTS,
  PERSONA_LIMITS,
  PERSONA_MODEL,
  PERSONA_STYLE_NAME,
  PERSONA_TOOL,
  type PersonaAgent,
  type PersonaContent,
  type PersonaEffort,
  type PersonaStyle,
} from '@portal/contracts';
import { redact } from '../chat/redact.js';
import { CompileError } from '../delivery/compile.js';
import type { DeliveredDir, DeliveredFile, Fragment } from '../delivery/types.js';
import { ROOT } from '../delivery/types.js';
import type { AssignedPool, KindContext, ParseContext, PoolKind } from '../pools/kinds.js';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import { agentFile, AGENTS_DIR, chatPromptFile, instructionsFile, PERSONA_STAMP, personaSettings, STYLES_DIR, stamped, styleFile } from './render.js';

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
/** Control characters other than tab and line breaks, C1 controls, and the Unicode line and paragraph separators (a YAML parser may read those as line breaks in a one-line field). */
export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
/** Characters that hide or reorder text; none belongs in an instruction anyone reads (Skillset §11.1, MCP §16). */
export const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\u{e0000}-\u{e007f}]/u;

/** FR8: persona text sits in world-readable managed files and goes to the model provider with every request. */
export function secretProblem(text: string): string | null {
  return redact(text) === text ? null : 'This looks like a secret (a key, a token, a private key). Instructions are readable by everyone who uses the workspace and go to the model provider with every request: keep secrets in Secrets & env.';
}

/** A one-line field: no line breaks, no control or invisible characters. */
function oneLine(input: unknown, field: string, max: number, opts: { required?: boolean } = {}): string {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s) {
    if (opts.required) throw invalid(field, 'Fill this in.');
    return '';
  }
  if (s.length > max) throw invalid(field, `Use at most ${max} characters.`);
  if (/[\r\n]/.test(s) || CONTROL.test(s) || INVISIBLE.test(s)) throw invalid(field, 'Use one line without control or invisible characters.');
  const secret = secretProblem(s);
  if (secret) throw invalid(field, secret);
  return s;
}

/** Markdown text: bytes capped, no control characters but tabs and line breaks, nothing credential-shaped. */
function markdown(input: unknown, field: string, maxBytes: number): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') throw invalid(field, 'Use text.');
  const s = input.replace(/\r\n/g, '\n');
  if (bytes(s) > maxBytes) throw invalid(field, `Use at most ${Math.round(maxBytes / 1024)} KB.`);
  if (CONTROL.test(s) || INVISIBLE.test(s)) throw invalid(field, 'Remove the control and invisible characters.');
  const secret = secretProblem(s);
  if (secret) throw invalid(field, secret);
  return s.replace(/\s+$/, '');
}

function effort(input: unknown, field: string): PersonaEffort | null {
  if (input === undefined || input === null || input === '') return null;
  if (!PERSONA_EFFORTS.includes(input as PersonaEffort)) throw invalid(field, 'Pick low, medium, high or xhigh.');
  return input as PersonaEffort;
}

function model(input: unknown, field: string, allowInherit: boolean): string {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s) return '';
  if (s === 'inherit') {
    if (!allowInherit) throw invalid(field, 'Pick an alias like opus, or a model ID.');
    return s;
  }
  if (!PERSONA_MODEL.test(s)) throw invalid(field, 'Use an alias (opus, sonnet, haiku) or a model ID, like claude-sonnet-4-6.');
  return s;
}

function toolList(input: unknown, field: string): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((t) => typeof t !== 'string')) throw invalid(field, 'Use a list of tool names.');
  const out = [...new Set((input as string[]).map((t) => t.trim()).filter(Boolean))];
  if (out.length > 60) throw invalid(field, 'Use at most 60 tools.');
  for (const t of out) if (!PERSONA_TOOL.test(t)) throw invalid(field, `“${t}” isn’t a tool name Claude Code reads.`);
  return out;
}

/**
 * The persona pool type (Persona PRD, P1 and P2): instructions as the managed CLAUDE.md, output styles,
 * subagents, a default model and effort, a chat prompt for the session runner, and the instruction contexts
 * it holds. A workspace has one persona or none (`single`). Every save is an immutable revision: a draft
 * until it's published (the pool service's `approve`), and only a published persona can be assigned
 * (FR10). Personas hold no secrets, so they're edited and previewed while the portal is Locked (§9).
 *
 * Delivery (§10.1) writes only what the persona sets, as root-owned 0644 files Claude Code reads itself:
 * `/etc/claude-code/CLAUDE.md` (added to the repository's and the user's, never replacing them), the styles
 * and subagents folders, and `50-claudepilot-persona.json` with `outputStyle`, `model` and `effortLevel`.
 */
export class PersonaKind implements PoolKind<PersonaContent> {
  readonly type = 'persona' as const;
  readonly single = true;

  constructor(
    private readonly store: Store,
    private readonly service: () => PoolService,
  ) {}

  /* ---------- Content ---------- */

  parse(input: unknown, prev: PersonaContent | null, _ctx?: ParseContext): PersonaContent {
    void prev;
    const i = isObject(input) ? input : {};
    const instructions = markdown(i.instructions, 'instructions', PERSONA_LIMITS.instructionsBytes);
    const chatPrompt = markdown(i.chatPrompt, 'chatPrompt', PERSONA_LIMITS.chatPromptBytes);

    if (i.styles !== undefined && !Array.isArray(i.styles)) throw invalid('styles', 'Send the list of styles.');
    const rawStyles = (i.styles ?? []) as unknown[];
    if (rawStyles.length > PERSONA_LIMITS.styles) throw invalid('styles', `Use at most ${PERSONA_LIMITS.styles} output styles.`);
    const styleNames = new Set<string>();
    const styles = rawStyles.map((raw, n): PersonaStyle => {
      const f = `styles.${n}`;
      if (!isObject(raw)) throw invalid(f, 'Each style needs a name and a body.');
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (!PERSONA_STYLE_NAME.test(name)) throw invalid(`${f}.name`, 'Use letters, digits and hyphens, starting with a letter (at most 40 characters).');
      if (styleNames.has(name.toLowerCase())) throw invalid(`${f}.name`, `“${name}” is used twice.`);
      styleNames.add(name.toLowerCase());
      return {
        name,
        description: oneLine(raw.description, `${f}.description`, PERSONA_LIMITS.description),
        keepCodingInstructions: raw.keepCodingInstructions !== false,
        body: markdown(raw.body, `${f}.body`, 20 * 1024),
      };
    });
    const defaultStyle = typeof i.defaultStyle === 'string' && i.defaultStyle.trim() ? i.defaultStyle.trim() : null;
    if (defaultStyle && !styles.some((s) => s.name === defaultStyle)) throw invalid('defaultStyle', 'The default style has to be one of the persona’s styles.');

    if (i.agents !== undefined && !Array.isArray(i.agents)) throw invalid('agents', 'Send the list of subagents.');
    const rawAgents = (i.agents ?? []) as unknown[];
    if (rawAgents.length > PERSONA_LIMITS.agents) throw invalid('agents', `Use at most ${PERSONA_LIMITS.agents} subagents.`);
    const agentNames = new Set<string>();
    const agents = rawAgents.map((raw, n): PersonaAgent => {
      const f = `agents.${n}`;
      if (!isObject(raw)) throw invalid(f, 'Each subagent needs a name, a description and a prompt.');
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (!PERSONA_AGENT_NAME.test(name)) throw invalid(`${f}.name`, 'Use lowercase letters, digits and hyphens, starting with a letter (at most 40 characters).');
      if (agentNames.has(name)) throw invalid(`${f}.name`, `“${name}” is used twice.`);
      agentNames.add(name);
      const maxTurns = raw.maxTurns === undefined || raw.maxTurns === null || raw.maxTurns === '' ? null : Number(raw.maxTurns);
      if (maxTurns !== null && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 200)) throw invalid(`${f}.maxTurns`, 'Use a whole number from 1 to 200.');
      const prompt = markdown(raw.prompt, `${f}.prompt`, 20 * 1024);
      if (!prompt) throw invalid(`${f}.prompt`, 'Write the subagent’s prompt.');
      return {
        name,
        description: oneLine(raw.description, `${f}.description`, PERSONA_LIMITS.description, { required: true }),
        prompt,
        tools: toolList(raw.tools, `${f}.tools`),
        disallowedTools: toolList(raw.disallowedTools, `${f}.disallowedTools`),
        model: model(raw.model, `${f}.model`, true),
        effort: effort(raw.effort, `${f}.effort`),
        maxTurns,
      };
    });

    const contextIds = i.contexts === undefined || i.contexts === null ? [] : i.contexts;
    if (!Array.isArray(contextIds) || contextIds.some((c) => typeof c !== 'string')) throw invalid('contexts', 'Pick contexts from the list.');
    const contexts = [...new Set(contextIds as string[])];
    if (contexts.length > PERSONA_LIMITS.contexts) throw invalid('contexts', `A persona holds at most ${PERSONA_LIMITS.contexts} contexts.`);
    for (const id of contexts) if (this.service().typeOf(id) !== 'context') throw invalid('contexts', 'One of the contexts no longer exists.');

    const content: PersonaContent = {
      instructions,
      styles,
      defaultStyle,
      agents,
      model: model(i.model, 'model', false) || null,
      effort: effort(i.effort, 'effort'),
      chatPrompt,
      contexts,
    };
    // FR3 and §10.2: a compiled persona stays well under the 1 MiB the workspace's Secret shares with every pool.
    const size = this.#files(content).reduce((n, f) => n + bytes(f.content), 0);
    if (size > PERSONA_LIMITS.compiledBytes) throw invalid('instructions', `Everything it writes adds up to ${Math.round(size / 1024)} KB: a persona may write at most ${PERSONA_LIMITS.compiledBytes / 1024} KB.`);
    return content;
  }

  view(content: PersonaContent): PersonaContent {
    return content;
  }

  /* ---------- Assignment (FR10) ---------- */

  /** Only a published persona can be assigned: a draft is nothing a workspace can get yet. */
  beforeAssign(_workspaceId: string, adding: string[]): void {
    for (const id of adding) {
      const row = this.store.db?.prepare('SELECT name, current_revision FROM pools WHERE id = ?').get(id) as { name: string; current_revision: number } | undefined;
      if (row && row.current_revision === 0) throw new AppError('CONFLICT', `${row.name} hasn’t been published yet: publish a revision first.`);
    }
  }

  /** FR11: unassigning removes every persona file and key; open sessions keep what they loaded. */
  beforeUnassign(workspaceId: string): string[] {
    return workspaceId ? ['Open sessions keep the instructions, model and effort they started with. New sessions don’t get the persona.'] : [];
  }

  /* ---------- Delivery ---------- */

  #files(c: PersonaContent): DeliveredFile[] {
    return [
      ...(c.instructions.trim() ? [instructionsFile(c.instructions)] : []),
      ...c.styles.map(styleFile),
      ...c.agents.map(agentFile),
      ...(c.chatPrompt.trim() ? [chatPromptFile(c.chatPrompt)] : []),
    ];
  }

  fragments(assigned: AssignedPool<PersonaContent>[], ctx: KindContext): Fragment[] {
    const a = assigned[0];
    if (!a) return [];
    if (assigned.length > 1) throw new CompileError('persona', 'a workspace has one persona');
    const c = a.content;
    // The folders always exist, even empty: Claude Code watches a subagents folder only if it existed when a session started (§10.2).
    const dirs: DeliveredDir[] = [AGENTS_DIR, STYLES_DIR].map((path) => ({ path, mode: 0o755, uid: ROOT, gid: ROOT }));
    const files = this.#files(c);
    // The stamp makes the drop-in change with the text, so running sessions re-read the instructions (render.ts `stamped`).
    const settings = stamped(PERSONA_STAMP, files, personaSettings(c));
    void ctx;
    return [{ owner: 'persona', pool: { id: a.pool.id, revision: a.pool.revision }, dirs, files, ...(Object.keys(settings).length ? { settings } : {}) }];
  }

  /** The persona's own part of the editor's "what Claude will be told": its instructions in the order Claude Code loads them. */
  static summary(c: PersonaContent): { lines: number; tokens: number } {
    return { lines: c.instructions ? c.instructions.split('\n').length : 0, tokens: approxTokens(c.instructions) };
  }
}
