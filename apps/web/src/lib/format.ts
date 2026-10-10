const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));

const time = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' });
const dayTime = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** "14:05" today, "1 Nov, 00:00" another day: for "until …" labels. */
export function formatUntil(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  return d.toDateString() === new Date(now).toDateString() ? time.format(d) : dayTime.format(d);
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(s / 3600), 'hour');
  return relative.format(Math.round(s / 86400), 'day');
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
