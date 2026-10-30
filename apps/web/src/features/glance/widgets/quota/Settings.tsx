import { Segmented } from '@isnanme/ui';
import { Percent, Row } from '../../settingsParts';
import { updateGlanceSettings, useGlanceSettings } from '../../settings';

/** Quota's own settings, under its row in Settings > Glance: which Claude it follows and where its colours turn. */
export function QuotaSettings() {
  const s = useGlanceSettings();
  return (
    <div className="divide-y divide-line">
      <Row label="Mode" about="Active: the open agent’s Claude, else the one used last. All: the chip shows the Claude with the least left, and the full form lists every Claude.">
        <div className="w-40">
          <Segmented
            label="Quota mode"
            value={s.quotaMode}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'all', label: 'All' },
            ]}
            onChange={(v) => updateGlanceSettings({ quotaMode: v })}
          />
        </div>
      </Row>
      <Row label="Warn" about="Percent of a plan window used at which Quota turns yellow. Default 80, the portal’s alert level.">
        <Percent label="Warn at" value={s.thresholds.warn} min={1} max={s.thresholds.critical - 1} onCommit={(warn) => updateGlanceSettings({ thresholds: { ...s.thresholds, warn } })} />
      </Row>
      <Row label="Critical" about="Percent used at which Quota turns red. Default 95. Above Warn.">
        <Percent label="Critical at" value={s.thresholds.critical} min={s.thresholds.warn + 1} max={100} onCommit={(critical) => updateGlanceSettings({ thresholds: { ...s.thresholds, critical } })} />
      </Row>
    </div>
  );
}
