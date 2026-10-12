import type { NoteLink } from '@portal/contracts';
import { createContext, useContext } from 'react';

/** What the note preview needs from the page around it: where links go, and how a link text resolves. */
export interface NoteEnv {
  vaultId: string;
  /** The note being shown, for the embeds' cycle check. */
  path: string;
  links: NoteLink[];
  /** The href that opens a note (and a heading or block in it). */
  href: (path: string, anchor?: { heading?: string; block?: string }) => string;
  open: (path: string, anchor?: { heading?: string; block?: string }) => void;
  /** A link to a note that doesn't exist yet: offer to make it. */
  create: (name: string) => void;
  tag: (tag: string) => void;
  /** Embedded notes inside embedded notes: depth, and the paths already on the way down. */
  depth: number;
  seen: string[];
  /** Entities named in a note, `[[ticket:T-1]]`: where each is shown in the portal (null: no page yet). */
  entityHref: (type: string, key: string) => string | null;
}

const NO = () => undefined;

export const NoteEnvContext = createContext<NoteEnv>({
  vaultId: '',
  path: '',
  links: [],
  href: () => '#',
  open: NO,
  create: NO,
  tag: NO,
  depth: 0,
  seen: [],
  entityHref: () => null,
});

export const useNoteEnv = () => useContext(NoteEnvContext);

/** The key a link text is found under: wikilinks by target (and whether embedded), Markdown links by their decoded path. */
export function linkKey(style: 'wiki' | 'md', embed: boolean, target: string): string {
  return `${style}|${embed ? '!' : ''}|${target.normalize('NFC').toLowerCase()}`;
}

export function linkIndex(links: NoteLink[]): Map<string, NoteLink> {
  const m = new Map<string, NoteLink>();
  for (const l of links) {
    const k = linkKey(l.style, l.embed, l.target);
    if (!m.has(k)) m.set(k, l);
  }
  return m;
}

/** The text of the section under a heading, or of a block, in a loaded note (for `![[Note#Heading]]`). */
export function excerptOf(content: string, headings: { level: number; text: string; line: number }[], norm: (s: string) => string, heading: string | null, block: string | null): string {
  const lines = content.split('\n');
  if (heading) {
    const want = norm(heading.split('#').pop()!);
    const at = headings.findIndex((h) => norm(h.text) === want);
    if (at < 0) return '';
    const h = headings[at]!;
    const end = headings.find((x) => x.line > h.line && x.level <= h.level)?.line ?? lines.length + 1;
    return lines.slice(h.line - 1, end - 1).join('\n');
  }
  if (block) {
    const safe = block.replace(/[^A-Za-z0-9-]/g, '');
    const i = lines.findIndex((l) => new RegExp(`(?:^|\\s)\\^${safe}\\s*$`).test(l.replace(/\r$/, '')));
    if (i < 0) return '';
    let start = i;
    while (start > 0 && lines[start - 1]!.trim() !== '') start--;
    return lines.slice(start, i + 1).join('\n');
  }
  return content;
}
