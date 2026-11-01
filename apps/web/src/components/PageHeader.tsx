import { HubContext } from '@isnanme/ui';
import { useContext, type ReactNode } from 'react';
import { InfoTip } from './InfoTip';

/**
 * A page's title row. What the page is for sits behind an ⓘ next to the title, not in a paragraph under it (the text
 * diet: words only where a decision depends on them). Inside a hub tab (Pools) the tab already names the page, so
 * the title is kept for screen readers only and the row is just the ⓘ and the page's action.
 */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  const inHub = useContext(HubContext);
  const about = description ? <InfoTip label={typeof title === 'string' ? `About ${title}` : 'About this page'}>{description}</InfoTip> : null;
  if (inHub && !about && !action) return <h2 className="sr-only">{title}</h2>;
  if (inHub)
    return (
      <div className="mb-4 flex items-center justify-end gap-2">
        <h2 className="sr-only">{title}</h2>
        {about}
        {action && <div className="shrink-0">{action}</div>}
      </div>
    );
  return (
    // One row height on every page (44 px, the height of an action button), the title centred in it: the title sits at the same place
    // whether or not the page has an action (UX sweep 2026-11-01: it moved 12 px between Agents and Usage).
    <div data-page-header="" className="mb-6 flex min-h-11 items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-1.5">
        <h1 className="truncate text-2xl font-bold tracking-tight sm:text-[28px]">{title}</h1>
        {about}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
