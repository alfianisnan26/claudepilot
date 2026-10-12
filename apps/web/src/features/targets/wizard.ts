import {
  CONNECT_LABEL_MAX,
  CONNECT_TOKEN_TTL_MINUTES,
  connectOriginProblem,
  connectSupport,
  connectTargetIdProblem,
  type ConnectInstallOptions,
  type ConnectKind,
  type ConnectPlatform,
  type ConnectRole,
  type ConnectSupportCell,
  type CreateConnectEnrollmentRequest,
  type CreateConnectTargetRequest,
} from '@portal/contracts';
import { kindsOf } from './kinds';

/** The wizard's whole state before a command exists (step 1). Strings stay strings until `toCreateRequest`. */
export interface WizardForm {
  role: ConnectRole;
  kind: ConnectKind;
  platform: ConnectPlatform;
  id: string;
  portalUrl: string;
  namespace: string;
  storageClass: string;
  nodeName: string;
  ttlMinutes: string;
  sudo: boolean;
  privateCa: boolean;
  hostAccess: boolean;
}

export const DOCKER_KINDS: readonly ConnectKind[] = ['docker', 'swarm', 'container'];
export const isClusterKind = (k: ConnectKind) => k === 'docker' || k === 'swarm' || k === 'kubernetes';

/** The system the browser runs on: where people most often paste. Linux when unsure. */
export function platformFromUserAgent(ua: string): ConnectPlatform {
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad|Android/i.test(ua)) return 'macos';
  return 'linux';
}

export function initialForm(ua: string, portalUrl: string): WizardForm {
  return {
    role: 'cluster',
    kind: 'docker',
    platform: platformFromUserAgent(ua),
    id: '',
    portalUrl,
    namespace: '',
    storageClass: '',
    nodeName: '',
    ttlMinutes: '',
    sudo: false,
    privateCa: false,
    hostAccess: false,
  };
}

/** Switching Cluster/Single keeps the kind when it fits, else the role's first kind. */
export function withRole(form: WizardForm, role: ConnectRole): WizardForm {
  if (form.role === role) return form;
  const kinds = kindsOf(role);
  const kind = (kinds.find((k) => k.kind === form.kind) ?? kinds[0])!.kind as ConnectKind;
  return { ...form, role, kind, hostAccess: false, sudo: false };
}

export function withKind(form: WizardForm, kind: ConnectKind): WizardForm {
  const next = { ...form, kind };
  if (kind !== 'host') next.hostAccess = false;
  if (!DOCKER_KINDS.includes(kind)) next.sudo = false;
  return next;
}

export function withPlatform(form: WizardForm, platform: ConnectPlatform): WizardForm {
  return { ...form, platform, sudo: platform === 'linux' ? form.sudo : false };
}

export const cell = (form: Pick<WizardForm, 'kind' | 'platform'>): ConnectSupportCell => connectSupport(form.kind, form.platform);

/** The matrix's cell for each system, for the segmented control: a `later` one is disabled, a `preview` one is labelled. */
export function platformChoices(kind: ConnectKind): { value: ConnectPlatform; label: string; disabled: boolean; note: string }[] {
  const names: Record<ConnectPlatform, string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };
  return (['linux', 'macos', 'windows'] as const).map((p) => {
    const c = connectSupport(kind, p);
    return { value: p, label: c.support === 'preview' ? `${names[p]} · Preview` : names[p], disabled: c.support === 'later' || c.support === 'no', note: c.note };
  });
}

/** Linux Docker kinds may need the Docker socket as root: only they offer "Run with sudo". */
export const offersSudo = (f: Pick<WizardForm, 'kind' | 'platform'>) => f.platform === 'linux' && DOCKER_KINDS.includes(f.kind);

export const ttlMax = CONNECT_TOKEN_TTL_MINUTES.max;

export interface WizardContext {
  /** Ids of the targets that exist (enrolled and scanned): a name must be new. */
  taken: readonly string[];
  allowHttp: boolean;
}

