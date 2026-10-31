import type { ReporterDeploymentState, ReporterWorkPhase } from '@portal/contracts';
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { DEPLOY_MARK, PHASE_LABEL, PHASE_TONE, deploymentText } from '@/features/reporter/shared';
import type { ReporterClient } from './api';
import { Icon, type IconName } from './icons';

/* The panel's own small kit: 44 px targets, token colours (light and dark follow the system), no app shell. */

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: IconName; busy?: boolean };

export function Btn({ tone = 'secondary', icon, busy, className = '', children, disabled, ...rest }: BtnProps) {
  const look = {
    primary: 'bg-primary text-primary-ink',
    secondary: 'bg-surface-2 text-ink',
    ghost: 'bg-transparent text-ink',
    danger: 'bg-danger text-white',
  }[tone];
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl px-3 text-[14px] font-semibold transition-opacity focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden disabled:opacity-50 ${look} ${className}`}
      {...rest}
    >
      {icon && <Icon name={icon} className="size-[18px]" />}
      {busy ? <span aria-live="polite">…</span> : children}
    </button>
  );
}

export function IconBtn({ icon, label, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden disabled:opacity-40 ${className}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

/** A toggle chip (filters, type, priority). */
export function Chip({ on, onClick, children, count }: { on: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center gap-1 rounded-full border px-3 text-[13px] font-medium focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden ${on ? 'border-primary bg-primary text-primary-ink' : 'border-line-strong text-ink'}`}
    >
      {children}
      {count !== undefined && <span className={`tabular-nums ${on ? 'opacity-80' : 'text-muted'}`}>{count}</span>}
    </button>
  );
}

/** A segmented switch (scope, Ticket | Session). */
export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; disabled?: boolean; hint?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-xl bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={`min-h-11 flex-1 rounded-[10px] px-2 text-[13px] font-semibold focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden disabled:opacity-40 ${value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-muted'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error' | 'ok'; children: ReactNode }) {
  const look = { info: 'bg-surface-2 text-ink-soft', error: 'bg-danger-soft text-danger', ok: 'bg-accent-soft text-accent' }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-xl px-3 py-2 text-[13.5px] break-words ${look}`}>
      {children}
    </div>
  );
}

export function PhaseChip({ phase, pending }: { phase: ReporterWorkPhase; pending?: boolean }) {
  if (pending) return <span className="rounded-full border border-dashed border-line-strong px-2 py-0.5 text-[12px] font-semibold text-muted">Pending</span>;
  return <span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold whitespace-nowrap ${PHASE_TONE[phase]}`}>{PHASE_LABEL[phase]}</span>;
}

/** "stg ✓ · uat – · prod ?", each environment with its reason as a tooltip and for screen readers. */
export function EnvStrip({ deployments, current }: { deployments: ReporterDeploymentState[]; current?: string | null }) {
  if (!deployments.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[12px] tabular-nums">
      {deployments.map((d, i) => (
        <span key={d.environment} title={deploymentText(d)} className={d.environment === current ? 'font-semibold' : ''}>
          {i > 0 && <span aria-hidden="true" className="mr-1.5 text-muted">·</span>}
          <span className="sr-only">{deploymentText(d)}</span>
          <span aria-hidden="true" className={d.status === 'deployed' ? 'text-accent' : d.status === 'not-deployed' ? 'text-danger' : 'text-muted'}>
            {d.environment} {DEPLOY_MARK[d.status]}
          </span>
        </span>
      ))}
    </span>
  );
}

/* Images the API serves need the bearer token: fetched once, kept as object URLs (a small cache, oldest revoked first). */
const cache = new Map<string, Promise<string>>();
const MAX = 80;

export function AuthImg({ client, src, alt, className }: { client: ReporterClient; src: string | null; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!src) return;
    let live = true;
    let p = cache.get(src);
    if (!p) {
      p = client.blobUrl(src);
      cache.set(src, p);
      p.catch(() => cache.delete(src));
      if (cache.size > MAX) {
        const [oldest, op] = cache.entries().next().value as [string, Promise<string>];
        cache.delete(oldest);
        void op.then((u) => URL.revokeObjectURL(u), () => undefined);
      }
    }
    p.then(
      (u) => live && setUrl(u),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, src]);
  if (!src || failed) return <div className={`bg-surface-2 ${className ?? ''}`} aria-label={`${alt} unavailable`} role="img" />;
  return url ? <img src={url} alt={alt} className={`object-cover ${className ?? ''}`} /> : <div className={`skeleton bg-surface-2 ${className ?? ''}`} aria-busy="true" />;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted">
      {label}
      {children}
    </label>
  );
}

export const inputClass =
  'min-h-11 w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-[15px] font-normal text-ink placeholder:text-muted focus:border-accent focus:outline-hidden';
