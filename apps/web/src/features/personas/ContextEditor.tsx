import { PERSONA_LIMITS, type ContextContent } from '@portal/contracts';
import type { PoolContentEditorProps } from '@/features/pools/types';
import { CodeArea } from './CodeArea';
import { HistoryPanel } from './HistoryPanel';

/**
 * An instruction context's part of the shared editor (Persona PRD A9): its text and its history. It is delivered
 * as a managed rule file, next to the persona's own instructions and ahead of the repository's and the user's.
 */
export function ContextEditor({ value, onChange, errors, disabled, pool }: PoolContentEditorProps<ContextContent>) {
  return (
    <div className="flex flex-col gap-5">
      <CodeArea
        label="Instructions"
        tip={`Delivered as its own managed rule file, added to the repository’s and the user’s instructions, never replacing them. At most ${PERSONA_LIMITS.contextBytes / 1024} KB: split a longer one into several contexts.`}
        value={value.body}
        onChange={(body) => onChange({ ...value, body })}
        error={errors.body}
        disabled={disabled}
        rows={10}
      />
      {pool && pool.latestRevision > 0 && <HistoryPanel pool={pool} value={value} onRestore={onChange} />}
    </div>
  );
}
