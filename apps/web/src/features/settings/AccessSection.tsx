import { Badge, Button, useToast } from '@isnanme/ui';
import type { SessionShareOverview } from '@portal/contracts';
import { MessageSquare, Trash2, UserRound, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { CAP_LABEL, endText } from '@/features/chat/ShareSessionDialog';
import { api, errorText } from '@/lib/api';

/** Every session share on the portal in one list (owner, 2026-10-17: "controllable"): who has what, until when; revoke from here. */
export function AccessSection() {
  const toast = useToast();
  const [list, setList] = useState<SessionShareOverview[] | null>(null);
  const [more, setMore] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.allShares());
    } catch (e) {
      toast(errorText(e, 'Couldn’t load the shares.'), 'error');
    }
  }, [toast]);
  useEffect(() => void load(), [load]);

  const revoke = async (s: SessionShareOverview) => {
    try {
      await api.revokeShare(s.id);
      toast('Access removed');
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t remove it.'), 'error');
    }
  };
  const shown = list && !more ? list.slice(0, 10) : list;

  return (
    <section aria-labelledby="settings-access" data-settings-access="">
      <div className="mb-2 flex items-center gap-1 px-1">
        <h2 id="settings-access" className="flex flex-1 items-center gap-1 text-[13px] font-semibold text-muted">
          Shared agents
          <InfoTip label="About shared agents">Every agent shared with an account or a team. Share from an agent’s menu; remove here or there.</InfoTip>
        </h2>
      </div>
      <Card>
        {list === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : list.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">Nothing is shared.</p>
        ) : (
          <ul className="divide-y divide-line">
            {shown!.map((s) => (
              <li key={s.id} className="flex min-h-14 items-center gap-2 px-4 py-2 sm:px-5">
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5 font-medium">
                    <MessageSquare className="size-4 shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{s.sessionTitle ?? 'A removed agent'}</span>
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-1 pt-0.5 text-[12.5px] text-muted">
                    {s.subject.kind === 'team' ? <Users className="size-3.5 shrink-0" aria-hidden="true" /> : <UserRound className="size-3.5 shrink-0" aria-hidden="true" />}
                    <span className="min-w-0 [overflow-wrap:anywhere]">{s.subjectName}</span>
                    {s.caps.map((c) => (
                      <Badge key={c} tone={c === 'read' ? 'neutral' : 'warning'}>
                        {CAP_LABEL[c]}
                      </Badge>
                    ))}
                    {endText(s) && <span className={s.expired ? 'text-danger' : ''}>{endText(s)}</span>}
                  </span>
                </span>
                <Button variant="ghost" size="icon" aria-label={`Remove ${s.subjectName} from ${s.sessionTitle ?? 'the agent'}`} onClick={() => void revoke(s)}>
                  <Trash2 className="size-[18px]" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {list && list.length > 10 && (
          <button type="button" onClick={() => setMore((m) => !m)} className="press min-h-11 w-full border-t border-line text-sm font-semibold text-ink-soft">
            {more ? 'Show less' : `Show all ${list.length}`}
          </button>
        )}
      </Card>
    </section>
  );
}
