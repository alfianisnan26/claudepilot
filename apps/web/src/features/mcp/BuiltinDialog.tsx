import { Button, cn, CopyButton, Dialog, DiscardDialog, Segmented, Spinner, Switch, TextField } from '@isnanme/ui';
import type { McpBuiltinAdded, McpBuiltinAddResult, McpBuiltinPreview, McpBuiltinPreviewServer, McpBuiltinServer, McpBuiltinTemplate, McpRiskFlag } from '@portal/contracts';
import { MCP_BUILTIN_NAME_MAX } from '@portal/contracts';
import { Check, ChevronRight, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { ApiError, errorText } from '@/lib/api';
import { forbiddenReason } from './access';
import { mcpApi } from './api';
import {
  buildRequest,
  fieldErrors,
  initialForm,
  mentionsPrivateNetwork,
  missingParams,
  oauthRows,
  paramsFor,
  serversFor,
  submitLabel,
  tokenSlots,
  withMode,
  type BuiltinForm,
  type FieldErrors,
} from './builtin';
import { NotesTip } from './BuiltinNotes';
import { AUTH_MODE } from './labels';
import { MONO } from './parts';

/** What the dialog is for: a new instance of a template, or a change to (Update, Edit) an instance it already has. */
export interface BuiltinTarget {
  template: McpBuiltinTemplate;
  instance: McpBuiltinAdded | null;
  /** How many instances the template has: a further one may need a name of its own. */
  existing: number;
}

const NO_ERRORS: FieldErrors = { params: {}, secretNames: {}, other: [] };
const SECRETS_HREF = '/admin/pools?tab=secrets';

/**
 * The Add dialog of a built-in template (built-in catalogue PRD FR3-FR5, FR16): the sign-in method, the few non-secret
 * values, the servers to include, and, from the server's own preview, the exact URL each will use. Add is the consent to
 * what the preview shows, so its button waits for a preview of exactly this form. After Add it offers "Assign".
 *
 * `target` is held in state by the caller while the dialog is open. The last one is kept after it closes, so the dialog
 * can animate out with its content; a new target starts a fresh form.
 */
export function BuiltinDialog({
  target,
  onClose,
  onChanged,
  onAssign,
  onBlocked,
}: {
  target: BuiltinTarget | null;
  onClose: () => void;
  /** Something was added or changed: the shelf and the catalog load again. */
  onChanged: () => void;
  /** "Assign" after Add: the caller closes this and opens the assign dialog for the set. */
  onAssign: (poolId: string) => void;
  /** The portal refused (403): the person may not add built-in servers. The caller shows its Add actions off, with this reason. */
  onBlocked: (reason: string) => void;
}) {
  const [held, setHeld] = useState<{ target: BuiltinTarget; serial: number } | null>(null);
  if (target && target !== held?.target) setHeld({ target, serial: (held?.serial ?? 0) + 1 });
  if (!held) return null;
  return <AddDialog key={held.serial} target={held.target} open={!!target} onClose={onClose} onChanged={onChanged} onAssign={onAssign} onBlocked={onBlocked} />;
}

function AddDialog({
  target,
  open,
  onClose,
  onChanged,
  onAssign,
  onBlocked,
}: {
  target: BuiltinTarget;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  onAssign: (poolId: string) => void;
  onBlocked: (reason: string) => void;
}) {
  const { template, instance } = target;
  const formId = useId();
  const [form, setForm] = useState<BuiltinForm>(() => initialForm(template, instance));
  const [initial] = useState(() => JSON.stringify(initialForm(template, instance)));
  const [preview, setPreview] = useState<{ key: string; value: McpBuiltinPreview } | null>(null);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>(NO_ERRORS);
  const [notice, setNotice] = useState<string | null>(null);
  // The portal said this person may not add built-in servers (403): the button stays off, with the reason on top.
  const [blocked, setBlocked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<McpBuiltinAddResult | null>(null);
  const [details, setDetails] = useState(false);
  // "Allow private network" is shown once the server has said an address is private (or when it is already on).
  const [seenPrivate, setSeenPrivate] = useState(false);
  const [asking, setAsking] = useState(false);
  // Bumped when the window regains focus, so a secret added in another tab shows as found.
  const [focusTick, setFocusTick] = useState(0);
  const latest = useRef(0);

  const request = buildRequest(template, form, instance);
  const requestKey = JSON.stringify(request);
  const waiting = missingParams(template, form).length > 0;

  useEffect(() => {
    if (!open) return;
    const bump = () => setFocusTick((n) => n + 1);
    window.addEventListener('focus', bump);
    return () => window.removeEventListener('focus', bump);
  }, [open]);

  /** Sorts a refusal into the fields it belongs to, and into a banner when no field can carry it. */
  const explain = (e: unknown) => {
    const refused = forbiddenReason(e);
    if (refused) {
      setBlocked(refused);
      setErrors(NO_ERRORS);
      onBlocked(refused);
      return;
    }
    if (e instanceof ApiError && e.details && typeof e.details === 'object') {
      const f = fieldErrors(e.details);
      setErrors(f);
      const messages = [...Object.values(f.params), ...Object.values(f.secretNames), ...f.other, f.servers, f.name, f.auth].filter((m): m is string => !!m);
      if (messages.some(mentionsPrivateNetwork)) setSeenPrivate(true);
      const carried = Object.keys(f.params).length > 0 || Object.keys(f.secretNames).length > 0 || !!f.servers || f.other.length > 0;
      // A name conflict is carried by the Name field, but its message says what to do.
      setNotice(carried && e.status === 422 ? null : e.message);
    } else {
      setErrors(NO_ERRORS);
      setNotice(errorText(e, 'Could not check it.'));
    }
  };

  // The server's own preview of exactly this form, a moment after the last change.
  useEffect(() => {
    if (!open || done || blocked) {
      latest.current++;
      return;
    }
    if (waiting) {
      latest.current++;
      setPreview(null);
      setPending(false);
      setErrors(NO_ERRORS);
      setNotice(null);
      return;
    }
    const mine = ++latest.current;
    setPending(true);
    const timer = window.setTimeout(() => {
      mcpApi.builtinPreview(template.id, request).then(
        (value) => {
          if (mine !== latest.current) return;
          setPreview({ key: requestKey, value });
          setErrors(NO_ERRORS);
          setNotice(null);
          setPending(false);
        },
        (e: unknown) => {
          if (mine !== latest.current) return;
          setPreview(null);
          explain(e);
          setPending(false);
        },
      );
    }, 450);
    return () => window.clearTimeout(timer);
    // `request` is derived from `requestKey`, and `explain` only sets state.
  }, [open, template.id, requestKey, waiting, done, blocked, focusTick]);

  const change = (patch: Partial<BuiltinForm>) => setForm((f) => ({ ...f, ...patch }));
  // A field's refusal goes as soon as it is edited, not when the next preview comes back.
  const clearError = (area: 'params' | 'secretNames', key: string) =>
    setErrors((e) => {
      const { [key]: _gone, ...rest } = e[area];
      return { ...e, [area]: rest };
    });
  // What the preview showed for this very form, or, while a new one is on its way, the last one (dimmed).
  const shown = preview && preview.key === requestKey ? preview.value : null;
  const current = shown ?? preview?.value ?? null;
  const canSubmit = !!shown && !blocked && shown.action !== 'unchanged' && !saving && form.servers.length > 0;
  const dirty = JSON.stringify(form) !== initial && !done;
  const close = () => (dirty && !saving ? setAsking(true) : onClose());

  const offered = serversFor(template, form.auth);
  const several = offered.length > 1;
  const params = paramsFor(template, form.auth);
  const showName = !instance && (target.existing > 0 || !!errors.name);
  const showPrivate = form.allowPrivateNetwork || seenPrivate;
  const plannedByKey = new Map((current?.servers ?? []).map((s) => [s.key, s]));
  const secretRows = tokenSlots(template, form.auth, form.servers);
  const missingSecrets = current?.secretNames.filter((s) => !s.exists) ?? [];

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await mcpApi.builtinAdd(template.id, request);
      setDone(result);
      onChanged();
    } catch (e) {
      explain(e);
    } finally {
      setSaving(false);
    }
  };

  const title = done ? (
    done.result === 'created' ? 'Added' : done.result === 'updated' ? 'Updated' : 'Up to date'
  ) : (
    <span className="inline-flex items-center gap-1">
      {instance ? (instance.updateAvailable ? 'Update' : 'Edit') : 'Add'} {instance ? instance.poolName : template.name}
      <NotesTip template={template} />
    </span>
  );

  return (
    <>
      <Dialog
        open={open}
        onClose={done ? onClose : close}
        title={title}
        stepKey={done ? 'done' : 'form'}
        footer={
          done ? (
            <>
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
              <Button onClick={() => onAssign(done.poolId)}>Assign…</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={close} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" form={formId} loading={saving} disabled={!canSubmit}>
                {submitLabel(shown?.action ?? null, !!instance)}
              </Button>
            </>
          )
        }
      >
        {done ? (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2.5 text-[15px] font-semibold">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                <Check className="size-4" strokeWidth={2.75} />
              </span>
              <span className="min-w-0 truncate">{done.poolName}</span>
              {done.auth === 'oauth' && <InfoTip label="About signing in">After you assign it, sign in once in each workspace: its Configuration shows “Needs sign-in”.</InfoTip>}
            </p>
            {missingSecrets.length > 0 && (
              <p className="flex items-start gap-2 rounded-xl bg-flame-soft px-3 py-2 text-[13px] text-ink-soft">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  Not in Secrets & env yet:{' '}
                  <span className="text-[12px]" style={{ fontFamily: MONO }}>
                    {missingSecrets.map((s) => s.name).join(', ')}
                  </span>
                  .{' '}
                  <a href={SECRETS_HREF} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent hover:underline">
                    Open
                  </a>
                </span>
              </p>
            )}
          </div>
        ) : (
          <form
            id={formId}
            noValidate
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {(blocked ?? notice) && (
              <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
                {blocked ?? notice}
              </p>
            )}

            {template.auth.length > 1 && (
              <Segmented label="Sign-in" value={form.auth} onChange={(a) => setForm((f) => withMode(template, f, a))} options={template.auth.map((a) => ({ value: a, label: AUTH_MODE[a] }))} />
            )}

            {params.map((p, i) => (
              <TextField
                key={p.key}
                label={p.label}
                optional={!p.required}
                value={form.params[p.key] ?? ''}
                placeholder={p.placeholder}
                onChange={(e) => (change({ params: { ...form.params, [p.key]: e.target.value } }), clearError('params', p.key))}
                error={errors.params[p.key]}
                inputMode={p.kind === 'url' ? 'url' : undefined}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                suffix={p.hint ? <InfoTip label={`About ${p.label}`}>{p.hint}</InfoTip> : undefined}
                data-autofocus={i === 0 ? true : undefined}
              />
            ))}

            {showName && (
              <TextField
                label="Name"
                optional
                value={form.name}
                placeholder="2"
                maxLength={MCP_BUILTIN_NAME_MAX}
                onChange={(e) => (change({ name: e.target.value.toLowerCase().replace(/\s+/g, '-') }), setErrors((x) => ({ ...x, name: undefined })))}
                error={errors.name}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                suffix={<InfoTip label="About the name">Tells this one from the others: it becomes part of the set’s name and the server keys. Lowercase letters, digits and dashes. Empty: the portal numbers it.</InfoTip>}
              />
            )}

            {several ? (
              <fieldset className="flex flex-col">
                <legend className="mb-1 text-[13px] font-semibold text-ink-soft">Servers</legend>
                {offered.map((s) => (
                  <ServerRow
                    key={s.key}
                    server={s}
                    on={form.servers.includes(s.key)}
                    planned={plannedByKey.get(s.key)}
                    dim={!shown}
                    onChange={(on) => change({ servers: offered.filter((o) => (o.key === s.key ? on : form.servers.includes(o.key))).map((o) => o.key) })}
                  />
                ))}
                {errors.servers && <p className="text-[13px] font-medium text-danger">{errors.servers}</p>}
              </fieldset>
            ) : (
              <UrlBlock planned={current?.servers[0]} pending={pending} dim={!shown} />
            )}

            {form.auth === 'token' &&
              secretRows.map((slot) => {
                const row = current?.secretNames.find((s) => s.slot === slot);
                return (
                  <TextField
                    key={slot}
                    label={secretRows.length > 1 ? slot : 'Secret'}
                    value={form.secretNames[slot] ?? row?.name ?? slot}
                    onChange={(e) => (change({ secretNames: { ...form.secretNames, [slot]: e.target.value } }), clearError('secretNames', slot))}
                    error={errors.secretNames[slot]}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="[&_input]:font-mono"
                    suffix={<InfoTip label="About the secret">The name of a secret in Secrets & env that holds the token. The token itself is never typed here.</InfoTip>}
                    hint={
                      row && shown ? (
                        row.exists ? (
                          <span className="inline-flex items-center gap-1 text-accent">
                            <Check className="size-3.5" strokeWidth={2.75} /> In Secrets & env
                          </span>
                        ) : (
                          <span className="text-amber-700 dark:text-amber-400">
                            Not in Secrets & env yet.{' '}
                            <a href={SECRETS_HREF} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                              Open
                            </a>
                          </span>
                        )
                      ) : undefined
                    }
                  />
                );
              })}

            {showPrivate && (
              <div className="flex min-h-11 items-center gap-2">
                <span id={`${formId}-private`} className="text-[15px] font-semibold text-ink">
                  Allow private network
                </span>
                <InfoTip label="About the private network">For servers inside your own network. Off: the portal refuses private, loopback and link-local addresses.</InfoTip>
                <span className="flex-1" />
                <Switch checked={form.allowPrivateNetwork} onChange={(v) => change({ allowPrivateNetwork: v })} labelledBy={`${formId}-private`} />
              </div>
            )}

            {shown && shown.servers.length > 0 && (
              <div className="-mt-2">
                <button
                  type="button"
                  aria-expanded={details}
                  onClick={() => setDetails((d) => !d)}
                  className="inline-flex min-h-8 items-center gap-1 rounded-lg text-[13px] font-semibold text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <ChevronRight className={cn('size-4 transition-transform', details && 'rotate-90')} />
                  Details
                </button>
                {details && <Details servers={shown.servers} />}
              </div>
            )}
            {/* Enter in a single-field form submits even without a visible submit button inside. */}
            <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
          </form>
        )}
      </Dialog>
      <DiscardDialog
        open={asking}
        onKeep={() => setAsking(false)}
        onDiscard={() => {
          setAsking(false);
          onClose();
        }}
      />
    </>
  );
}

