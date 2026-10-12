import { Button, SwitchRow, useToast } from '@isnanme/ui';
import type { PersonaPolicy, PoolSummary } from '@portal/contracts';
import { ImagePlus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { personasApi } from './api';
import { PersonaAvatar } from './PersonaAvatar';

/** A switch's label with its note behind an ⓘ (the text diet). */
const Labelled = ({ text, tip }: { text: string; tip: string }) => (
  <span className="inline-flex items-center gap-1">
    {text}
    <InfoTip label={`About ${text.toLowerCase()}`}>{tip}</InfoTip>
  </span>
);

/**
 * A persona's face and what agents may do about it (Persona PRD A10, interface I11): the avatar (a PNG, JPEG or
 * WebP the portal re-encodes), and three switches that act at once, since none of them is part of a revision.
 * The portal-wide switch in Settings outranks the persona's own.
 */
export function IdentityPanel({ pool, name }: { pool: PoolSummary; name: string }) {
  const toast = useToast();
  const [policy, setPolicy] = useState<PersonaPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(() => {
    personasApi.policy(pool.id).then(setPolicy, () => undefined);
  }, [pool.id]);
  useEffect(load, [load]);
  useLive('pools', load);
  if (!policy) return null;

  const change = async (run: () => Promise<unknown>, fail: string) => {
    setBusy(true);
    try {
      await run();
    } catch (e) {
      toast(errorText(e, fail), 'error');
    } finally {
      setBusy(false);
      load();
    }
  };
  const setSwitch = (body: { agentsMayPropose?: boolean; autoApproveCosmetic?: boolean }) => change(() => personasApi.setPolicy(pool.id, body), 'Could not change it.');

  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-center gap-3 py-1">
        <PersonaAvatar name={name || pool.name} avatar={policy.avatar} size="lg" />
        <div className="flex items-center gap-1">
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void change(() => personasApi.setAvatar(pool.id, f), 'Could not use that image.');
            }}
          />
          <Button size="sm" variant="secondary" icon={<ImagePlus className="size-4" />} onClick={() => file.current?.click()} disabled={busy}>
            Avatar
          </Button>
          {policy.avatar && <Button size="sm" variant="ghost" aria-label="Remove the avatar" title="Remove the avatar" icon={<Trash2 className="size-4" />} onClick={() => void change(() => personasApi.clearAvatar(pool.id), 'Could not remove it.')} disabled={busy} />}
        </div>
      </div>
      <SwitchRow
        label={<Labelled text="Default for new workspaces" tip="The create dialog starts with this persona selected. You can still pick another or none." />}
        checked={policy.isDefault}
        disabled={busy || pool.revision === 0}
        onChange={(on) => void change(() => personasApi.setDefault(on ? pool.id : null), 'Could not change it.')}
      />
      <SwitchRow
        label={
          <Labelled
            text="Agents may propose changes"
            tip={
              policy.portalAllows
                ? 'Sessions in workspaces with this persona can propose a new name, an avatar and edits to the instructions. Nothing applies until you approve it.'
                : 'Switched off for the whole portal. Turn on “Agents may propose changes” in Settings first.'
            }
          />
        }
        checked={policy.agentsMayPropose}
        disabled={busy || !policy.portalAllows}
        onChange={(on) => void setSwitch({ agentsMayPropose: on })}
      />
      {policy.agentsMayPropose && policy.portalAllows && (
        <SwitchRow
          label={<Labelled text="Auto-approve name and avatar" tip="A proposed name or avatar applies at once. Instructions always wait for you." />}
          checked={policy.autoApproveCosmetic}
          disabled={busy}
          onChange={(on) => void setSwitch({ autoApproveCosmetic: on })}
        />
      )}
    </section>
  );
}
