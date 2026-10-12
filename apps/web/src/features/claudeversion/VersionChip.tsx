import type { WorkspaceClaudeBrief } from '@portal/contracts';
import { FLAG_TEXT } from './labels';

/** The note for the chip's title and its screen-reader name: what runs, what it is pinned to, and what looks wrong. */
export function versionNote(c: WorkspaceClaudeBrief): string {
  const parts = [`Claude Code ${c.running ?? 'unknown'}`];
  if (c.pinned && c.pinned !== c.running) parts.push(`pinned ${c.pinned}`);
  return [parts.join(', '), ...c.flags.map((f) => FLAG_TEXT[f])].join('. ');
}

/**
 * The workspace's Claude Code version, compact: the running version (else the pinned one, else "unknown"), with a dot when
 * something looks wrong. Detail is in the workspace's Configuration. Unknown is shown as unknown, never guessed.
 */
export function VersionChip({ claude }: { claude: WorkspaceClaudeBrief | null | undefined }) {
  if (!claude) return null;
  const shown = claude.running ?? claude.pinned;
  const warn = claude.flags.some((f) => f !== 'untested');
  const note = versionNote(claude);
  return (
    <span title={note} aria-label={note} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[11.5px] text-ink-soft">
      {warn && <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />}
      {shown ?? 'unknown'}
    </span>
  );
}
