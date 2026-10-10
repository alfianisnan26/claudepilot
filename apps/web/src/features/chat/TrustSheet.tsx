import { Button, Dialog, Spinner } from '@isnanme/ui';
import { CHAT_FOLDER_UNTRUSTED, type ChatFolderScan } from '@portal/contracts';
import { Puzzle, Server, ShieldCheck, TriangleAlert, Variable, Webhook, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, errorText } from '@/lib/api';
import { chatApi } from './api';
import { ChatAckError } from './useChatSocket';

/** Whether a start was refused because its folder needs trusting first: a REST error or a socket ack. */
export const isFolderUntrusted = (e: unknown): boolean =>
  (e instanceof ApiError || e instanceof ChatAckError) && e.code === CHAT_FOLDER_UNTRUSTED;

/** Cancel on the trust prompt: the refused action stays undone. Callers needn't announce it. */
export class TrustDeclined extends Error {
  constructor() {
    super('The folder isn’t trusted, so the session didn’t start.');
    this.name = 'TrustDeclined';
  }
}
export const isTrustDeclined = (e: unknown): boolean => e instanceof TrustDeclined;

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : []);

/** A scan from the portal, checked; the names it lists default to none. Null when it isn't one. */
function asScan(v: unknown): ChatFolderScan | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Partial<ChatFolderScan>;
  if (typeof s.workspaceId !== 'string' || typeof s.folder !== 'string' || typeof s.hash !== 'string') return null;
  return {
    ...s,
    workspaceId: s.workspaceId,
    folder: s.folder,
    hash: s.hash,
    empty: s.empty === true,
    mcpServers: names(s.mcpServers),
    hooks: names(s.hooks),
    plugins: names(s.plugins),
    allowRules: typeof s.allowRules === 'number' ? s.allowRules : 0,
    envNames: names(s.envNames),
    trusted: s.trusted === true,
  };
}

/** What a folder would load, fetched. */
async function loadScan(workspaceId: string, folder: string): Promise<ChatFolderScan> {
  const scan = asScan(await chatApi.scan(workspaceId, folder));
  if (!scan) throw new Error('Couldn’t check the folder.');
  return scan;
}

/** The folder's scan after a refusal: the one the error carries (a REST start or trust), else fetched. */
export async function scanAfter(e: unknown, workspaceId: string, folder: string): Promise<ChatFolderScan> {
  return (e instanceof ApiError ? asScan(e.details) : null) ?? loadScan(workspaceId, folder);
}

/** Settings files the scan couldn't read, when the portal reports them (`invalid`). True when it gives no names. */
function invalidFiles(scan: ChatFolderScan): string[] | true | null {
  const invalid = (scan as ChatFolderScan & { invalid?: unknown }).invalid;
  if (Array.isArray(invalid)) return invalid.length ? names(invalid) : null;
  return invalid ? true : null;
}

/**
 * The trust prompt's body: what Claude Code would load from the folder when the session starts, by
 * name (MCP servers, hooks by event, plugins, allow rules, environment variable names), and why that
 * matters. Shared by the sheet and the new-session dialog's trust step.
 */
export function TrustDetails({ scan, changed }: { scan: ChatFolderScan; changed?: boolean }) {
  const invalid = invalidFiles(scan);
  const listed = scan.mcpServers.length > 0 || scan.hooks.length > 0 || scan.plugins.length > 0 || scan.allowRules > 0 || scan.envNames.length > 0;
  return (
    <div className="flex flex-col gap-4">
      {changed && <Notice>The folder’s settings changed. This is what it would load now.</Notice>}
      <p className="text-[14px] text-ink-soft">
        {listed
          ? 'When the session starts, Claude Code loads this from the folder’s own settings:'
          : scan.empty
            ? 'Nothing from this folder’s Claude Code settings would load.'
            : 'The folder has its own Claude Code settings, but they name no MCP servers, hooks, plugins, allow rules or environment variables.'}
      </p>
      {listed && (
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {scan.mcpServers.length > 0 && <Group icon={Server} label="MCP servers" items={scan.mcpServers} />}
          {scan.hooks.length > 0 && <Group icon={Webhook} label="Hooks" note="Commands that run on these events." items={scan.hooks} />}
          {scan.plugins.length > 0 && <Group icon={Puzzle} label="Plugins" items={scan.plugins} />}
          {scan.allowRules > 0 && (
            <Group
              icon={ShieldCheck}
              label={scan.allowRules === 1 ? 'Allow rule' : 'Allow rules'}
              count={scan.allowRules}
              note="Tools and commands it may use without asking."
            />
          )}
          {scan.envNames.length > 0 && <Group icon={Variable} label="Environment variables" note="Values aren’t shown." items={scan.envNames} />}
        </ul>
      )}
      {invalid && (
        <Notice>
          <span className="font-semibold">Invalid settings files</span>
          {invalid === true ? '' : <span className="font-mono break-all">: {invalid.join(', ')}</span>}. They couldn’t be read, so
          anything in them isn’t listed here.
        </Notice>
      )}
      <p className="text-[13px] text-muted">These run with the agent’s access to this workspace, without asking you first. Trust only folders you know.</p>
    </div>
  );
}

