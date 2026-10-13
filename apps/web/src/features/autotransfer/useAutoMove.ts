// A chat's auto move state (`GET /api/autotransfer/sessions/:id`), its automatic moves of the last day (for the "Moved to" divider) and the
// platform's mode (the ceiling: the session menu's item and the card's "Always automatic" depend on it), loaded again when the server says
// something changed (live topic `autotransfer`) and when the chat changes Claude.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AutoMode, AutoSessionState, AutoTransferEvent } from '@portal/contracts';
import { useLive } from '@/lib/live';
import { autoApi } from './api';
import { autoMarks } from './pure';

export function useAutoMove(sessionId: string, claudeId: string | null | undefined) {
  const [state, setState] = useState<AutoSessionState | null>(null);
  const [events, setEvents] = useState<AutoTransferEvent[]>([]);
  // Null until read (or when the read failed): the page then offers nothing of auto move.
  const [platformMode, setPlatformMode] = useState<AutoMode | null>(null);
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
    autoApi.overview().then(
      (o) => n === seq.current && setPlatformMode(o.platform.mode),
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
  // "Always automatic" shows only when the platform allows `auto` (FR15).
  return { state, setState, marks, platformMode, allowAuto: platformMode === 'auto', reload: load };
}
