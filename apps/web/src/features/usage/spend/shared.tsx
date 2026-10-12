import { InfoTip } from '@/components/InfoTip';

/** The one line a tab shows when the portal will not show it to this person (permission denied: several users are coming). */
export function NotAvailable() {
  return (
    <p className="flex items-center gap-1 py-3 text-[13px] text-muted">
      Not available to you.
      <InfoTip label="Why">Your account is not allowed to see this. Ask an owner of the portal.</InfoTip>
    </p>
  );
}
