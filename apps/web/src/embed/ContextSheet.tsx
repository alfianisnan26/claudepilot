import { useEffect, useRef, useState } from 'react';
import { usePanel } from './context';
import { REDACTION_RULES, carriesRows, contextGroups, contextText, type CtxRow } from './formModel';
import { Icon } from './icons';
import { IconBtn } from './ui';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Context (owner, 2026-10-31): what the panel knows of this site, page, build, client, network and session, each row copyable, Copy all on
 * top, and "What a ticket carries": what the next report from this page will include, with the SDK's live counts and the redaction rules.
 * Every value has a source (the site record, the SDK's context message, /me); "unknown" when there is none.
 */
export function ContextSheet({ section, onClose }: { section: 'context' | 'carries'; onClose: () => void }) {
  const { status, page, build, hostContext, me, actorLabel, sdkVersion, notify } = usePanel();
  const carriesRef = useRef<HTMLElement>(null);
  const groups = contextGroups({
    status,
    page: hostContext?.page ?? page,
    device: hostContext?.device ?? null,
    build: hostContext?.build ?? build,
    me,
    actorLabel,
    sdkVersion,
    portalRelease: null,
  });
  const carries = carriesRows(hostContext?.counts ?? null);
  useEffect(() => {
    if (section === 'carries') carriesRef.current?.scrollIntoView({ block: 'start' });
  }, [section]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const all = `${contextText(groups)}\nWhat a ticket carries\n${carries.map((r) => `  ${r.label}: ${r.value}`).join('\n')}`;
  return (
    <div role="dialog" aria-modal="true" aria-label="Context" className="fixed inset-0 z-50 flex flex-col bg-bg">
      <header className="flex min-h-11 shrink-0 items-center gap-1 border-b border-line pt-[env(safe-area-inset-top)] pr-12 pl-1">
        <IconBtn icon="chevronLeft" label="Back" onClick={onClose} />
        <h2 className="flex-1 text-[15px] font-bold">Context</h2>
        <button
          type="button"
          onClick={() => void copy(all).then((ok) => notify(ok ? 'Copied' : 'Copy is blocked here.', ok ? 'ok' : 'error'))}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
        >
          <Icon name="copy" className="size-4" />
          Copy all
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {groups.map((g) => (
          <section key={g.title} className="mt-3">
            <h3 className="mb-1 px-1 text-[12.5px] font-semibold text-muted">{g.title}</h3>
            <dl className="divide-y divide-line rounded-2xl border border-line">
              {g.rows.map((r) => (
                <CtxLine key={r.label} r={r} />
              ))}
            </dl>
          </section>
        ))}
        <section ref={carriesRef} className="mt-4 scroll-mt-2">
          <h3 className="mb-1 px-1 text-[12.5px] font-semibold text-muted">What a ticket carries</h3>
          <p className="mb-1.5 px-1 text-[12.5px] text-muted">Everything above, plus:</p>
          <dl className="divide-y divide-line rounded-2xl border border-line">
            {carries.map((r) => (
              <CtxLine key={r.label} r={r} />
            ))}
          </dl>
          <ul className="mt-2 flex flex-col gap-1 px-1 text-[12.5px] text-ink-soft">
            {REDACTION_RULES.map((rule) => (
              <li key={rule} className="flex gap-1.5">
                <Icon name="check" className="mt-0.5 size-3.5 shrink-0 text-accent" />
                <span className="min-w-0 break-words">{rule}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function CtxLine({ r }: { r: CtxRow }) {
  const [done, setDone] = useState(false);
  const unknown = r.value === 'unknown' || r.value.startsWith('unknown ');
  return (
    <div className={`flex min-h-11 items-center gap-2 pl-3 ${r.warn ? 'bg-danger-soft' : ''}`}>
      <dt className="w-24 shrink-0 text-[12.5px] text-muted">{r.label}</dt>
      <dd className={`min-w-0 flex-1 py-2 text-[13px] break-all ${unknown ? 'text-muted' : r.warn ? 'text-danger' : 'text-ink'}`}>{r.value}</dd>
      {!unknown && (
        <button
          type="button"
          aria-label={`Copy ${r.label}`}
          title="Copy"
          onClick={() =>
            void copy(r.copy ?? r.value).then((ok) => {
              setDone(ok);
              if (ok) setTimeout(() => setDone(false), 1200);
            })
          }
          className="inline-flex size-11 shrink-0 items-center justify-center text-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
        >
          <Icon name={done ? 'check' : 'copy'} className="size-4" />
        </button>
      )}
    </div>
  );
}
