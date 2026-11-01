import { Button, Dialog, useToast } from '@isnanme/ui';
import type { MoveToOrgCredential, Org, OrgTransferKind } from '@portal/contracts';
import { ArrowRightToLine, BookOpen, Box, ChevronRight, KeyRound, Ticket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { BoundedBody } from '@/components/BoundedBody';
import { Card } from '@/components/Card';
import { api } from '@/lib/api';
import { AccessSheet } from './AccessSheet';
import { useOrgs } from './OrgsProvider';
import { canMoveHere, consentCredentials, KIND_LABEL, objectRows, orgErrorText, type OrgObjectRow } from './rules';
import { Alert, SectionTitle } from './settingsUi';

const ICON: Record<OrgTransferKind, typeof Box> = { workspace: Box, ticket_bucket: Ticket, vault: BookOpen };

/**
 * Objects: what the org owns (workspaces, ticket buckets, vaults, through the lists' `?org=<id>`), each opening in the org's context, and
 * Move here (members and up) for a personal object the person manages, with the credentials consent step for a workspace (slice 5).
 */
export function ObjectsSection({ org, rows, meId, onMoved }: { org: Org; rows: OrgObjectRow[] | null; meId: string | null; onMoved: () => Promise<void> }) {
  const { setContext } = useOrgs();
  const [moving, setMoving] = useState(false);
  const [access, setAccess] = useState<OrgObjectRow | null>(null);

  return (
    <section aria-labelledby="org-objects" data-org-objects="">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <SectionTitle id="org-objects" about="What this organization owns. Its owners and admins manage each one; Move here hands one of yours over.">
          Objects
        </SectionTitle>
        {canMoveHere(org.myRole) && (
          <Button variant="secondary" icon={<ArrowRightToLine className="size-4" />} onClick={() => setMoving(true)} data-org-move-open="">
            Move here
          </Button>
        )}
      </div>
      <Card>
        {rows === null ? (
          <div className="skeleton m-4 h-10 rounded-xl" />
        ) : rows.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">Nothing yet.</p>
        ) : (
          <BoundedBody><ul className="divide-y divide-line">
            {rows.map((r) => {
              const Icon = ICON[r.kind];
              return (
                <li key={`${r.kind}:${r.id}`} data-org-object={`${r.kind}:${r.id}`} className="flex items-center pr-2 sm:pr-3">
                  <Link
                    to={r.href}
                    onClick={() => setContext({ kind: 'org', id: org.id })}
                    className="press flex min-h-14 min-w-0 flex-1 items-center gap-3 px-4 py-2 outline-hidden focus-visible:ring-2 focus-visible:ring-accent sm:px-5"
                  >
                    <Icon className="size-[18px] shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium [overflow-wrap:anywhere]">{r.name}</span>
                      <span className="block text-[12.5px] text-muted">{KIND_LABEL[r.kind]}</span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                  </Link>
                  <Button variant="ghost" size="icon" aria-label={`Access of ${r.name}`} onClick={() => setAccess(r)} data-org-object-access="">
                    <KeyRound className="size-[18px]" />
                  </Button>
                </li>
              );
            })}
          </ul></BoundedBody>
        )}
      </Card>
      {access && <AccessSheet org={org} target={{ type: access.kind, id: access.id }} name={access.name} meId={meId} open={!!access} onClose={() => setAccess(null)} />}
      {canMoveHere(org.myRole) && <MoveDialog open={moving} org={org} onClose={() => setMoving(false)} onMoved={onMoved} />}
    </section>
  );
}

type Step = { kind: 'pick' } | { kind: 'confirm'; row: OrgObjectRow } | { kind: 'consent'; row: OrgObjectRow; credentials: MoveToOrgCredential[] };

function MoveDialog({ open, org, onClose, onMoved }: { open: boolean; org: Org; onClose: () => void; onMoved: () => Promise<void> }) {
  const toast = useToast();
  const [personal, setPersonal] = useState<OrgObjectRow[] | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [keep, setKeep] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep({ kind: 'pick' });
    setKeep([]);
    setError(null);
    setPersonal(null);
    api.orgs.objects('personal').then(
      (o) => setPersonal(objectRows(o)),
      (e) => {
        setPersonal([]);
        setError(orgErrorText(e, 'Couldn’t load your things.'));
      },
    );
  }, [open]);

  const move = async (row: OrgObjectRow, keepCredentials?: string[]) => {
    setBusy(true);
    setError(null);
    const body = { orgId: org.id, ...(keepCredentials ? { keepCredentials } : {}) };
    try {
      if (row.kind === 'workspace') await api.orgs.moveWorkspace(row.id, body);
      else if (row.kind === 'ticket_bucket') await api.orgs.moveBucket(row.id, body);
      else await api.orgs.moveVault(row.id, body);
      toast(`${row.name} moved`);
      onClose();
      await onMoved();
    } catch (e) {
      const credentials = consentCredentials(e);
      if (credentials && !keepCredentials) setStep({ kind: 'consent', row, credentials });
      else setError(orgErrorText(e, 'Couldn’t move it.'));
    } finally {
      setBusy(false);
    }
  };

  const title = step.kind === 'pick' ? 'Move here' : step.kind === 'confirm' ? 'Move?' : 'Credentials';
  const footer =
    step.kind === 'pick' ? undefined : (
      <>
        <Button variant="secondary" onClick={() => setStep({ kind: 'pick' })}>
          Back
        </Button>
        <Button loading={busy} onClick={() => void (step.kind === 'consent' ? move(step.row, keep) : move(step.row))} data-org-move-confirm="">
          Move
        </Button>
      </>
    );

  return (
    <Dialog open={open} onClose={onClose} title={title} stepKey={step.kind} footer={footer}>
      <Alert text={error} />
      {step.kind === 'pick' &&
        (personal === null ? (
          <div className="skeleton h-24 rounded-xl" aria-busy="true" />
        ) : personal.length === 0 ? (
          <p className="text-sm text-muted">Nothing of yours to move.</p>
        ) : (
          <ul data-org-move-list="" className="-mx-2 flex flex-col">
            {personal.map((r) => {
              const Icon = ICON[r.kind];
              return (
                <li key={`${r.kind}:${r.id}`}>
                  <button
                    type="button"
                    onClick={() => setStep({ kind: 'confirm', row: r })}
                    className="press flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Icon className="size-[18px] shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium [overflow-wrap:anywhere]">{r.name}</span>
                      <span className="block text-[12.5px] text-muted">{KIND_LABEL[r.kind]}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ))}
      {step.kind === 'confirm' && (
        <p className="text-sm [overflow-wrap:anywhere]">
          {org.name} will own <span className="font-semibold">{step.row.name}</span>. You keep managing it while you are a member.
        </p>
      )}
      {step.kind === 'consent' && (
        <div data-org-move-consent="" className="flex flex-col gap-2">
          <p className="text-sm [overflow-wrap:anywhere]">
            Credential sets assigned to <span className="font-semibold">{step.row.name}</span>. Ticked ones stay assigned; the rest are removed.
          </p>
          <ul className="flex flex-col">
            {step.credentials.map((c) => (
              <li key={c.poolId}>
                <label className="flex min-h-12 items-center gap-3">
                  <input
                    type="checkbox"
                    className="size-5 accent-accent"
                    checked={keep.includes(c.poolId)}
                    onChange={(e) => setKeep(e.target.checked ? [...keep, c.poolId] : keep.filter((k) => k !== c.poolId))}
                  />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{c.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
