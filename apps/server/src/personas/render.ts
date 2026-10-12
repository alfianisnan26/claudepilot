import { createHash } from 'node:crypto';
import type { PersonaAgent, PersonaContent, PersonaStyle } from '@portal/contracts';
import type { DeliveredFile } from '../delivery/types.js';
import { ROOT } from '../delivery/types.js';

/**
 * The files a persona or a context becomes (Persona PRD §10.1). Frontmatter is generated from validated
 * fields by a serializer, never by pasting text into a template (FR12): every value is a JSON string, which
 * is also a valid YAML double-quoted scalar, so a quote, a colon or a `#` in a description can't change
 * what the file says.
 */

/** `key: "value"` lines between `---` fences, then the body. Values are one-line strings, numbers or booleans. */
export function withFrontmatter(fields: [string, string | number | boolean | undefined][], body: string): string {
  const lines = fields.filter((f): f is [string, string | number | boolean] => f[1] !== undefined).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
  return `---\n${lines.join('\n')}\n---\n${body.replace(/\r\n/g, '\n').replace(/\s+$/, '')}\n`;
}

const file = (path: string, content: string): DeliveredFile => ({ path, content, mode: 0o644, uid: ROOT, gid: ROOT });

export const MANAGED_CLAUDE_MD = '/etc/claude-code/CLAUDE.md';
export const STYLES_DIR = '/etc/claude-code/.claude/output-styles';
export const AGENTS_DIR = '/etc/claude-code/.claude/agents';
export const CHAT_PROMPT = '/etc/claudepilot/persona/chat-prompt.md';
/** Instruction contexts are managed rule files, which Claude Code loads next to the managed CLAUDE.md. */
export const RULES_DIR = '/etc/claude-code/.claude/rules';
export const CONTEXT_PREFIX = 'cpx-';

export const styleFile = (s: PersonaStyle): DeliveredFile =>
  file(`${STYLES_DIR}/${s.name}.md`, withFrontmatter([['name', s.name], ['description', s.description], ['keep-coding-instructions', s.keepCodingInstructions]], s.body));

export const agentFile = (a: PersonaAgent): DeliveredFile =>
  file(
    `${AGENTS_DIR}/${a.name}.md`,
    withFrontmatter(
      [
        ['name', a.name],
        ['description', a.description],
        ['model', a.model || undefined],
        ['effort', a.effort ?? undefined],
        ['maxTurns', a.maxTurns ?? undefined],
        // Left out when empty: an agent with an empty `tools` line would get no tools, while a missing one inherits them all.
        ['tools', a.tools.length ? a.tools.join(', ') : undefined],
        ['disallowedTools', a.disallowedTools.length ? a.disallowedTools.join(', ') : undefined],
      ],
      a.prompt,
    ),
  );

/** The managed CLAUDE.md: the instructions, as written. It adds to the repository's and the user's; nothing replaces them. */
export const instructionsFile = (instructions: string): DeliveredFile => file(MANAGED_CLAUDE_MD, `${instructions.replace(/\r\n/g, '\n').replace(/\s+$/, '')}\n`);

export const chatPromptFile = (prompt: string): DeliveredFile => file(CHAT_PROMPT, `${prompt.replace(/\r\n/g, '\n').replace(/\s+$/, '')}\n`);

/** An instruction context as a managed rule file. The comment says where it came from and is stripped before Claude reads the file. */
export const contextFile = (slug: string, name: string, revision: number, body: string): DeliveredFile =>
  file(`${RULES_DIR}/${CONTEXT_PREFIX}${slug}.md`, `<!-- Instruction context “${name.replace(/-->/g, '')}” r${revision}, delivered by the portal. -->\n${body.replace(/\r\n/g, '\n').replace(/\s+$/, '')}\n`);

/** The managed-settings keys a persona sets, only the ones it uses (§10.1): an empty persona writes no drop-in. */
export function personaSettings(c: PersonaContent): Record<string, unknown> {
  return {
    ...(c.defaultStyle ? { outputStyle: c.defaultStyle } : {}),
    ...(c.model ? { model: c.model } : {}),
    ...(c.effort ? { effortLevel: c.effort } : {}),
  };
}

/** The variable a drop-in carries so its content changes whenever the files beside it do (see `stamped`). */
export const PERSONA_STAMP = 'CLAUDEPILOT_PERSONA';
export const CONTEXT_STAMP = 'CLAUDEPILOT_CONTEXT';

/**
 * A running Claude Code session re-reads the managed instruction files (the managed CLAUDE.md and rules)
 * when a drop-in in `managed-settings.d` changes, and only then: a file edited alone is never seen until
 * the next session (✅ 2.1.296, PRD §11; the re-read shows at the session's next message, 2 to 4 s later,
 * "Instruction files were re-read after the organization's managed settings changed"). So a drop-in that
 * delivers instructions also carries a stamp of everything this owner delivers: the settings key that
 * changes whenever the text does. The stamp is a hash of paths and contents, never of the time, so equal
 * content gives an equal desired hash and nothing is written twice.
 */
export function stampOf(files: DeliveredFile[], settings: Record<string, unknown>): string {
  const h = createHash('sha256');
  h.update(JSON.stringify(settings));
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) h.update(`\0${f.path}\0${f.content}`);
  return h.digest('hex').slice(0, 12);
}

/** `settings` with the stamp added, or `{}` when this owner delivers nothing (an empty persona changes nothing, so it writes no drop-in). */
export function stamped(name: typeof PERSONA_STAMP | typeof CONTEXT_STAMP, files: DeliveredFile[], settings: Record<string, unknown>): Record<string, unknown> {
  if (files.length === 0 && Object.keys(settings).length === 0) return {};
  return { ...settings, env: { [name]: stampOf(files, settings) } };
}

/** The file name for a context: `Coding standards` → `coding-standards`. */
export const contextSlug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '') || 'context';