/** The exact URL a workspace will connect to, in one copyable line, with the catalog's risk flags under it. */
function UrlBlock({ planned, pending, dim }: { planned?: McpBuiltinPreviewServer; pending: boolean; dim: boolean }) {
  if (!planned) {
    return pending ? (
      <p className="flex items-center gap-2 text-[13px] text-muted" aria-busy="true">
        <Spinner className="size-3.5" /> Checking…
      </p>
    ) : null;
  }
  return (
    <div className={cn('flex flex-col gap-1.5 transition-opacity', dim && 'opacity-60')}>
      <span className="text-[13px] font-semibold text-ink-soft">URL</span>
      <UrlLine url={planned.url} />
      <Flags flags={planned.flags} />
    </div>
  );
}

function UrlLine({ url }: { url: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-line bg-surface-2/60 py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 py-1 text-[12.5px] leading-relaxed break-all" style={{ fontFamily: MONO }}>
        {url}
      </code>
      <CopyButton value={url} label="Copy URL" showLabel={false} />
    </div>
  );
}

function Flags({ flags }: { flags: McpRiskFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {flags.map((f) => (
        <li key={f.code} className="flex items-start gap-1.5 text-[12.5px] text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {f.label}
        </li>
      ))}
    </ul>
  );
}

/** One server of a multi-server template: a switch, its name with the note behind an ⓘ, and its exact URL while it is on. */
function ServerRow({ server, on, planned, dim, onChange }: { server: McpBuiltinServer; on: boolean; planned?: McpBuiltinPreviewServer; dim: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <div
      className="flex min-h-12 cursor-pointer items-start gap-3 py-2"
      onClick={(e) => {
        // The switch and the ⓘ handle their own clicks; anywhere else on the row toggles it.
        if ((e.target as HTMLElement).closest('[role="switch"],button,a')) return;
        onChange(!on);
      }}
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1">
          <span id={id} className="text-[15px] font-semibold text-ink">
            {server.name}
          </span>
          <InfoTip label={`About ${server.name}`}>{server.description}</InfoTip>
        </p>
        {on && planned && (
          <div className={cn('mt-0.5 flex flex-col gap-0.5 transition-opacity', dim && 'opacity-60')}>
            <code className="text-[12px] leading-snug break-all text-muted" style={{ fontFamily: MONO }}>
              {planned.url}
            </code>
            <Flags flags={planned.flags} />
          </div>
        )}
      </div>
      <Switch checked={on} onChange={onChange} labelledBy={id} />
    </div>
  );
}

/** What Add will write (PRD FR3): how it signs in, header names, and the OAuth fields it pins. */
function Details({ servers }: { servers: McpBuiltinPreviewServer[] }) {
  return (
    <div className="mt-1 flex flex-col gap-3 rounded-xl bg-surface-2/60 px-3.5 py-3 text-[12.5px]">
      {servers.map((s) => (
        <dl key={s.key} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {servers.length > 1 && <dt className="col-span-2 font-semibold text-ink">{s.name}</dt>}
          <Row label="Sign-in" value={s.auth === 'oauth' ? 'OAuth' : s.auth === 'headers' ? 'Token' : 'None'} />
          {s.headers.length > 0 && <Row label="Header" value={s.headers.join(', ')} mono />}
          {oauthRows(s).map(([k, v]) => (
            <Row key={k} label={k} value={v} mono={k !== 'Client'} />
          ))}
        </dl>
      ))}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink-soft [overflow-wrap:anywhere]" style={mono ? { fontFamily: MONO } : undefined}>
        {value}
      </dd>
    </>
  );
}
