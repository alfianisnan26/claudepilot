// The workspace sheet's tabs (owner request 2026-11-01: less scrolling): its Claudes, its details, its repositories, one at a time. Pure, so
// which tab opens is tested without a browser.

export type SheetTab = 'claudes' | 'details' | 'repos';

export const SHEET_TABS: readonly { value: SheetTab; label: string }[] = [
  { value: 'claudes', label: 'Claudes' },
  { value: 'details', label: 'Details' },
  { value: 'repos', label: 'Repos' },
];

/** What this workspace has: Claudes while it runs or is last known (T-515), Repos when its repositories are scanned (not Kubernetes). */
export interface SheetHas {
  claudes: boolean;
  repos: boolean;
}

/** The tabs this workspace's sheet offers, in order. */
export const sheetTabs = (has: SheetHas) => SHEET_TABS.filter((t) => (t.value === 'claudes' ? has.claudes : t.value === 'repos' ? has.repos : true));

/** The tab the sheet shows: the one asked for when this workspace has it, else Claudes when it has them, else Details. */
export function sheetTab(asked: SheetTab | undefined, has: SheetHas): SheetTab {
  if (asked === 'repos' && has.repos) return 'repos';
  if (asked === 'details') return 'details';
  return has.claudes ? 'claudes' : 'details';
}
