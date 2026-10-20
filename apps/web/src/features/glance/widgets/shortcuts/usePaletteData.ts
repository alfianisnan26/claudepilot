import type { ChatSession, TicketItem, Workspace } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { chatApi } from '@/features/chat/api';
import { ticketsApi } from '@/features/tickets/api';
import { api } from '@/lib/api';

/** What the palette searches besides the pages: sessions and workspaces (asked for when it opens) and tickets (asked for as you type). */
export interface PaletteData {
  sessions: ChatSession[] | null;
  workspaces: Workspace[] | null;
  /** Tickets the portal found for `forQuery`; a list for words other than the ones typed now is not used. */
  tickets: { forQuery: string; items: TicketItem[] } | null;
}

// The last lists seen, shown at once when the palette opens again while the new ones load.
let seen: { sessions: ChatSession[] | null; workspaces: Workspace[] | null } = { sessions: null, workspaces: null };

/** How long typing pauses before the portal's ticket search is asked. */
const TICKET_DEBOUNCE_MS = 220;

export function usePaletteData(query: string): PaletteData {
  const [base, setBase] = useState(seen);
  // One round of requests per opening. A list that cannot be loaded is simply not searched (the pages and actions still are).
  useEffect(() => {
    let live = true;
    void Promise.allSettled([chatApi.listAll(), api.workspaces.list()]).then(([s, w]) => {
      if (!live) return;
      seen = {
        sessions: s.status === 'fulfilled' ? s.value : seen.sessions,
        workspaces: w.status === 'fulfilled' ? w.value : seen.workspaces,
      };
      setBase(seen);
    });
    return () => {
      live = false;
    };
  }, []);

  const [tickets, setTickets] = useState<PaletteData['tickets']>(null);
  const q = query.trim();
  useEffect(() => {
    // T-1098: a ticket reference (T-12, KONF-3) is searched too: the portal's search finds it by either id, and its summary titles the row.
    if (q.length < 2) {
      setTickets(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      ticketsApi.list({ query: q, limit: 6 }).then(
        (list) => live && setTickets({ forQuery: q, items: list.items }),
        () => live && setTickets(null),
      );
    }, TICKET_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q]);

  return { ...base, tickets };
}
