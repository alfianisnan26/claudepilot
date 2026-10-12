import { PERSONA_EFFORTS, type ContextContent, type PersonaContent, type PersonaEffort, type PoolSummary, type WorkspacePersona } from '@portal/contracts';

/** The aliases Claude Code resolves for every endpoint (Persona PRD FR5); anything else is a model ID. */
export const MODEL_ALIASES = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
] as const;

export const EFFORT_LABEL: Record<PersonaEffort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh' };
export const EFFORT_OPTIONS: { value: PersonaEffort | ''; label: string }[] = [{ value: '', label: 'Default' }, ...PERSONA_EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e] }))];

/** Claude Code's own tools a subagent can be limited to. MCP tools and rules like `Bash(npm test:*)` go in the free field. */
export const BUILT_IN_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch'] as const;

const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
export const lineCount = (text: string) => (text.trim() ? text.split('\n').length : 0);

export const personaContent = (p: PoolSummary): PersonaContent | null => (p.content as PersonaContent | null) ?? null;
export const contextContent = (p: PoolSummary): ContextContent | null => (p.content as ContextContent | null) ?? null;

/** "48 lines · Terse · 3 subagents · opus, high · 2 contexts" on a persona's card and Configuration row (PRD §15). */
export function partsLine(c: Pick<PersonaContent, 'instructions' | 'styles' | 'defaultStyle' | 'agents' | 'model' | 'effort'> & { contexts?: unknown[] }): string {
  const lines = lineCount(c.instructions);
  const start = [c.model, c.effort].filter(Boolean).join(', ');
  return [
    lines > 0 && n(lines, 'line'),
    c.defaultStyle ? c.defaultStyle : c.styles.length > 0 ? n(c.styles.length, 'style') : '',
    c.agents.length > 0 && n(c.agents.length, 'subagent'),
    start,
    (c.contexts?.length ?? 0) > 0 && n(c.contexts!.length, 'context'),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The same line for what a workspace's persona sets (the I5 read API has names, not the text). */
export function workspacePartsLine(p: WorkspacePersona['parts']): string {
  return [
    p.instructionLines > 0 && n(p.instructionLines, 'line'),
    p.defaultStyle ?? (p.styles.length > 0 ? n(p.styles.length, 'style') : ''),
    p.agents.length > 0 && n(p.agents.length, 'subagent'),
    [p.model, p.effort].filter(Boolean).join(', '),
  ]
    .filter(Boolean)
    .join(' · ');
}
