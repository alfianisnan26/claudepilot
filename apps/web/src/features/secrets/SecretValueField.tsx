import { Badge, Button, cn, TextArea } from '@isnanme/ui';
import { SECRET_CREDENTIAL_LABEL, SECRET_LIMITS, type SecretValueInfo } from '@portal/contracts';
import { FileUp, Pilcrow, X } from 'lucide-react';
import { useRef, useState, type CSSProperties } from 'react';
import { SecretField } from '@/components/SecretField';

const masked = { WebkitTextSecurity: 'disc' } as CSSProperties;
const size = (n: number) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`);

/** "v3 · ghp_…a1b2 · 3f9a1c2e · 40 bytes": what identifies a stored value without showing it. */
export function valueSummary(info: SecretValueInfo): string {
  return [`v${info.version}`, info.hint, info.fingerprint, size(info.length), info.type ? SECRET_CREDENTIAL_LABEL[info.type] : null].filter(Boolean).join(' · ');
}

/**
 * The write-only secret input (A7): never prefilled and never shown again. A stored value shows its version,
 * hint and fingerprint, with "Replace value"; a new one is typed (one line), pasted as text (key files), or
 * read from a file. `value` is the new value being entered, '' for none (the stored one stays).
 */
export function SecretValueField({
  label,
  info,
  value,
  onChange,
  error,
  disabled,
}: {
  label: string;
  info: SecretValueInfo | null;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  const [replacing, setReplacing] = useState(false);
  const [multiline, setMultiline] = useState(false);
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const stored = !!info?.stored;
  const editing = !stored || replacing || value !== '';

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFileError(null);
    if (f.size > SECRET_LIMITS.secretBytes) return setFileError(`That file is ${size(f.size)}; the most is ${size(SECRET_LIMITS.secretBytes)}.`);
    const text = await f.text();
    if (text.includes('\0')) return setFileError('Binary files aren’t supported: use text, such as base64.');
    setFile({ name: f.name, size: f.size });
    onChange(text);
  };
  const clear = () => {
    setFile(null);
    setFileError(null);
    onChange('');
  };

  return (
    <div className="flex flex-col gap-2">
      {stored && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <span className="text-sm font-semibold text-ink-soft">{label}</span>
          <span className="font-mono text-[12px] text-muted">{valueSummary(info!)}</span>
          {!editing && (
            <Button variant="ghost" size="sm" onClick={() => setReplacing(true)} disabled={disabled} className="ml-auto">
              Replace value
            </Button>
          )}
        </div>
      )}
      {!stored && info && <Badge tone="warning">Cleared: enter it again</Badge>}
      {editing &&
        (file ? (
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-[13px]">
            <FileUp className="size-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate">
              {file.name} <span className="text-muted">· {size(file.size)}</span>
            </span>
            <Button variant="ghost" size="sm" icon={<X className="size-4" />} onClick={clear} disabled={disabled}>
              Clear
            </Button>
          </div>
        ) : multiline ? (
          <TextArea
            label={stored ? 'New value' : label}
            rows={5}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-[12.5px]"
            style={masked}
            placeholder="Paste the key or file content"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            error={error}
            disabled={disabled}
          />
        ) : (
          <SecretField
            label={stored ? 'New value' : label}
            placeholder={stored ? 'The stored value stays until you save a new one' : 'Paste the value'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            error={error}
            disabled={disabled}
          />
        ))}
      {editing && (
        <div className="flex flex-wrap items-center gap-1">
          {!file && (
            <Button variant="ghost" size="sm" icon={<Pilcrow className="size-4" />} onClick={() => (setMultiline((m) => !m), onChange(''))} disabled={disabled}>
              {multiline ? 'One line' : 'Several lines'}
            </Button>
          )}
          <Button variant="ghost" size="sm" icon={<FileUp className="size-4" />} onClick={() => picker.current?.click()} disabled={disabled}>
            Upload file
          </Button>
          {stored && (
            <Button variant="ghost" size="sm" onClick={() => (clear(), setReplacing(false), setMultiline(false))} disabled={disabled}>
              Keep current
            </Button>
          )}
          <input ref={picker} type="file" className="hidden" onChange={(e) => (void pick(e.target.files?.[0]), (e.target.value = ''))} />
        </div>
      )}
      {(fileError || (file && error)) && <p className={cn('text-[13px] font-medium text-danger')}>{fileError ?? error}</p>}
    </div>
  );
}
