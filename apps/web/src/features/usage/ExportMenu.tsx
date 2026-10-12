import { Menu } from '@isnanme/ui';
import { Download } from 'lucide-react';

/** Starts a download without leaving the page: the portal answers with `Content-Disposition: attachment` and the browser sends the session cookie. */
function download(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** The export button of a tab: one icon, a menu of the files it can give (docs/prd/claude-usage.md §20.9). */
export function ExportMenu({ items }: { items: { label: string; url: string }[] }) {
  return <Menu label="Export" align="right" trigger={<Download className="size-[18px]" aria-hidden="true" />} items={items.map((i) => ({ label: i.label, onSelect: () => download(i.url) }))} />;
}
