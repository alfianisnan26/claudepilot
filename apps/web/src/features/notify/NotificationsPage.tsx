import { PageTabs } from '@isnanme/ui';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { InboxTab } from './InboxTab';
import { SetupTab } from './SetupTab';
import { useNotifyOverview } from './store';

/** Notifications (PWA PRD 11.6): what arrived, and where and when it goes. */
export function NotificationsPage() {
  const [params, setParams] = useSearchParams();
  const { overview } = useNotifyOverview();
  const tab = params.get('tab') === 'setup' ? 'setup' : 'inbox';
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
    </>
  );
}
