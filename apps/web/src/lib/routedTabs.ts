// A page's tabs as sub-routes (owner request 2026-11-01: "properly use tabbed menus, so not bloated in a single page"). Every long page is a
// title and a tab bar; each tab is its own path (`/admin/settings/sessions`), so back/forward and deep links work and only the open tab's
// content mounts (and asks for its data). Pure, so the routing and who-sees-what are tested without a browser; `components/RoutedTabs.tsx`
// draws it.

export interface TabDef {
  id: string;
  label: string;
  /** Left out (a section with nothing to show for this person or this state). */
  hidden?: boolean;
  /** A platform area: shown to an admin only (D-82 S1a: a member gets the same 404 from the server, so the tab is not offered). */
  adminOnly?: boolean;
}

/** From this many tabs on, a wide screen lists them in a side nav beside the content instead of a bar over it. */
export const SIDE_NAV_MIN = 7;

/** The tabs this person sees, in order. */
export function shownTabs<T extends TabDef>(tabs: readonly T[], who: { admin: boolean }): T[] {
  return tabs.filter((t) => !t.hidden && (who.admin || !t.adminOnly));
}

/** `bar`: a tab bar under the title (and always on a phone). `side`: a side nav on a wide screen, for a long list of sections. */
export const tabLayout = (count: number): 'bar' | 'side' => (count >= SIDE_NAV_MIN ? 'side' : 'bar');

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/**
 * The tab segment of `pathname` under `base`: '' at the base itself, the one segment after it, or null when the path is not this page's (a
 * deeper path such as `/admin/pools/skills/library` belongs to a page of its own).
 */
export function tabSegment(pathname: string, base: string): string | null {
  const p = trim(pathname);
  const b = trim(base);
  if (p === b) return '';
  if (!p.startsWith(`${b}/`)) return null;
  const rest = p.slice(b.length + 1);
  if (!rest || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

/** Where a tab lives: the first tab is the page's own path (the address people already have), the others `base/<id>`. */
export function tabHref(base: string, tabs: readonly TabDef[], id: string): string {
  const b = trim(base);
  return tabs[0]?.id === id ? b : `${b}/${encodeURIComponent(id)}`;
}

export interface TabResolution<T extends TabDef> {
  /** The open tab (undefined: no tab to show). */
  active: T | undefined;
  /** Where to go instead (replace, not push): a tab that is unknown or not this person's goes to the page's first tab. */
  redirect: string | null;
}

/**
 * Which tab `pathname` (with its `search`) opens. A legacy `?tab=<id>` link (notifications, server links and bookmarks from before the
 * sub-routes) moves to `base/<id>` with its other parameters kept; a segment that names no shown tab goes to the base. `base/<first>`
 * shows the first tab as it is.
 */
export function resolveTab<T extends TabDef>(tabs: readonly T[], base: string, pathname: string, search = ''): TabResolution<T> {
  const seg = tabSegment(pathname, base);
  const params = new URLSearchParams(search);
  const legacy = params.get('tab');
  if (legacy !== null && (seg === '' || seg === null)) {
    params.delete('tab');
    const rest = params.toString();
    const known = tabs.some((t) => t.id === legacy);
    return { active: undefined, redirect: `${known ? tabHref(base, tabs, legacy) : trim(base)}${rest ? `?${rest}` : ''}` };
  }
  if (!seg) return { active: tabs[0], redirect: null };
  const hit = tabs.find((t) => t.id === seg);
  if (hit) return { active: hit, redirect: null };
  return { active: undefined, redirect: `${trim(base)}${search && search !== '?' ? (search.startsWith('?') ? search : `?${search}`) : ''}` };
}

/** Pages whose tabs are sub-routes: one segment under one of these is the same page, so the app frame does not remount or re-animate it. */
const TABBED_PAGES: readonly RegExp[] = [
  /^\/admin\/settings$/,
  /^\/admin\/notifications$/,
  /^\/admin\/pools$/,
  /^\/admin\/ci$/,
  /^\/admin\/access$/,
  /^\/admin\/usage$/,
  /^\/admin\/profile$/,
  /^\/admin\/orgs\/[^/]+$/,
];

/** The page `pathname` belongs to, for the frame's key: a tabbed page's tab path maps to its base, every other path to itself. */
export function pageKey(pathname: string): string {
  const p = trim(pathname);
  if (TABBED_PAGES.some((r) => r.test(p))) return p;
  const parent = p.slice(0, p.lastIndexOf('/'));
  return parent && TABBED_PAGES.some((r) => r.test(parent)) ? parent : p;
}
