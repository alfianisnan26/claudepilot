import { Select, TextField } from '@isnanme/ui';
import { useState } from 'react';
import { MODEL_ALIASES } from './labels';

const OTHER = '\u0000other';

/**
 * A model: Claude Code's own default, an alias that resolves on every endpoint, or a model ID typed in
 * (Persona PRD FR5). A subagent can also inherit its parent's model.
 */
export function ModelPicker({
  label,
  value,
  onChange,
  error,
  disabled,
  emptyLabel = 'Claude Code default',
  allowInherit,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  error?: string;
  disabled?: boolean;
  emptyLabel?: string;
  allowInherit?: boolean;
}) {
  const named = ['', ...(allowInherit ? ['inherit'] : []), ...MODEL_ALIASES.map((a) => a.value)];
  const [typing, setTyping] = useState(false);
  const custom = typing || !named.includes(value);
  return (
    <div className="flex flex-col gap-2">
      <Select
        label={label}
        value={custom ? OTHER : value}
        onChange={(v) => {
          if (v === OTHER) return setTyping(true), onChange(named.includes(value) ? '' : value);
          setTyping(false);
          onChange(v);
        }}
        disabled={disabled}
        error={custom ? undefined : error}
        options={[
          { value: '', label: emptyLabel },
          ...(allowInherit ? [{ value: 'inherit', label: 'Same as the session' }] : []),
          ...MODEL_ALIASES.map((a) => ({ value: a.value, label: a.label })),
          { value: OTHER, label: 'Model ID…' },
        ]}
      />
      {custom && (
        <TextField
          label="Model ID"
          placeholder="claude-sonnet-4-6"
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          error={error}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="[&_input]:font-mono"
        />
      )}
    </div>
  );
}
