import { ChipGroup, Segmented } from '@isnanme/ui';
import { type PersonaContent, type PersonaEffort, type PoolSummary } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { PoolContentEditorProps } from '@/features/pools/types';
import { api } from '@/lib/api';
import { AgentsEditor } from './AgentsEditor';
import { CodeArea } from './CodeArea';
import { HistoryPanel } from './HistoryPanel';
import { IdentityPanel } from './IdentityPanel';
import { EFFORT_OPTIONS } from './labels';
import { ModelPicker } from './ModelPicker';
import { LabelRow } from './parts';
import { StylesEditor } from './StylesEditor';
import { ToldPreview } from './ToldPreview';

/**
 * The persona editor's part of the shared page (Persona PRD §15): the instructions, the contexts it holds,
 * where sessions start, output styles, subagents, and a preview of what Claude is told. Name, description,
 * revision note, Save draft, Publish and Preview files come from the shared editor.
 */
export function PersonaEditor({ value, onChange, errors, disabled, pool, name }: PoolContentEditorProps<PersonaContent>) {
  const [contexts, setContexts] = useState<PoolSummary[] | null>(null);
  useEffect(() => {
    let current = true;
    api.pools.list('context').then(
      (list) => current && setContexts(list),
      () => current && setContexts([]),
    );
    return () => void (current = false);
  }, []);
  // A context deleted since this persona was saved can't be saved again: drop it quietly once the list is known.
  useEffect(() => {
    if (!contexts) return;
    const ids = new Set(contexts.map((c) => c.id));
    if (value.contexts.some((id) => !ids.has(id))) onChange({ ...value, contexts: value.contexts.filter((id) => ids.has(id)) });
    // Only when the list arrives: the editor's own changes keep ids that exist.
  }, [contexts]);

  return (
    <div className="flex flex-col gap-5">
      {pool && <IdentityPanel pool={pool} name={name ?? pool.name} />}
      <CodeArea
        label="Instructions"
        tip="Added to the repository’s and the user’s own instructions, never replacing them. They guide Claude and don’t enforce anything: what must never happen belongs in Settings."
        value={value.instructions}
        onChange={(instructions) => onChange({ ...value, instructions })}
        error={errors.instructions}
        disabled={disabled}
        rows={10}
      />

      <CodeArea
        label="Chat prompt"
        tip="Added to the system prompt of agents started from the portal’s chat, never of terminals. A resumed conversation keeps the one it started with until it is compacted."
        value={value.chatPrompt}
        onChange={(chatPrompt) => onChange({ ...value, chatPrompt })}
        error={errors.chatPrompt}
        disabled={disabled}
        rows={3}
        counter="none"
      />

      <div className="flex flex-col gap-1.5">
        <LabelRow
          label="Contexts"
          tip={
            <>
              Reusable instructions delivered with this persona. They can also be assigned to workspaces on their own.
            </>
          }
          right={
            <Link to="/admin/pools?tab=contexts" className="text-[12.5px] font-semibold text-muted hover:text-ink">
              Manage
            </Link>
          }
        />
        {contexts && contexts.length === 0 ? (
          <p className="text-[13px] text-muted">None yet.</p>
        ) : (
          <ChipGroup
            multiple
            label="Contexts"
            hideLabel
            value={value.contexts}
            onChange={(ids) => onChange({ ...value, contexts: ids })}
            options={(contexts ?? []).map((c) => ({ value: c.id, label: c.name, detail: c.revision ? undefined : 'draft' }))}
            error={errors.contexts}
          />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <LabelRow label="Starts on" tip="Where agents begin. Users can change the model and the effort in an agent, and the workspace’s limits still apply." />
        <div className="grid gap-4 sm:grid-cols-2">
          <ModelPicker label="Model" value={value.model ?? ''} onChange={(model) => onChange({ ...value, model: model || null })} error={errors.model} disabled={disabled} />
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold text-ink-soft">Effort</span>
            <Segmented<PersonaEffort | ''> label="Effort" value={value.effort ?? ''} onChange={(effort) => onChange({ ...value, effort: effort || null })} options={EFFORT_OPTIONS} />
            {errors.effort && <p className="text-[12.5px] text-danger">{errors.effort}</p>}
          </div>
        </div>
      </div>

      <StylesEditor value={value} onChange={onChange} errors={errors} disabled={disabled} />
      <AgentsEditor value={value} onChange={onChange} errors={errors} disabled={disabled} />
      <ToldPreview value={value} contexts={contexts ?? []} />
      {pool && pool.latestRevision > 0 && <HistoryPanel pool={pool} value={value} onRestore={onChange} />}
    </div>
  );
}