function Group({ icon: Icon, label, note, count, items }: { icon: LucideIcon; label: string; note?: string; count?: number; items?: string[] }) {
  return (
    <li className="flex gap-3 px-3.5 py-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-ink-soft" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold text-ink">
          {label} <span className="font-medium text-muted tabular-nums">{count ?? items?.length}</span>
        </p>
        {note && <p className="text-[12.5px] text-muted">{note}</p>}
        {items && (
          <ul aria-label={label} className="mt-1.5 flex flex-wrap gap-1.5">
            {items.map((name, i) => (
              <li key={`${i}:${name}`} className="max-w-full rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] break-all text-ink-soft">
                {name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-xl bg-amber-500/12 px-3.5 py-2.5 text-[13px] text-amber-700 dark:text-amber-400">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">
      {children}
    </p>
  );
}

/** Where a session's folder is, so it can be scanned. */
export interface TrustTarget {
  workspaceId: string;
  folder: string;
}

export interface TrustPrompt {
  /** What the folder would load; null while it's being checked. */
  scan: ChatFolderScan | null;
  /** This scan replaced one already shown: the folder's settings changed meanwhile. */
  changed: boolean;
  /** Checking the folder failed. */
  loadError: string | null;
  /** Trusting it failed. */
  error: string | null;
  /** Trusting, then running the refused actions again. */
  busy: boolean;
}

export interface FolderTrust {
  /** The open prompt, or null. */
  prompt: TrustPrompt | null;
  /**
   * Runs an action. When the portal refuses it because the folder needs trust, asks, and settles once
   * it's trusted and the action ran again (with that run's result); rejects with `TrustDeclined` on Cancel.
   */
  guard: (run: () => Promise<void>) => Promise<void>;
  /** Trust and start: trusts the folder as scanned, then runs what was refused again. */
  confirm: (scan: ChatFolderScan) => Promise<void>;
  cancel: () => void;
  /** Checks the folder again after that failed. */
  reload: () => void;
}

interface Refused {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

/**
 * Folder trust for an open session (send, resume, controls): a refused action's ack only says
 * `FOLDER_UNTRUSTED`, so the prompt looks the session's folder up (`locate`) and scans it. Actions
 * refused while the prompt is open join it and run again, in order, once the folder is trusted.
 * `scope` is the session: another one starts clean.
 */
export function useFolderTrust(scope: string, locate: () => Promise<TrustTarget>): FolderTrust {
  const [prompt, setPrompt] = useState<TrustPrompt | null>(null);
  const refused = useRef<Refused[]>([]);
  const busy = useRef(false);
  // Bumped by every check, so a slower earlier one never overwrites it.
  const loads = useRef(0);
  const locateRef = useRef(locate);
  useLayoutEffect(() => {
    locateRef.current = locate;
  });

  const patch = useCallback((next: Partial<TrustPrompt>) => setPrompt((p) => (p ? { ...p, ...next } : p)), []);

  /** Shows the folder's scan: the one `from` carries, else fetched for `previous`'s folder (or the session's). */
  const load = useCallback(
    async (from?: unknown, previous?: ChatFolderScan) => {
      const id = ++loads.current;
      const show = (scan: ChatFolderScan) => {
        if (id === loads.current) patch({ scan, loadError: null, changed: !!previous && previous.hash !== scan.hash });
      };
      const given = from instanceof ApiError ? asScan(from.details) : null;
      if (given) return show(given);
      patch({ scan: null, loadError: null });
      try {
        const where = previous ?? (await locateRef.current());
        show(await loadScan(where.workspaceId, where.folder));
      } catch (e) {
        if (id === loads.current) patch({ loadError: errorText(e, 'Couldn’t check the folder.') });
      }
    },
    [patch],
  );

  const guard = useCallback(
    (run: () => Promise<void>) =>
      run().catch((e: unknown) => {
        if (!isFolderUntrusted(e)) throw e;
        return new Promise<void>((resolve, reject) => {
          refused.current.push({ run, resolve, reject });
          if (refused.current.length > 1) return; // the prompt is already open: this one waits with it
          setPrompt({ scan: null, changed: false, loadError: null, error: null, busy: false });
          void load(e);
        });
      }),
    [load],
  );

  const confirm = useCallback(
    async (scan: ChatFolderScan) => {
      if (busy.current) return;
      busy.current = true;
      patch({ busy: true, error: null });
      // Another session swaps the list out: what this prompt was doing then stops touching the screen.
      const list = refused.current;
      const current = () => list === refused.current;
      const pause = (next: Partial<TrustPrompt> = {}) => {
        busy.current = false;
        patch({ busy: false, ...next });
      };
      try {
        await chatApi.trust({ workspaceId: scan.workspaceId, folder: scan.folder, hash: scan.hash });
      } catch (e) {
        if (!current()) return;
        if (!isFolderUntrusted(e)) return pause({ error: errorText(e, 'Couldn’t trust the folder.') });
        pause();
        return void load(e, scan); // its files changed since: show what it would load now
      }
      // Trusted: run what was refused again, oldest first.
      while (current() && list.length) {
        const next = list[0]!;
        try {
          await next.run();
        } catch (e) {
          if (!current()) return;
          if (isFolderUntrusted(e)) {
            pause();
            return void load(e, scan); // changed again before it started
          }
          list.shift();
          next.reject(e);
          continue;
        }
        list.shift();
        next.resolve();
      }
      if (!current()) return;
      busy.current = false;
      setPrompt(null);
    },
    [load, patch],
  );

  const cancel = useCallback(() => {
    if (busy.current) return;
    const list = refused.current;
    refused.current = [];
    loads.current++;
    setPrompt(null);
    for (const r of list) r.reject(new TrustDeclined());
  }, []);

  const reload = useCallback(() => void load(), [load]);

  // Another session, or leaving: the prompt and what it held don't carry over.
  useEffect(
    () => () => {
      refused.current = [];
      loads.current++;
      busy.current = false;
      setPrompt(null);
    },
    [scope],
  );

  return { prompt, guard, confirm, cancel, reload };
}

/**
 * The kit's Dialog puts the page's scroll lock back as it found it when it opened, so a dialog still
 * closing under this one (a picker that just sent the refused change) would leave the page locked.
 * Open once no other dialog is on screen.
 */
function useWhenAlone(want: boolean): boolean {
  const [alone, setAlone] = useState(false);
  useEffect(() => {
    setAlone(false);
    if (!want) return;
    let frame = 0;
    const check = () => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) frame = requestAnimationFrame(check);
      else setAlone(true);
    };
    check();
    return () => cancelAnimationFrame(frame);
  }, [want]);
  return want && alone;
}

/**
 * "Trust this folder?" for an open session: what the folder would load, Trust and start, or Cancel.
 * A centred dialog on wide screens and a bottom sheet on phones (the kit's Dialog).
 */
export function TrustSheet({ trust }: { trust: FolderTrust }) {
  const { prompt } = trust;
  const open = useWhenAlone(prompt !== null);
  // The last prompt stays on screen while the sheet slides away.
  const [shown, setShown] = useState(prompt);
  if (prompt && prompt !== shown) setShown(prompt);
  const scan = shown?.scan ?? null;
  const busy = shown?.busy ?? false;
  return (
    <Dialog
      open={open}
      onClose={trust.cancel}
      size="sm"
      title="Trust this folder?"
      description={scan ? <span className="font-mono break-all">{scan.folder}</span> : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={trust.cancel} disabled={busy} data-autofocus>
            Cancel
          </Button>
          <Button onClick={scan ? () => trust.confirm(scan) : undefined} loading={busy} disabled={!scan}>
            Trust and start
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {scan ? (
          <TrustDetails scan={scan} changed={shown?.changed} />
        ) : shown?.loadError ? (
          <div className="flex flex-col items-start gap-3">
            <ErrorNote>{shown.loadError}</ErrorNote>
            <Button size="sm" variant="secondary" onClick={trust.reload}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="flex items-center gap-2 py-2 text-[13px] text-muted" aria-busy="true">
            <Spinner className="size-4" /> Checking what this folder loads…
          </p>
        )}
        {shown?.error && <ErrorNote>{shown.error}</ErrorNote>}
      </div>
    </Dialog>
  );
}
