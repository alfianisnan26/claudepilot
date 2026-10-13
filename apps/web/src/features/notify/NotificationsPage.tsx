import { PageTabs } from '@isnanme/ui';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { InboxTab } from './InboxTab';
import { MuteDialog } from './MuteDialog';
import { SetupTab } from './SetupTab';
import { useNotifyOverview } from './store';

/** Notifications (PWA PRD 11.6): what arrived, and where and when it goes. */
export function NotificationsPage() {
  const [params, setParams] = useSearchParams();
  const { overview } = useNotifyOverview();
  const tab = params.get('tab') === 'setup' ? 'setup' : 'inbox';
  // A push's Mute button opens `?mute=evt_…`: the sheet for that event, over the Inbox.
  const mute = params.get('mute');
  const muteRef = mute && /^(evt|nh)_[0-9a-f]{16}$/.test(mute) ? mute : null;
  return (
    <>
      <PageHeader title="Notifications" description="Messages say what happened and where, never the text of a prompt, a reply or a command. Turn a device on in Setup." />
      <PageTabs
        label="Notifications"
        stack="never"
        value={tab}
        onChange={(id) => setParams(id && id !== 'inbox' ? { tab: id } : {}, { replace: true })}
        tabs={[
          { id: 'inbox', label: 'Inbox', badge: overview?.unread || undefined, content: <InboxTab /> },
          { id: 'setup', label: 'Setup', content: <SetupTab /> },
        ]}
      />
      <MuteDialog muteRef={muteRef} onClose={() => setParams(tab === 'inbox' ? {} : { tab }, { replace: true })} />
    </>
  );
}
