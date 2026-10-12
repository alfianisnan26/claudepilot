import type { McpBuiltinTemplate } from '@portal/contracts';
import { ExternalLink } from 'lucide-react';
import { InfoTip } from '@/components/InfoTip';

/**
 * A template's notes (prerequisites, how to register its OAuth app) behind an ⓘ, with its docs address last. The text is
 * code-defined (reviewed with the template), never typed by a person; the address is only linked when it is https.
 */
export function NotesTip({ template }: { template: McpBuiltinTemplate }) {
  return (
    <InfoTip label={`About ${template.name}`}>
      <span className="flex flex-col gap-1.5">
        {template.notes.map((note) => (
          <span key={note}>{note}</span>
        ))}
        {/^https:\/\//.test(template.docUrl) && (
          <a href={template.docUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-accent hover:underline">
            Docs <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        )}
      </span>
    </InfoTip>
  );
}
