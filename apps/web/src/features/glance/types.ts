import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

// The glance framework (docs/prd/glance-widgets.md): one frame draws every widget in every place, so a widget is only
// data and two small pieces of UI: a hook for its compact form and a component for its full form.

/**
 * Where a widget can be drawn.
 * - `header`: the phone's app bar and, on larger screens, the sidebar (a strip of icon + number).
 * - `dock`: the desktop's side dock (1280 px and up), compact chips on a rail or every full form in a panel.
 * - `list`: the top of the Sessions list.
 * - `composer`: above the session page's composer.
 * The full form of a chip is a popover on a larger screen and a bottom sheet on a phone, whatever the placement.
 */
export type GlancePlacement = 'header' | 'dock' | 'list' | 'composer';

export const GLANCE_PLACEMENTS: readonly GlancePlacement[] = ['header', 'dock', 'list', 'composer'];

/**
 * How a widget stands, which colours its dot (and never says it alone: `title` says it in words).
 * `ok` fine, `warn` look soon, `critical` look now, `idle` nothing going on, `unknown` no data (a hollow dot).
 */
export type GlanceLevel = 'ok' | 'warn' | 'critical' | 'idle' | 'unknown';

/**
 * What the person is looking at, published by the page showing it (`useGlanceFocus`): the open session and its Claude.
 * A widget that cares (Quota: the ACTIVE Claude is the open session's) reads it; the others ignore it.
 */
export interface GlanceFocus {
  sessionId: string | null;
  claudeId: string | null;
  workspaceId: string | null;
}

/** What the frame hands a widget's hook and full form. */
export interface GlanceContext {
  focus: GlanceFocus;
  /** Where the compact form is being drawn right now (a widget may show less in a tight place). */
  placement: GlancePlacement;
}

/**
 * A widget's compact form: icon (the widget's own) + `value` + a dot for `level`. The frame draws it; the widget only says what.
 * Every figure keeps its basis (PLAN-4 P1): an estimate says so in `title`, unavailable data is `-` with `unknown`.
 */
export interface GlanceCompact {
  /** The short text beside the icon: "72 %", "3", "-". Five characters at most (a phone's strip is narrow). Null: the icon alone. */
  value: string | null;
  level: GlanceLevel;
  /** The chip's accessible name and tooltip: one sentence, with the state in words ("Quota: 28 % left, resets 14:20, low"). */
  title: string;
  /**
   * How many things wait on the person. Only a widget with `badge: true` sets it: the sum of these counts is the number
   * on the installed app's icon (the Badging API, where the platform has it).
   */
  count?: number;
  /** The reading is old (a stopped workspace, a failed refresh): the chip is dimmed. */
  stale?: boolean;
  /** The data has not arrived yet: the chip shows a quiet placeholder and can already be opened. */
  loading?: boolean;
}

/** Where a full form is drawn: in a popover (larger screens), a bottom sheet (phones, and a deep link anywhere) or the dock's panel. */
export type GlanceSurface = 'popover' | 'sheet' | 'dock';

export interface GlanceFullProps {
  ctx: GlanceContext;
  surface: GlanceSurface;
  /** Closes the popover or sheet. Call it after navigating away (a tap on a row that opens a session). A no-op in the dock. */
  close: () => void;
}

/** What `activate` can do. */
export interface GlanceActivateApi {
  /** Opens the full form (what a tap does when the widget has no `activate`). */
  open: () => void;
  navigate: (to: string) => void;
}

/**
 * One widget. Register it in `registry.ts` (one line). The frame calls `useCompact` once per place that shows the widget (and
 * once more for the app badge), so the hook must read a shared store (like `useClaudeUsage`) and never fetch on its own;
 * live data comes only through the existing live mechanism (`useLive`), with no polling of its own.
 */
export interface GlanceWidget {
  /** Stable and unique: saved in the person's settings and used in `?glance=<id>` links. Lower case, no spaces. */
  id: string;
  /** One word: "Quota", "Sessions", "Agents", "Attention", "Shortcuts". */
  label: string;
  icon: LucideIcon;
  /** What it shows, in a sentence: the Settings list's ⓘ. Never drawn in the frame itself. */
  about: string;
  /** The page behind it, shown as an Open link in the full form's header ("/admin/usage?tab=claudes"). */
  href?: string;
  /** Where it can be drawn; every place when left out. */
  placements?: readonly GlancePlacement[];
  /** Its `count` feeds the app icon's badge. */
  badge?: boolean;
  useCompact: (ctx: GlanceContext) => GlanceCompact;
  /** The same content in every surface. Load heavy ones lazily (`lazy(() => import('./Full'))`): the frame wraps it in Suspense. */
  Full: ComponentType<GlanceFullProps>;
  /** Mounted once for the whole signed-in app, rendering nothing visible unless it needs to: key listeners, a palette dialog. */
  Global?: ComponentType;
  /** Extra rows under this widget in Settings > Glance (its own switches). */
  Settings?: ComponentType;
  /** A tap on the chip does this instead of opening the full form (the quick-search chip opens its palette). */
  activate?: (api: GlanceActivateApi) => void;
  /**
   * Off in the strips until the person switches it on in Settings > Glance (the widgets made for the Home page, so a phone's header
   * does not fill up with chips nobody asked for). It still shows on the Home page.
   */
  defaultHidden?: boolean;
  /** The widget's card on the Home page (docs/prd/glance-widgets.md §18). Widgets without one are not on Home. May be lazy. */
  Card?: ComponentType;
  /** The card's title when it differs from `label` ("Needs you" for Attention); one or two words. */
  cardLabel?: string;
  /** The card's ⓘ when it says more than `about`. */
  cardAbout?: string;
}
