// A chat's auto move state (`GET /api/autotransfer/sessions/:id`) and its automatic moves of the last day (for the "Moved to" divider),
// loaded again when the server says something changed (live topic `autotransfer`) and when the chat changes Claude.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AutoSessionState, AutoTransferEvent } from '@portal/contracts';
import { useLive } from '@/lib/live';
import { autoApi } from './api';
import { autoMarks } from './pure';

export function useAutoMove(sessionId: string, claudeId: string | null | undefined) {
  const [state, setState] = useState<AutoSessionState | null>(null);
  const [events, setEvents] = useState<AutoTransferEvent[]>([]);
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    autoApi.session(sessionId).then(
      (s) => n === seq.current && setState(s),
      () => n === seq.current && setState(null),
    );
    autoApi.events(sessionId).then(
      (e) => n === seq.current && setEvents(e),
      () => undefined,
    );
  }, [sessionId]);
  useEffect(() => {
    setState(null);
    setEvents([]);
    load();
  }, [load, claudeId]);
  useLive('autotransfer', () => load());
  const marks = useMemo(() => autoMarks(events, Date.now()), [events]);
  return { state, setState, marks, reload: load };
}
