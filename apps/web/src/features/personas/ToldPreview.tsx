import type { PersonaContent, PoolSummary } from '@portal/contracts';
import { InfoTip } from '@/components/InfoTip';
import { contextContent, lineCount } from './labels';
import { Disclosure, MONO } from './parts';

interface Layer {
  what: string;
  detail?: string;
  /** Where the text comes from: the portal's own copy, or a file in the workspace. */
  from: 'portal' | 'workspace';
}

/**
 * "What Claude will be told" in the editor (Persona PRD §13.1, P1): the layers in the order Claude Code
 * loads them, with the persona's own text counted and the user's and the repository's marked as theirs.
 * Built from the editor's content as it is now, so it needs no save. What a given workspace really
 * loads is read from that workspace (not built yet).
 */
export function ToldPreview({ value, contexts }: { value: PersonaContent; contexts: PoolSummary[] }) {
  const held = value.contexts.map((id) => contexts.find((c) => c.id === id)).filter((c): c is PoolSummary => !!c);
  const instructions: Layer[] = [
    ...(value.instructions.trim() ? [{ what: 'Persona', detail: `${lineCount(value.instructions)} lines`, from: 'portal' as const }] : []),
    ...held.map((c) => ({ what: c.name, detail: `${lineCount(contextContent(c)?.body ?? '')} lines`, from: 'portal' as const })),
    { what: '~/.claude/CLAUDE.md', from: 'workspace' },
    { what: 'Repository CLAUDE.md', from: 'workspace' },
    { what: 'CLAUDE.local.md', from: 'workspace' },
  ];
  const style = value.defaultStyle ?? 'the user’s own choice';
  const start = [value.model || 'Claude Code’s model', value.effort ? `${value.effort} effort` : 'its usual effort'].join(', ');
  return (
    <Disclosure
      summary={<span className="text-sm font-semibold">What Claude is told</span>}
      trailing={
        <InfoTip label="About the order">
          Instructions in the order Claude Code loads them. Every file is added and none replaces another: the persona’s text comes first, then the user’s and the repository’s own. When two disagree Claude may follow either, so build commands and code style belong in the repository’s CLAUDE.md.
        </InfoTip>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <ol className="flex flex-col divide-y divide-line rounded-xl border border-line">
          {instructions.map((l, i) => (
            <li key={`${l.what}-${i}`} className="flex items-baseline gap-2 px-3 py-2">
              <span className="w-4 shrink-0 text-[12px] text-muted">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate" style={l.from === 'workspace' ? { fontFamily: MONO, fontSize: 12.5 } : undefined}>
                {l.what}
              </span>
              <span className="shrink-0 text-[12px] text-muted">{l.detail ?? (l.from === 'workspace' ? 'workspace' : '')}</span>
            </li>
          ))}
        </ol>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted">Style</dt>
          <dd>{style}</dd>
          <dt className="text-muted">Subagents</dt>
          <dd className="min-w-0 break-words">{value.agents.length ? value.agents.map((a) => a.name).join(', ') : 'none'}</dd>
          <dt className="text-muted">Starts on</dt>
          <dd>{start}</dd>
        </dl>
      </div>
    </Disclosure>
  );
}
