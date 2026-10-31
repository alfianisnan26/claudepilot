import type { ReporterNote, ReporterNoteHit, ReporterSession } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { usePanel } from './context';
import { Icon } from './icons';
import { Md } from './markdown';
import { DEFAULT_HOTKEYS, hotkeyOf, type Hotkeys } from './model';
import { Btn, IconBtn, Notice, inputClass } from './ui';

function OpenLink({ href, label = 'Open in pilot' }: { href: string; label?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title={label} className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
      <Icon name="externalLink" className="size-[18px]" />
    </a>
  );
}

/** The bucket's sessions: the ones working its tickets and the ones in its default workspace, with the direct-report targets first. */
export function SessionsTab() {
  const { client, tick, targets, select, setTab } = usePanel();
  const [list, setList] = useState<ReporterSession[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.sessions().then(
      (s) => live && setList(s),
      (e: Error) => live && setFailed(e.message),
    );
    return () => {
      live = false;
    };
  }, [client, tick]);
  return (
    <div className="flex flex-col gap-3 p-3">
      {targets.length > 0 && (
        <section>
          <h2 className="mb-1 px-1 text-[12.5px] font-semibold text-muted">Direct report</h2>
          <ul className="flex flex-col gap-1">
            {targets.map((t) => (
              <li key={t.sessionId} className="flex min-h-11 items-center gap-2 rounded-xl bg-surface-2 px-3 py-2">
                <span className={`size-2 shrink-0 rounded-full ${!t.available ? 'bg-line-strong' : t.status === 'working' ? 'bg-flame' : 'bg-accent'}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">{t.label}</span>
                  <span className="block truncate text-[12px] text-muted">{t.available ? t.status : (t.reason ?? 'unavailable')}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {failed && <Notice tone="error">{failed}</Notice>}
      {!list && !failed && <div className="skeleton h-24 rounded-2xl" aria-busy="true" />}
      {list && list.length === 0 && <p className="py-6 text-center text-[13.5px] text-muted">No sessions.</p>}
      {list && list.length > 0 && (
        <ul className="flex flex-col gap-1">
          {list.map((s) => (
            <li key={s.id} className="flex items-center gap-1 rounded-xl hover:bg-surface-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2">
                <Icon name="bot" className="size-4 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">{s.title}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {s.status}
                    {s.ticketKey && (
                      <>
                        {' · '}
                        <button
                          type="button"
                          className="font-semibold text-accent underline"
                          onClick={() => {
                            select(s.ticketKey);
                            setTab('tickets');
                          }}
                        >
                          {s.ticketKey}
                        </button>
                      </>
                    )}
                  </span>
                </span>
              </div>
              <OpenLink href={s.url} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Search the bucket's vault and read a note. */
export function KnowledgeTab() {
  const { client } = usePanel();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ReporterNoteHit[] | null>(null);
  const [note, setNote] = useState<ReporterNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      client.knowledge(q.trim()).then(
        (h) => live && (setHits(h), setError(null)),
        (e: Error) => live && setError(e.message),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, client]);

  const read = async (path: string) => {
    try {
      setNote(await client.note(path));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (note)
    return (
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-1">
          <IconBtn icon="chevronLeft" label="Back" onClick={() => setNote(null)} />
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-bold">{note.title}</h2>
          {note.url && <OpenLink href={note.url} />}
        </div>
        <Md text={note.body} className="text-[14px] leading-relaxed" />
      </div>
    );

  return (
    <div className="flex flex-col gap-3 p-3">
      <label className="relative">
        <span className="sr-only">Search notes</span>
        <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" className={`${inputClass} pl-9`} />
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      {hits && hits.length === 0 && <p className="py-6 text-center text-[13.5px] text-muted">No notes found.</p>}
      <ul className="flex flex-col gap-1">
        {hits?.map((h) => (
          <li key={h.path}>
            <button type="button" onClick={() => void read(h.path)} className="flex w-full flex-col gap-0.5 rounded-xl p-2 text-left hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
              <span className="text-[14px] font-semibold break-words">{h.title}</span>
              <span className="line-clamp-2 text-[12.5px] break-words text-muted">{h.snippet}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const HOTKEY_LABEL: Record<keyof Hotkeys, string> = { report: 'Report', crop: 'Crop', callouts: 'Callouts', panel: 'Panel' };

export function SettingsTab() {
  const { calloutsVisible, setCalloutsVisible, hotkeys, setHotkeys, coarse, signOut, actorLabel, status, sdkVersion } = usePanel();
  const [recording, setRecording] = useState<keyof Hotkeys | null>(null);
  return (
    <div className="flex flex-col gap-4 p-3">
      <label className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-surface-2 px-3">
        <span className="text-[14px] font-semibold">Callouts</span>
        <input type="checkbox" role="switch" checked={calloutsVisible} onChange={(e) => setCalloutsVisible(e.target.checked)} className="size-6 accent-[var(--color-accent)]" />
      </label>
      {!coarse && (
        <section className="flex flex-col gap-1">
          <h2 className="px-1 text-[12.5px] font-semibold text-muted">Hotkeys</h2>
          {(Object.keys(HOTKEY_LABEL) as (keyof Hotkeys)[]).map((k) => (
            <div key={k} className="flex min-h-11 items-center justify-between gap-2 px-1">
              <span className="text-[14px]">{HOTKEY_LABEL[k]}</span>
              <button
                type="button"
                onClick={() => setRecording(k)}
                onBlur={() => setRecording(null)}
                onKeyDown={(e) => {
                  if (recording !== k) return;
                  if (e.key === 'Escape') {
                    // Esc cancels the recording only; the panel's Esc-to-close skips a key a control used.
                    e.preventDefault();
                    return setRecording(null);
                  }
                  const combo = hotkeyOf(e);
                  if (!combo) return;
                  e.preventDefault();
                  setHotkeys({ ...hotkeys, [k]: combo });
                  setRecording(null);
                }}
                aria-label={`${HOTKEY_LABEL[k]} hotkey: ${hotkeys[k]}${recording === k ? ', press the new keys' : ''}`}
                className={`min-h-11 min-w-32 rounded-xl border px-3 text-[13px] font-semibold tabular-nums focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden ${recording === k ? 'border-accent text-accent' : 'border-line-strong'}`}
              >
                {recording === k ? 'Press keys…' : hotkeys[k]}
              </button>
            </div>
          ))}
          <Btn tone="ghost" onClick={() => setHotkeys({ ...DEFAULT_HOTKEYS })}>
            Reset hotkeys
          </Btn>
        </section>
      )}
      <section className="flex flex-col gap-1 px-1 text-[12.5px] text-muted">
        {actorLabel && <p>Signed in as {actorLabel}</p>}
        {status.site && (
          <p className="break-all">
            {status.site.repo} · {status.site.environment}
          </p>
        )}
        <p>
          SDK {sdkVersion || 'unknown'} · served {status.sdkVersion}
        </p>
      </section>
      <Btn icon="logOut" onClick={signOut}>
        Sign out
      </Btn>
    </div>
  );
}
