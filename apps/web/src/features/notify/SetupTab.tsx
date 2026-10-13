import { Titled } from './Titled';
import { LoadError, RowsSkeleton, Section } from '@isnanme/ui';
import { AnswersSection } from './AnswersSection';
import { DevicesSection } from './DevicesSection';
import { EventsMatrix } from './EventsMatrix';
import { MutedSection } from './MutedSection';
import { QuietSection } from './QuietSection';
import { StateBanner } from './StateBanner';
import { ThisDevice } from './ThisDeviceCard';
import { useNotifyOverview } from './store';

/** Setup: this device, the other devices and channels, which events go where, quiet hours, and what may be answered. */
export function SetupTab() {
  const { overview, failed, reload } = useNotifyOverview();
  if (failed && !overview) return <LoadError onRetry={reload} />;
  if (!overview) return <RowsSkeleton rows={3} lines={1} icon="rounded-2xl" />;
  return (
    <div className="flex flex-col gap-8">
      <StateBanner state={overview.state} />
      <ThisDevice overview={overview} />
      <DevicesSection overview={overview} />
      <Section title={<Titled title="Events">Rows are events and columns are where they go. A new device or channel starts with the defaults.</Titled>} visibleTitle>
        <EventsMatrix destinations={overview.destinations} />
      </Section>
      <Section title={<Titled title="Quiet hours">Held messages arrive as one summary when the window ends. Events marked to break through are delivered anyway.</Titled>} visibleTitle>
        <QuietSection destinations={overview.destinations} />
      </Section>
      <MutedSection destinations={overview.destinations} />
      <Section title={<Titled title="Answers">Which requests you may answer from a notification, on this account. Deny is on by default; Allow is off until you switch it on. A tap on the notification itself always opens the request.</Titled>} visibleTitle>
        <AnswersSection overview={overview} />
      </Section>
    </div>
  );
}
