import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { currentContext, subscribeContext } from '@/lib/orgContext';
import type { GlanceCompact, GlanceContext } from '../../types';
import { GlanceLine } from './states';

// The portal's own pilot numbers (Pace, Flow, Metrics: every program, the crew's quota) belong to no organization, so in an org context
// (lib/orgContext) their card and chip say so instead of showing instance-wide numbers as the org's (owner request 2026-11-01, metrics per org).

/** The app works in an org context right now. */
export const useInOrg = (): boolean => useSyncExternalStore(subscribeContext, () => currentContext().kind === 'org');

/** What a card counts in the context it is in (the InfoTip of its empty line). */
export const contextNote = (inOrg: boolean): string =>
  inOrg
    ? 'Counted in this organization only: what its workspaces and ticket buckets hold. Switch the context to see Personal or another organization.'
    : 'Counted in Personal only: what no organization owns. Switch the context to see an organization.';

/** A card's empty line, with the InfoTip that says which context it counted in (an org with nothing yet is not an error). */
export function ContextLine({ children }: { children: ReactNode }) {
  const inOrg = useInOrg();
  return (
    <GlanceLine>
      <span className="inline-flex items-center gap-1" data-context-line={inOrg ? 'org' : 'personal'}>
        {children}
        <InfoTip label="Which context">{contextNote(inOrg)}</InfoTip>
      </span>
    </GlanceLine>
  );
}

/** The card in an org context: one line, and why in an InfoTip. */
export function PersonalOnly({ label }: { label: string }) {
  return (
    <div data-personal-only="">
      <GlanceLine>
        <span className="inline-flex items-center gap-1">
          Personal only
          <InfoTip label={`Why ${label} is not shown here`}>
            {label} shows the portal’s own pilot numbers, across every program. They belong to no organization, so they show only in Personal.
          </InfoTip>
        </span>
      </GlanceLine>
    </div>
  );
}

/** `Card` in Personal; the Personal-only line in an org context (the card itself never mounts there, so it asks for nothing). */
export function personalOnlyCard(label: string, Card: ComponentType): ComponentType {
  function Scoped() {
    return useInOrg() ? <PersonalOnly label={label} /> : <Card />;
  }
  Scoped.displayName = `PersonalOnly(${label})`;
  return Scoped;
}

/** What the chip shows in an org context: nothing measured, and why. */
export const personalOnlyCompact = (label: string): GlanceCompact => ({ value: null, level: 'unknown', title: `${label}: shown in Personal only` });

/** The chip's hook: its own reading in Personal, `personalOnlyCompact` in an org context. */
export function personalOnlyHook(label: string, use: (ctx: GlanceContext) => GlanceCompact): (ctx: GlanceContext) => GlanceCompact {
  return (ctx) => {
    const own = use(ctx);
    return useInOrg() ? personalOnlyCompact(label) : own;
  };
}
