import { cn, Dialog } from '@isnanme/ui';
import type { Org } from '@portal/contracts';
import { Check, ChevronsUpDown, Plus, Settings2, UserRound } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { LogoMark } from '@/components/LogoMark';
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

/**
 * The context switcher (docs/prd/organizations.md §7). `sidebar`: the top-left row of the desktop side bar, in place of the logo: the mark and
 * the current context (Personal or the org) with a chevron, opening a list below it. `icon`: the phone bar's icon-only button, opening the
 * same list in a sheet. The list: Personal, each org (its role in an ⓘ), then New organization (when allowed) and Org settings (in an org).
 */
export function ContextSwitcher({ variant }: { variant: 'sidebar' | 'icon' }) {
  const { orgs, abilities, context, currentOrg, setContext } = useOrgs();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const navigate = useNavigate();
  const label = currentOrg?.name ?? 'Personal';

  // The desktop panel closes on a tap outside or Escape (focus back to the button), like the account menu.
  useEffect(() => {
    if (!open || variant !== 'sidebar') return;
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
  }, [open, variant]);
  useEffect(() => {
    if (open && variant === 'sidebar') panel.current?.focus({ preventScroll: true });
  }, [open, variant]);

  const list = (
    <ContextList
      orgs={orgs}
      current={context.kind === 'org' ? context.id : null}
      mayCreate={canCreateOrg(abilities)}
      onPick={(id) => {
        setContext(id ? { kind: 'org', id } : PERSONAL);
        setOpen(false);
      }}
      onNew={() => {
        setOpen(false);
        setCreating(true);
      }}
      onSettings={() => setOpen(false)}
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

  if (variant === 'icon')
    return (
      <>
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Context: ${label}`}
          title={label}
          data-context-switcher="icon"
          onClick={() => setOpen(true)}
          // Where the logo was (it takes no more room): 44 px to tap, the mark aligned with the page's gutter.
          className="press -ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-xl hover:bg-surface-2"
        >
          <span className="relative">
            <LogoMark className="size-7" />
            {currentOrg && <OrgMark org={currentOrg} className="absolute -right-1.5 -bottom-1.5 size-[18px] bg-surface text-[9px] ring-2 ring-bg" />}
          </span>
        </button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Context" size="sm">
          {list}
        </Dialog>
        {newDialog}
      </>
    );

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
        className="press flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl p-1.5 text-left hover:bg-surface-2 lg:justify-start lg:px-2"
      >
        <span className="relative shrink-0">
          <LogoMark className="size-8" />
          {currentOrg && <OrgMark org={currentOrg} className="absolute -right-1.5 -bottom-1.5 size-5 bg-surface text-[10px] ring-2 ring-bg" />}
        </span>
        <span className="hidden min-w-0 flex-1 truncate text-[15px] font-extrabold tracking-tight lg:block">{label}</span>
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
            initial={{ opacity: 0, scale: 0.97, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
            transition={{ duration: 0.14 }}
            className="absolute top-full left-0 z-50 mt-1 max-h-[70dvh] w-64 origin-top-left overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface p-1.5 shadow-lift outline-hidden"
          >
            {list}
          </motion.div>
        )}
      </AnimatePresence>
      {newDialog}
    </div>
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
