import { cn, Dialog } from '@isnanme/ui';
import type { Org } from '@portal/contracts';
import { Check, ChevronsUpDown, Plus, Settings2, UserRound } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { PERSONAL } from '@/lib/orgContext';
import { NewOrgDialog } from './NewOrgDialog';
import { useOrgs } from './OrgsProvider';
import { canCreateOrg, ROLE_ABOUT, ROLE_LABEL } from './rules';

/** An org's mark: its first letter on a tile (no logos yet). */
export function OrgMark({ org, className }: { org: Pick<Org, 'name'>; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('inline-flex shrink-0 items-center justify-center rounded-lg bg-accent/15 font-bold text-ink uppercase', className)}>
      {org.name.trim().charAt(0) || '?'}
    </span>
  );
}

const settingsPath = (id: string) => `/admin/orgs/${id}`;

/** The list of a switcher with what it needs: picking a context, New organization (and its dialog), Org settings. */
function useContextList(close: () => void) {
  const { orgs, abilities, context, setContext } = useOrgs();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const list = (
    <ContextList
      orgs={orgs}
      current={context.kind === 'org' ? context.id : null}
      mayCreate={canCreateOrg(abilities)}
      onPick={(id) => {
        setContext(id ? { kind: 'org', id } : PERSONAL);
        close();
      }}
      onNew={() => {
        close();
        setCreating(true);
      }}
      onSettings={close}
    />
  );
  const newDialog = (
    <NewOrgDialog
      open={creating}
      onClose={() => setCreating(false)}
      onCreated={(org) => {
        setCreating(false);
        setContext({ kind: 'org', id: org.id });
        navigate(settingsPath(org.id));
      }}
    />
  );
  return { list, newDialog };
}

/**
 * The context switcher (docs/prd/organizations.md §7; owner, 2026-11-01): a compact row at the foot of the desktop side bar, right above the
 * account, with the current context's mark and name and a chevron (the mark alone on the slim rail), opening the list upwards. The list:
 * Personal, each org (its role in an ⓘ), then Org settings (in an org) and New organization (when allowed). On a phone the same list is a
 * sheet opened from the account menu (`ContextSheet`).
 */
export function ContextSwitcher() {
  const { currentOrg } = useOrgs();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const label = currentOrg?.name ?? 'Personal';
  const { list, newDialog } = useContextList(() => setOpen(false));

  // The panel closes on a tap outside or Escape (focus back to the button), like the account menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      // An ⓘ's note is rendered into <body>: a tap on it is not "outside".
      if (!ref.current?.contains(t) && !t?.closest?.('[role="note"]')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
  }, [open]);

  return (
    <div ref={ref} className="relative w-full">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Context: ${label}`}
        title={label}
        data-context-switcher="sidebar"
        onClick={() => setOpen((v) => !v)}
        className="press flex min-h-11 w-full items-center justify-center gap-3 rounded-2xl p-1 text-left outline-hidden hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent lg:justify-start lg:px-2"
      >
        {currentOrg ? (
          <OrgMark org={currentOrg} className="size-9 text-[14px]" />
        ) : (
          <span aria-hidden="true" className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-soft">
            <UserRound className="size-[18px]" />
          </span>
        )}
        <span className="hidden min-w-0 flex-1 truncate text-sm font-semibold lg:block">{label}</span>
        <ChevronsUpDown aria-hidden="true" className="hidden size-4 shrink-0 text-muted lg:block" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panel}
            id={panelId}
            role="dialog"
            aria-label="Context"
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.97, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
            transition={{ duration: 0.14 }}
            className="absolute bottom-full left-0 z-50 mb-2 max-h-[70dvh] w-64 origin-bottom-left overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface p-1.5 shadow-lift outline-hidden"
          >
            {list}
          </motion.div>
        )}
      </AnimatePresence>
      {newDialog}
    </div>
  );
}

/** The phone's switcher: the same list in a sheet, opened from the account menu's Context row. */
export function ContextSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { list, newDialog } = useContextList(onClose);
  return (
    <>
      <Dialog open={open} onClose={onClose} title="Context" size="sm">
        {list}
      </Dialog>
      {newDialog}
    </>
  );
}

function ContextList({
  orgs,
  current,
  mayCreate,
  onPick,
  onNew,
  onSettings,
}: {
  orgs: Org[] | null;
  current: string | null;
  mayCreate: boolean;
  onPick: (orgId: string | null) => void;
  onNew: () => void;
  onSettings: () => void;
}) {
  const row = 'press flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl px-2.5 text-left text-[15px] font-semibold hover:bg-surface-2';
  return (
    <ul className="flex flex-col gap-0.5 pb-1" data-context-list="">
      <li>
        <button type="button" aria-current={current === null ? 'true' : undefined} onClick={() => onPick(null)} className={row}>
          <UserRound aria-hidden="true" className="size-5 shrink-0 text-ink-soft" />
          <span className="min-w-0 flex-1 truncate">Personal</span>
          {current === null && <Check aria-label="Current" className="size-4 shrink-0" />}
        </button>
      </li>
      {orgs === null ? (
        <li aria-busy="true" className="skeleton mx-2.5 my-1 h-8 rounded-lg" />
      ) : (
        orgs.map((o) => (
          <li key={o.id} className="flex items-center gap-1">
            <button type="button" aria-current={current === o.id ? 'true' : undefined} onClick={() => onPick(o.id)} className={row}>
              <OrgMark org={o} className="size-6 text-[12px]" />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere] line-clamp-2">{o.name}</span>
              {current === o.id && <Check aria-label="Current" className="size-4 shrink-0" />}
            </button>
            <InfoTip label={`${o.name}: your role`}>
              {ROLE_LABEL[o.myRole]}. {ROLE_ABOUT[o.myRole]}
            </InfoTip>
          </li>
        ))
      )}
      {(mayCreate || current) && <li aria-hidden="true" className="mx-2.5 my-1 h-px bg-line" />}
      {current && (
        <li>
          <Link to={settingsPath(current)} onClick={onSettings} className={row}>
            <Settings2 aria-hidden="true" className="size-5 shrink-0 text-ink-soft" />
            <span className="min-w-0 flex-1 truncate">Org settings</span>
          </Link>
        </li>
      )}
      {mayCreate && (
        <li>
          <button type="button" onClick={onNew} className={row}>
            <Plus aria-hidden="true" className="size-5 shrink-0 text-ink-soft" />
            <span className="min-w-0 flex-1 truncate">New organization</span>
          </button>
        </li>
      )}
    </ul>
  );
}
