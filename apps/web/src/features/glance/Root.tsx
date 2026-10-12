import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { useAuth } from '@/lib/auth';
import { applyBadge, badgeSupported, forgetBadgeWidget, reportBadgeCount, useBadgeTotal } from './badge';
import { useGlanceFocusValue } from './focus';
import { GlanceSheet } from './Host';
import { Quiet } from './Quiet';
import { GLANCE_WIDGETS, widgetById } from './registry';
import { useGlanceSettings } from './settings';
import type { GlanceWidget } from './types';

/** The query parameter that opens a widget's full form on any page: `?glance=attention` (the manifest's shortcut uses it). */
export const GLANCE_PARAM = 'glance';

/**
 * Mounted once, while signed in, outside any page (so also over the full-screen session page): the widgets' own global parts (key
 * listeners, a palette), the deep link that opens a full form, and the app badge.
 */
export function GlanceRoot() {
  const { state } = useAuth();
  if (state.status !== 'in') return null;
  return (
    <>
      {GLANCE_WIDGETS.map((w) =>
        w.Global ? (
          <Quiet key={w.id} what={`${w.id} (global)`}>
            <Mount Global={w.Global} />
          </Quiet>
        ) : null,
      )}
      <DeepLink />
      <AppBadge />
    </>
  );
}

function Mount({ Global }: { Global: NonNullable<GlanceWidget['Global']> }) {
  return <Global />;
}

/** `?glance=<id>` opens that widget's full form (a sheet), then the parameter goes, so a reload does not open it again. */
function DeepLink() {
  const [params, setParams] = useSearchParams();
  const focus = useGlanceFocusValue();
  const wanted = params.get(GLANCE_PARAM);
  const [shown, setShown] = useState<GlanceWidget | null>(null);
  // Another page (Back, a link) takes the sheet away; declared before the effect below so a link that carries ?glance= still opens its own.
  const { pathname } = useLocation();
  useEffect(() => setShown(null), [pathname]);
  useEffect(() => {
    if (!wanted) return;
    const w = widgetById(wanted);
    if (w) setShown(w);
    const next = new URLSearchParams(params);
    next.delete(GLANCE_PARAM);
    setParams(next, { replace: true });
  }, [wanted, params, setParams]);
  return shown ? <GlanceSheet widget={shown} ctx={{ focus, placement: 'header' }} onClose={() => setShown(null)} /> : null;
}

/** Feeds the icon badge: each widget with `badge: true` reports its count, the sum goes to the Badging API. */
function AppBadge() {
  const focus = useGlanceFocusValue();
  const { appBadge } = useGlanceSettings();
  const total = useBadgeTotal();
  const lastSet = useRef<number | null>(null);
  useEffect(() => {
    if (!badgeSupported()) return;
    const want = appBadge ? total : 0;
    if (want === null || want === lastSet.current) return;
    lastSet.current = want;
    void applyBadge(want);
  }, [total, appBadge]);
  // Signing out (or closing the tab's React tree) takes the number off.
  useEffect(
    () => () => {
      lastSet.current = null;
      if (badgeSupported()) void applyBadge(0);
    },
    [],
  );
  return (
    <>
      {GLANCE_WIDGETS.filter((w) => w.badge).map((w) => (
        <Quiet key={w.id} what={`${w.id} (badge)`}>
          <BadgeFeed widget={w} focus={focus} />
        </Quiet>
      ))}
    </>
  );
}

function BadgeFeed({ widget, focus }: { widget: GlanceWidget; focus: ReturnType<typeof useGlanceFocusValue> }) {
  const state = widget.useCompact({ focus, placement: 'header' });
  const count = state.loading ? null : (state.count ?? 0);
  useEffect(() => {
    reportBadgeCount(widget.id, count);
  }, [widget.id, count]);
  useEffect(() => () => forgetBadgeWidget(widget.id), [widget.id]);
  return null;
}