/** Field problems, one short line each; empty when the form can continue. */
export function formProblems(f: WizardForm, ctx: WizardContext): Partial<Record<'id' | 'portalUrl' | 'ttlMinutes' | 'hostAccess' | 'platform', string>> {
  const out: Partial<Record<'id' | 'portalUrl' | 'ttlMinutes' | 'hostAccess' | 'platform', string>> = {};
  const idProblem = connectTargetIdProblem(f.id);
  if (idProblem) out.id = idProblem;
  else if (ctx.taken.includes(f.id)) out.id = 'That name is in use.';
  const url = f.portalUrl.trim();
  if (url) {
    const p = connectOriginProblem(url, ctx.allowHttp);
    if (p) out.portalUrl = p;
  }
  if (f.ttlMinutes.trim()) {
    const n = Number(f.ttlMinutes);
    if (!Number.isInteger(n) || n < 1 || n > ttlMax) out.ttlMinutes = `1 to ${ttlMax} minutes.`;
  }
  if (f.kind === 'host' && !f.hostAccess) out.hostAccess = 'Confirm to continue.';
  const c = cell(f);
  if (c.support === 'later' || c.support === 'no') out.platform = c.note || 'Not available.';
  return out;
}

/** Whether the address will travel in the clear: the one line the Advanced section shows (the server refuses it unless the operator allowed it). */
export const insecureUrl = (url: string): boolean => /^http:\/\//i.test(url.trim());

export function installOptions(f: WizardForm): ConnectInstallOptions | undefined {
  const o: ConnectInstallOptions = {};
  if (f.kind === 'kubernetes') {
    if (f.namespace.trim()) o.namespace = f.namespace.trim();
    if (f.storageClass.trim()) o.storageClass = f.storageClass.trim();
  }
  if (f.kind !== 'kubernetes' && f.nodeName.trim()) o.nodeName = f.nodeName.trim();
  if (offersSudo(f) && f.sudo) o.sudo = true;
  if (f.kind === 'host' && f.hostAccess) o.hostAccess = true;
  if (f.privateCa) o.privateCa = true;
  return Object.keys(o).length ? o : undefined;
}

export function toCreateRequest(f: WizardForm): CreateConnectTargetRequest {
  const req: CreateConnectTargetRequest = { kind: f.kind, platform: f.platform, id: f.id.trim() };
  if (f.portalUrl.trim()) req.portalUrl = f.portalUrl.trim().replace(/\/+$/, '');
  const options = installOptions(f);
  if (options) req.options = options;
  if (f.ttlMinutes.trim()) req.ttlMinutes = Number(f.ttlMinutes);
  return req;
}

/** "Add node" / "New command": the same options for another token of an existing target. */
export function toEnrollmentRequest(f: Pick<WizardForm, 'platform'> & Partial<WizardForm>): CreateConnectEnrollmentRequest {
  const full = { kind: 'docker', ...f } as WizardForm;
  const req: CreateConnectEnrollmentRequest = { platform: f.platform };
  const options = installOptions({ ...({ namespace: '', storageClass: '', nodeName: '', sudo: false, privateCa: false, hostAccess: false } as WizardForm), ...full });
  if (options) req.options = options;
  if (f.ttlMinutes?.trim()) req.ttlMinutes = Number(f.ttlMinutes);
  return req;
}

/** A target id from what a person types in the name field: lowercase, spaces and underscores become dashes. */
export const idFromInput = (s: string): string => s.toLowerCase().replace(/[\s_]+/g, '-');

export const LABEL_MAX = CONNECT_LABEL_MAX;

/** "Add node" is offered for Docker and Swarm, once the first node is in. */
export const canAddNode = (kind: ConnectKind) => kind === 'docker' || kind === 'swarm';

/** What closes a wizard: leaving before a node connected leaves a pending row (Cancel removes it). */
export type Step = 'form' | 'command';
