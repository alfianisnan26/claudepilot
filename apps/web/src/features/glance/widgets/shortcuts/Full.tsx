import { useNavigate } from 'react-router';
import { GlanceList, GlanceRow } from '../../ui';
import type { GlanceFullProps } from '../../types';
import { isMacPlatform, shortcutLabel } from './keys';
import { openPalette } from './paletteStore';

const rowClass = 'press -mx-2 flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-surface-2';

/** Shortcuts: the quick search and a new session. (The chip itself opens the search; this is where the dock and a deep link land.) */
export function ShortcutsFull({ close }: GlanceFullProps) {
  const navigate = useNavigate();
  const key = shortcutLabel(isMacPlatform(typeof navigator === 'undefined' ? undefined : navigator));
  return (
    <GlanceList label="Shortcuts">
      <GlanceRow className="p-0">
        <button
          type="button"
          className={rowClass}
          onClick={() => {
            close();
            openPalette();
          }}
        >
          <span className="min-w-0 flex-1 text-sm font-medium">Search</span>
          <kbd className="hidden rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-xs text-muted sm:inline">{key}</kbd>
        </button>
      </GlanceRow>
      <GlanceRow className="p-0">
        <button
          type="button"
          className={rowClass}
          onClick={() => {
            close();
            navigate('/admin/sessions?new=1');
          }}
        >
          <span className="min-w-0 flex-1 text-sm font-medium">New agent</span>
        </button>
      </GlanceRow>
    </GlanceList>
  );
}
