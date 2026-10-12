import type { McpBuiltinId } from '@portal/contracts';
import { Plug } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * One small mark per built-in template, drawn inline (the contract says no external images) in `currentColor`, so a mark
 * follows the theme. They are plain geometric stand-ins that tell the providers apart at 20 px, not the providers' logos.
 */
const MARKS: Record<McpBuiltinId, { viewBox: string; body: ReactNode }> = {
  github: {
    viewBox: '0 0 16 16',
    body: (
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    ),
  },
  // A fox head: two ears and a chin.
  gitlab: { viewBox: '0 0 24 24', body: <path d="M12 21.5 2.3 11.2 5.1 3l3.1 7h7.6l3.1-7 2.8 8.2z" /> },
  // A tea cup with steam.
  gitea: {
    viewBox: '0 0 24 24',
    body: (
      <>
        <path d="M3.5 8.5h13v4.2a5.8 5.8 0 0 1-5.8 5.8H9.3a5.8 5.8 0 0 1-5.8-5.8z" />
        <path d="M16.5 10h1.6a2.4 2.4 0 0 1 0 4.8h-1.9M7 3.5v2M10 3.5v2M13 3.5v2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
  // A ring: Outline's "O".
  outline: { viewBox: '0 0 24 24', body: <circle cx="12" cy="12" r="6.9" fill="none" stroke="currentColor" strokeWidth="3.2" /> },
  cloudflare: { viewBox: '0 0 24 24', body: <path d="M18.2 18.5H6.4a4.2 4.2 0 0 1-.8-8.3 5.6 5.6 0 0 1 10.7-1.2 4.8 4.8 0 0 1 1.9 9.5z" /> },
};

export function BuiltinIcon({ id, className = 'size-5' }: { id: McpBuiltinId; className?: string }) {
  const mark = MARKS[id];
  // A template this web build has no mark for (a newer server): a plain plug, so the card is never blank.
  if (!mark) return <Plug className={className} aria-hidden="true" />;
  return (
    <svg viewBox={mark.viewBox} fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      {mark.body}
    </svg>
  );
}
