import { Button, Switch, TextField } from '@isnanme/ui';
import { PERSONA_LIMITS, type PersonaContent, type PersonaStyle } from '@portal/contracts';
import { Plus, Star, Trash2 } from 'lucide-react';
import { CodeArea } from './CodeArea';
import { InfoTip } from '@/components/InfoTip';
import { LabelRow, Disclosure, MONO } from './parts';

const NEW_STYLE: PersonaStyle = { name: '', description: '', keepCodingInstructions: true, body: '' };

/** The first free "style-2"-like name, so a new row never starts as a duplicate. */
function freeName(base: string, taken: string[]): string {
  const lower = taken.map((t) => t.toLowerCase());
  if (!lower.includes(base)) return base;
  for (let n = 2; ; n++) if (!lower.includes(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Output styles (Persona PRD FR3, P2): tone and format, delivered as managed style files. One of them can
 * be the default for new sessions; users can still pick another. Up to five.
 */
export function StylesEditor({ value, onChange, errors, disabled }: { value: PersonaContent; onChange: (next: PersonaContent) => void; errors: Record<string, string>; disabled: boolean }) {
  const styles = value.styles;
  const set = (i: number, next: PersonaStyle) => {
    const old = styles[i];
    onChange({
      ...value,
      styles: styles.map((s, j) => (j === i ? next : s)),
      // Renaming the default style keeps it the default.
      defaultStyle: old && value.defaultStyle === old.name ? next.name : value.defaultStyle,
    });
  };
  const remove = (i: number) => {
    const old = styles[i];
    onChange({ ...value, styles: styles.filter((_, j) => j !== i), defaultStyle: old && value.defaultStyle === old.name ? null : value.defaultStyle });
  };
  return (
    <div className="flex flex-col gap-2">
      <LabelRow
        label="Styles"
        tip="Output styles change tone and format, and users can still pick another. The starred style is where new agents start; with no star they keep choosing their own."
        right={
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="size-4" />}
            aria-label="Add a style"
            onClick={() => onChange({ ...value, styles: [...styles, { ...NEW_STYLE, name: freeName('style', styles.map((s) => s.name)) }] })}
            disabled={disabled || styles.length >= PERSONA_LIMITS.styles}
          >
            Add
          </Button>
        }
      />
      {errors.styles && <p className="text-[12.5px] text-danger">{errors.styles}</p>}
      {errors.defaultStyle && <p className="text-[12.5px] text-danger">{errors.defaultStyle}</p>}
      {styles.map((s, i) => {
        const prefix = `styles.${i}`;
        const rowErrors = Object.keys(errors).some((k) => k.startsWith(`${prefix}.`));
        const isDefault = value.defaultStyle === s.name && !!s.name;
        return (
          <Disclosure
            key={i}
            defaultOpen={rowErrors || !s.body}
            summary={
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-semibold" style={{ fontFamily: MONO }}>
                  {s.name || 'new style'}
                </span>
                {s.description && <span className="min-w-0 truncate text-[12.5px] text-ink-soft">{s.description}</span>}
              </span>
            }
            trailing={
              <button
                type="button"
                aria-pressed={isDefault}
                aria-label={isDefault ? `${s.name} is the default style` : `Make ${s.name || 'this style'} the default`}
                title={isDefault ? 'The default style' : 'Make it the default'}
                disabled={disabled || !s.name}
                onClick={() => onChange({ ...value, defaultStyle: isDefault ? null : s.name })}
                className="press flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40"
              >
                <Star className={isDefault ? 'size-4 fill-amber-400 text-amber-500' : 'size-4'} />
              </button>
            }
          >
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Name"
                  value={s.name}
                  maxLength={PERSONA_LIMITS.name}
                  onChange={(e) => set(i, { ...s, name: e.target.value.replace(/[^A-Za-z0-9-]/g, '') })}
                  error={errors[`${prefix}.name`]}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck={false}
                  className="[&_input]:font-mono"
                />
                <TextField label="Description" value={s.description} maxLength={PERSONA_LIMITS.description} onChange={(e) => set(i, { ...s, description: e.target.value })} error={errors[`${prefix}.description`]} disabled={disabled} autoComplete="off" />
              </div>
              <CodeArea label="Style" value={s.body} onChange={(body) => set(i, { ...s, body })} error={errors[`${prefix}.body`]} disabled={disabled} rows={5} counter="none" />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[13px] font-semibold text-ink-soft">
                  <Switch checked={s.keepCodingInstructions} onChange={(keepCodingInstructions) => set(i, { ...s, keepCodingInstructions })} label="Keep coding instructions" disabled={disabled} />
                  Keep coding instructions
                  <InfoTip label="About keeping coding instructions">Keeps Claude Code’s own coding instructions in the system prompt next to this style. Turn it off for a style that isn’t about code.</InfoTip>
                </span>
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => remove(i)} disabled={disabled}>
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
