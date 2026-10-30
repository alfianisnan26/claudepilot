import { Button, ChipGroup, Segmented, TextField } from '@isnanme/ui';
import { PERSONA_LIMITS, type PersonaAgent, type PersonaContent, type PersonaEffort } from '@portal/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { InfoTip } from '@/components/InfoTip';
import { CodeArea } from './CodeArea';
import { BUILT_IN_TOOLS, EFFORT_OPTIONS } from './labels';
import { ModelPicker } from './ModelPicker';
import { Disclosure, LabelRow, MONO } from './parts';

const NEW_AGENT: PersonaAgent = { name: '', description: '', prompt: '', tools: [], disallowedTools: [], model: '', effort: null, maxTurns: null };
const BUILT_IN = new Set<string>(BUILT_IN_TOOLS);

function freeName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

/** The tools that aren't built in, as the free field shows them. */
const otherTools = (tools: string[]) => tools.filter((t) => !BUILT_IN.has(t)).join(', ');
const splitTools = (text: string) => [...new Set(text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean))];

/**
 * Subagents (Persona PRD FR4, P2): helpers Claude can hand work to, each with its own prompt. Never a
 * permission mode, hooks, MCP servers or skills of their own (§6 rule 2). Up to twenty.
 */
export function AgentsEditor({ value, onChange, errors, disabled }: { value: PersonaContent; onChange: (next: PersonaContent) => void; errors: Record<string, string>; disabled: boolean }) {
  const agents = value.agents;
  const set = (i: number, next: PersonaAgent) => onChange({ ...value, agents: agents.map((a, j) => (j === i ? next : a)) });
  return (
    <div className="flex flex-col gap-2">
      <LabelRow
        label="Subagents"
        tip="Helpers Claude can hand work to, each with its own prompt. They run in the agent’s permission mode and never get hooks, MCP servers or skills of their own. A subagent here hides a repository or user subagent with the same name."
        right={
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="size-4" />}
            aria-label="Add a subagent"
            onClick={() => onChange({ ...value, agents: [...agents, { ...NEW_AGENT, name: freeName('helper', agents.map((a) => a.name)) }] })}
            disabled={disabled || agents.length >= PERSONA_LIMITS.agents}
          >
            Add
          </Button>
        }
      />
      {errors.agents && <p className="text-[12.5px] text-danger">{errors.agents}</p>}
      {agents.map((a, i) => {
        const prefix = `agents.${i}`;
        const rowErrors = Object.keys(errors).some((k) => k.startsWith(`${prefix}.`));
        return (
          <Disclosure
            key={i}
            defaultOpen={rowErrors || !a.prompt}
            summary={
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-semibold" style={{ fontFamily: MONO }}>
                  {a.name || 'new subagent'}
                </span>
                {a.description && <span className="min-w-0 truncate text-[12.5px] text-ink-soft">{a.description}</span>}
              </span>
            }
          >
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Name"
                  value={a.name}
                  maxLength={PERSONA_LIMITS.name}
                  onChange={(e) => set(i, { ...a, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                  error={errors[`${prefix}.name`]}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck={false}
                  className="[&_input]:font-mono"
                />
                <TextField
                  label="When to use"
                  value={a.description}
                  maxLength={PERSONA_LIMITS.description}
                  onChange={(e) => set(i, { ...a, description: e.target.value })}
                  error={errors[`${prefix}.description`]}
                  disabled={disabled}
                  autoComplete="off"
                />
              </div>
              <CodeArea label="Prompt" value={a.prompt} onChange={(prompt) => set(i, { ...a, prompt })} error={errors[`${prefix}.prompt`]} disabled={disabled} rows={5} counter="none" />
              <div className="flex flex-col gap-2">
                <ChipGroup
                  multiple
                  label={
                    <span className="inline-flex items-center gap-1">
                      Tools
                      <InfoTip label="About tools">Empty means every tool. Pick built-in tools, and list others (Bash(npm test:*), mcp__… names) separated by commas.</InfoTip>
                    </span>
                  }
                  value={a.tools.filter((t) => BUILT_IN.has(t))}
                  onChange={(picked) => set(i, { ...a, tools: [...BUILT_IN_TOOLS.filter((t) => picked.includes(t)), ...a.tools.filter((t) => !BUILT_IN.has(t))] })}
                  options={BUILT_IN_TOOLS.map((t) => ({ value: t, label: t }))}
                />
                <TextField
                  label="Other tools"
                  optional
                  value={otherTools(a.tools)}
                  onChange={(e) => set(i, { ...a, tools: [...a.tools.filter((t) => BUILT_IN.has(t)), ...splitTools(e.target.value)] })}
                  error={errors[`${prefix}.tools`]}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck={false}
                  className="[&_input]:font-mono"
                />
              </div>
              <TextField
                label="Never allowed"
                optional
                value={a.disallowedTools.join(', ')}
                onChange={(e) => set(i, { ...a, disallowedTools: splitTools(e.target.value) })}
                error={errors[`${prefix}.disallowedTools`]}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                className="[&_input]:font-mono"
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <ModelPicker label="Model" value={a.model} onChange={(model) => set(i, { ...a, model })} error={errors[`${prefix}.model`]} disabled={disabled} emptyLabel="Default" allowInherit />
                <TextField
                  label="Turn limit"
                  optional
                  inputMode="numeric"
                  value={a.maxTurns === null ? '' : String(a.maxTurns)}
                  onChange={(e) => set(i, { ...a, maxTurns: e.target.value.trim() === '' ? null : Number(e.target.value.replace(/\D/g, '')) || null })}
                  error={errors[`${prefix}.maxTurns`]}
                  disabled={disabled}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-semibold text-ink-soft">Effort</span>
                <Segmented<PersonaEffort | ''>
                  label={`${a.name || 'Subagent'} effort`}
                  value={a.effort ?? ''}
                  onChange={(e) => set(i, { ...a, effort: e || null })}
                  options={EFFORT_OPTIONS}
                />
                {errors[`${prefix}.effort`] && <p className="text-[12.5px] text-danger">{errors[`${prefix}.effort`]}</p>}
              </div>
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => onChange({ ...value, agents: agents.filter((_, j) => j !== i) })} disabled={disabled}>
                  Remove
                </Button>
              </div>
            </div>
          </Disclosure>
        );
      })}
    </div>
  );
}
