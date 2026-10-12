import type {
  McpBuiltinAdded,
  McpBuiltinAddRequest,
  McpBuiltinAuth,
  McpBuiltinParam,
  McpBuiltinPreviewServer,
  McpBuiltinServer,
  McpBuiltinTemplate,
} from '@portal/contracts';

/**
 * The Add dialog's logic as pure functions (built-in catalogue PRD FR3-FR5, FR10): which servers and params a mode
 * offers, the form it starts from, the request it sends, and where the server's errors belong. The server checks
 * everything again; nothing here is trusted by it.
 */

/** What the Add dialog holds before it becomes a request. */
export interface BuiltinForm {
  auth: McpBuiltinAuth;
  /** Typed values by param key; an empty one means "the default" (the server fills it in). */
  params: Record<string, string>;
  /** The template server keys that are ticked. */
  servers: string[];
  /** Token mode: slot -> a Secrets & env name other than the suggested one. */
  secretNames: Record<string, string>;
  /** The label of a further instance; empty lets the portal choose (none, then 2, 3, ...). */
  name: string;
  /** An explicit tick for servers inside a private network (the SSRF guard refuses them otherwise). */
  allowPrivateNetwork: boolean;
}

/** A server with neither `oauth` nor `token` needs no sign-in and is offered in both modes; one with a single mode is left out of the other (FR3). */
export const supports = (server: McpBuiltinServer, mode: McpBuiltinAuth): boolean =>
  (!server.oauth && !server.token) || (mode === 'oauth' ? !!server.oauth : !!server.token);

export const serversFor = (template: McpBuiltinTemplate, mode: McpBuiltinAuth): McpBuiltinServer[] => template.servers.filter((s) => supports(s, mode));

/** The params a mode asks for; one marked for the other mode is ignored by the server and not shown. */
export const paramsFor = (template: McpBuiltinTemplate, mode: McpBuiltinAuth): McpBuiltinParam[] => template.params.filter((p) => !p.auth || p.auth === mode);

/** The servers ticked when the dialog opens and when the mode changes: the ones marked `default` that the mode offers. */
export const defaultServers = (template: McpBuiltinTemplate, mode: McpBuiltinAuth): string[] =>
  serversFor(template, mode)
    .filter((s) => s.default)
    .map((s) => s.key);

/** The token slots (suggested Secrets & env names) the ticked servers use, once each: servers sharing a slot share one entry. */
export function tokenSlots(template: McpBuiltinTemplate, mode: McpBuiltinAuth, ticked: string[]): string[] {
  if (mode !== 'token') return [];
  const slots: string[] = [];
  for (const s of serversFor(template, mode)) if (ticked.includes(s.key) && s.token && !slots.includes(s.token.slot)) slots.push(s.token.slot);
  return slots;
}

/** The form a dialog opens with: the template's defaults for a new instance, the instance's own values for Update and Edit. */
export function initialForm(template: McpBuiltinTemplate, instance: McpBuiltinAdded | null): BuiltinForm {
  const auth = instance && template.auth.includes(instance.auth) ? instance.auth : (template.auth[0] ?? 'token');
  const params: Record<string, string> = {};
  for (const p of template.params) params[p.key] = instance?.params[p.key] ?? p.default ?? '';
  const offered = serversFor(template, auth).map((s) => s.key);
  const ticked = instance ? instance.servers.filter((k) => offered.includes(k)) : defaultServers(template, auth);
  return {
    auth,
    params,
    servers: ticked.length ? ticked : defaultServers(template, auth),
    secretNames: instance ? { ...instance.secretNames } : {},
    name: '',
    allowPrivateNetwork: instance?.allowPrivateNetwork ?? false,
  };
}

/** The same form in another mode: the typed values stay, the servers go back to that mode's defaults. */
export const withMode = (template: McpBuiltinTemplate, form: BuiltinForm, auth: McpBuiltinAuth): BuiltinForm => ({
  ...form,
  auth,
  servers: defaultServers(template, auth),
});

/** The request preview and Add take. Values the mode doesn't use are left out; an empty param is left out so the server's default applies. */
export function buildRequest(template: McpBuiltinTemplate, form: BuiltinForm, instance: McpBuiltinAdded | null): McpBuiltinAddRequest {
  const params: Record<string, string> = {};
  for (const p of paramsFor(template, form.auth)) {
    const v = (form.params[p.key] ?? '').trim();
    if (v) params[p.key] = v;
  }
  const offered = serversFor(template, form.auth).map((s) => s.key);
  const req: McpBuiltinAddRequest = { auth: form.auth, params, servers: form.servers.filter((k) => offered.includes(k)) };
  const slots = tokenSlots(template, form.auth, req.servers ?? []);
  const names: Record<string, string> = {};
  for (const slot of slots) {
    const n = (form.secretNames[slot] ?? '').trim();
    if (n) names[slot] = n;
  }
  if (Object.keys(names).length) req.secretNames = names;
  if (instance) req.instance = instance.id;
  else if (form.name.trim()) req.name = form.name.trim();
  if (form.allowPrivateNetwork) req.allowPrivateNetwork = true;
  return req;
}

/** Required params of the chosen mode with no value and no default: nothing can be previewed until they are filled. */
export const missingParams = (template: McpBuiltinTemplate, form: BuiltinForm): string[] =>
  paramsFor(template, form.auth)
    .filter((p) => p.required && !(form.params[p.key] ?? '').trim() && !p.default)
    .map((p) => p.key);

/** The server's 422 `details` (keys `auth`, `servers`, `name`, `params.<key>`, `secretNames.<slot>`) as plain maps by area. */
export interface FieldErrors {
  params: Record<string, string>;
  secretNames: Record<string, string>;
  servers?: string;
  name?: string;
  auth?: string;
  /** Messages whose key the dialog has no field for. */
  other: string[];
}

export function fieldErrors(details: unknown): FieldErrors {
  const out: FieldErrors = { params: {}, secretNames: {}, other: [] };
  if (!details || typeof details !== 'object') return out;
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (key.startsWith('params.')) out.params[key.slice(7)] = value;
    else if (key.startsWith('secretNames.')) out.secretNames[key.slice(12)] = value;
    else if (key === 'servers' || key === 'name' || key === 'auth') out[key] = value;
    else out.other.push(value);
  }
  return out;
}

/** The server refused an address because it is private: that is when "Allow private network" is worth showing (FR6). */
export const mentionsPrivateNetwork = (message: string): boolean => /private (address|network)|private network|loopback|link-local/i.test(message);

/** The OAuth fields a preview will pin, as short label/value rows for the details. */
export function oauthRows(server: McpBuiltinPreviewServer): [string, string][] {
  if (server.auth !== 'oauth') return [];
  const o = server.oauth;
  if (!o) return [['Client', 'Registers itself']];
  const rows: [string, string][] = [];
  if (o.clientId) rows.push(['Client ID', o.clientId]);
  else rows.push(['Client', 'Registers itself']);
  if (o.callbackPort) rows.push(['Callback port', String(o.callbackPort)]);
  if (o.scopes?.length) rows.push(['Scopes', o.scopes.join(' ')]);
  if (o.authServerMetadataUrl) rows.push(['Metadata', o.authServerMetadataUrl]);
  return rows;
}

/** What the dialog's primary button says for what the server says Add would do ("Added" when the same inputs are already in). */
export const submitLabel = (action: 'create' | 'update' | 'unchanged' | null, editing: boolean): string =>
  action === 'unchanged' ? (editing ? 'Update' : 'Added') : action === 'update' || editing ? 'Update' : 'Add';
