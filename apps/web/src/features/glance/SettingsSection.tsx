import { Switch } from '@isnanme/ui';
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { badgeSupported } from './badge';
import { GLANCE_WIDGETS } from './registry';
import { Row } from './settingsParts';
import { DEFAULT_SETTINGS, isHidden, moveInOrder, orderWidgets, resetGlanceSettings, setShown, updateGlanceSettings, useGlanceSettings } from './settings';
import type { GlancePlacement } from './types';

const PLACES: { id: GlancePlacement; label: string; about: string }[] = [
  { id: 'header', label: 'Header', about: 'The strip in the phone’s top bar and at the foot of the sidebar.' },
  { id: 'list', label: 'Sessions page', about: 'A labelled row above the Sessions list (not repeated on a phone while the header strip shows).' },
  { id: 'composer', label: 'Composer', about: 'A small row above the message box in a session.' },
  { id: 'dock', label: 'Side dock', about: 'From 1280 px wide: a rail of chips on the right edge. Open it to see every widget in full; it then makes room instead of covering the page.' },
];

/**
 * Settings > Glance (PRD glance-widgets §8): which widgets show and in what order, where they show, Quota's mode and its colour
 * thresholds, the app badge. Per device (the portal has one shared sign-in, so a phone and a laptop each keep their own).
 */
export function GlanceSettingsSection() {
  const s = useGlanceSettings();
  const all = orderWidgets(GLANCE_WIDGETS, s, true);
  const ids = all.map((w) => w.id);
  const changed = JSON.stringify(s) !== JSON.stringify(DEFAULT_SETTINGS);
  const setOn = (id: string, on: boolean) => updateGlanceSettings(setShown({ id }, on, s));
  return (
    <section aria-labelledby="settings-glance">
      <h2 id="settings-glance" className="mb-2 flex items-center gap-1 px-1 text-[13px] font-semibold text-muted">
        Glance
        <InfoTip label="About glance">Small status widgets in the header, the Sessions list, the composer and a side dock. These choices are kept on this device only.</InfoTip>
        {changed && (
          <button type="button" onClick={resetGlanceSettings} aria-label="Reset glance settings" title="Reset glance settings" className="press ml-auto inline-flex size-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink">
            <RotateCcw className="size-4" />
          </button>
        )}
      </h2>
      <Card>
        <ul className="divide-y divide-line">
          {all.map((w, i) => {
            const on = !isHidden(w, s);
            const Icon = w.icon;
            return (
              <li key={w.id}>
                <div className="flex min-h-14 items-center gap-2 px-4 py-2.5 sm:px-5">
                  <Icon className="size-[18px] shrink-0 text-muted" aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 items-center gap-1 font-semibold">
                    <span className="truncate">{w.label}</span>
                    <InfoTip label={`About ${w.label}`}>{w.about}</InfoTip>
                  </span>
                  <span className="flex shrink-0 items-center">
                    <MoveButton label={`Move ${w.label} up`} disabled={i === 0} onClick={() => updateGlanceSettings({ order: moveInOrder(ids, w.id, -1) })}>
                      <ArrowUp className="size-4" />
                    </MoveButton>
                    <MoveButton label={`Move ${w.label} down`} disabled={i === all.length - 1} onClick={() => updateGlanceSettings({ order: moveInOrder(ids, w.id, 1) })}>
                      <ArrowDown className="size-4" />
                    </MoveButton>
                  </span>
                  <Switch label={`Show ${w.label}`} checked={on} onChange={(v) => setOn(w.id, v)} />
                </div>
                {w.Settings && on && (
                  <div className="border-t border-line px-4 pl-11 sm:px-5 sm:pl-12">
                    <w.Settings />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card className="mt-3">
        <ul className="divide-y divide-line">
          {PLACES.map((p) => (
            <li key={p.id} className="px-4 sm:px-5">
              <Row label={p.label} about={p.about}>
                <Switch label={`Show in ${p.label}`} checked={s.places[p.id]} onChange={(v) => updateGlanceSettings({ places: { ...s.places, [p.id]: v } })} />
              </Row>
            </li>
          ))}
          {badgeSupported() && (
            <li className="px-4 sm:px-5">
              <Row label="App badge" about="Shows the needs-attention count on the installed app’s icon. It is set while the app is open and stays as it was after it closes: nothing updates it until there is push.">
                <Switch label="App badge" checked={s.appBadge} onChange={(v) => updateGlanceSettings({ appBadge: v })} />
              </Row>
            </li>
          )}
        </ul>
      </Card>
    </section>
  );
}

function MoveButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="press inline-flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-30 tap:size-11">
      {children}
    </button>
  );
}
