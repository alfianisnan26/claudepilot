import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { RoutedTabs } from '@/components/RoutedTabs';
import { InboxTab } from './InboxTab';
import { MuteDialog } from './MuteDialog';
import { SetupTab } from './SetupTab';
import { useNotifyOverview } from './store';

const BASE = '/admin/notifications';

/** Notifications (PWA PRD 11.6): what arrived (`/admin/notifications`), and where and when it goes (`/admin/notifications/setup`). */
export function NotificationsPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { overview } = useNotifyOverview();
  // A push's Mute button opens `?mute=evt_…`: the sheet for that event, over the Inbox.
  const mute = params.get('mute');
  const muteRef = mute && /^(evt|nh)_[0-9a-f]{16}$/.test(mute) ? mute : null;
  return (
    <>
      <PageHeader title="Notifications" description="Messages say what happened and where, never the text of a prompt, a reply or a command. Turn a device on in Setup." />
      <RoutedTabs
        base={BASE}
        label="Notifications"
        tabs={[
          { id: 'inbox', label: 'Inbox', badge: overview?.unread || undefined, content: <InboxTab /> },
          { id: 'setup', label: 'Setup', content: <SetupTab /> },
        ]}
      />
      <MuteDialog muteRef={muteRef} onClose={() => navigate(pathname, { replace: true })} />
    </>
  );
}
