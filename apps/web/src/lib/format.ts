const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(s / 3600), 'hour');
  return relative.format(Math.round(s / 86400), 'day');
}
