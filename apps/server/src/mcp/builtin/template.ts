import { createHash } from 'node:crypto';
import { AppError } from '@isnanme/core';
import type { McpBuiltinAuth, McpBuiltinParam, McpBuiltinServer, McpBuiltinTemplate, McpSlotInput } from '@portal/contracts';
import { MCP_SERVER_KEY_MAX } from '@portal/contracts';
import { redact } from '../../chat/redact.js';

/**
 * What a built-in template means, as pure functions (built-in catalogue PRD FR2, FR5): the registry validates every
 * template with them when the server starts, and Add builds the catalog's own inputs with them, so a template that
 * passes one passes the other.
 */

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Characters a URL param never needs: they would reshape the URL a template builds, or end up in a header or a log oddly. */
const URL_REFUSED = /[\s{}$\\"'`<>|^]/;
const TEXT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._~@:+=-]{0,199}$/;
const PARAM_URL_MAX = 300;

export const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
/** A Secrets & env entry name (`{{secret-file:NAME}}`, Secrets & env FR21). */
export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The instance label: part of entry keys and the set's name. */
export const INSTANCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The `{param}` names a text uses, in order. */
export const placeholdersOf = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);

/** Braces that are not a well-formed placeholder: a typo in a template that would reach a URL as it is. */
export const hasStrayBraces = (text: string): boolean => /[{}]/.test(text.replace(PLACEHOLDER, ''));

/**
 * Puts values into a template text. A URL param that ends in `/` loses it where a `/` follows its placeholder, so
 * `{baseUrl}/api` never becomes `https://host//api`.
 */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (match, key: string, offset: number) => {
    const value = values[key] ?? '';
    return text[offset + match.length] === '/' ? value.replace(/\/+$/, '') : value;
  });
}

/**
 * One param's value as it is stored and substituted (FR5): a `url` is an http(s) address with no credentials, query or
 * fragment, an empty path written without the slash; a `text` is a closed alphabet (a client ID). Nothing
 * credential-shaped passes. Throws VALIDATION_FAILED keyed `params.<key>`.
 */
export function paramValue(param: McpBuiltinParam, raw: unknown): string {
  const field = `params.${param.key}`;
  if (typeof raw !== 'string') throw invalid(field, 'Use text.');
  const v = raw.trim();
  if (!v) return '';
  if (CONTROL.test(v)) throw invalid(field, 'Use a single line.');
  if (redact(v) !== v) throw invalid(field, 'This looks like a secret. Values here are not secret: a token is referenced from Secrets & env.');
  if (param.kind === 'text') {
    if (!TEXT_VALUE.test(v)) throw invalid(field, 'Use letters, digits and . _ ~ @ : + = - (at most 200).');
    return v;
  }
  if (v.length > PARAM_URL_MAX) throw invalid(field, `Use at most ${PARAM_URL_MAX} characters.`);
  if (URL_REFUSED.test(v)) throw invalid(field, 'Enter a plain address, like https://git.example.com.');
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw invalid(field, 'Enter a full address, like https://git.example.com.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid(field, 'Use an https address.');
  if (!url.hostname) throw invalid(field, 'Enter a full address, like https://git.example.com.');
  if (url.username || url.password) throw invalid(field, 'Leave out the user and password: a token is referenced from Secrets & env.');
  if (url.search || url.hash) throw invalid(field, 'Leave out the query and the fragment.');
  return url.pathname === '/' ? url.origin : url.href;
}

/** Whether a server is offered in a mode: a server with neither `oauth` nor `token` needs no sign-in and fits both (FR3). */
export function supports(server: McpBuiltinServer, mode: McpBuiltinAuth): boolean {
  if (!server.oauth && !server.token) return true;
  return mode === 'oauth' ? !!server.oauth : !!server.token;
}

/** Whether a param is asked in a mode (`auth` absent: both). */
export const paramApplies = (param: McpBuiltinParam, mode: McpBuiltinAuth): boolean => !param.auth || param.auth === mode;

/**
 * The catalog version spec (`McpVersionSpec` input) for one server in one mode. The catalog's `parseSpec` and the SSRF guard
 * check it; nothing here is trusted to be valid.
 */
export function serverSpec(server: McpBuiltinServer, mode: McpBuiltinAuth, values: Record<string, string>, allowPrivateNetwork: boolean): Record<string, unknown> {
  const spec: Record<string, unknown> = { url: fill(server.url, values), transport: server.transport };
  if (mode === 'oauth' && server.oauth) {
    spec.auth = 'oauth';
    const o: Record<string, unknown> = {};
    const clientId = server.oauth.clientIdParam ? values[server.oauth.clientIdParam] : undefined;
    if (clientId) o.clientId = clientId;
    if (server.oauth.callbackPort) o.callbackPort = server.oauth.callbackPort;
    if (server.oauth.scopes?.length) o.scopes = server.oauth.scopes;
    if (server.oauth.authServerMetadataUrl) o.authServerMetadataUrl = fill(server.oauth.authServerMetadataUrl, values);
    if (Object.keys(o).length) spec.oauth = o;
  } else if (mode === 'token' && server.token) spec.auth = 'headers';
  else spec.auth = 'none';
  if (allowPrivateNetwork) spec.allowPrivateNetwork = true;
  return spec;
}

/** The catalog slots for one server in one mode: the token's header, filled from a Secrets & env file (D4). */
export function serverSlots(server: McpBuiltinServer, mode: McpBuiltinAuth): McpSlotInput[] {
  const token = server.token;
  if (mode !== 'token' || !token) return [];
  const slot: McpSlotInput = { name: token.header, target: 'header', secret: true, required: true, template: token.template ?? 'Bearer {value}' };
  if (token.description) slot.description = token.description;
  if (token.docUrl) slot.docUrl = token.docUrl;
  return [slot];
}

/* ---------- Names ---------- */

/**
 * The catalog entry key for a server of an instance: the server's own key for the first instance, `<key>-<label>` for a
 * labelled one, fitted to the 16 characters a server key may have by cutting and adding four characters of a hash, so the
 * same inputs always give the same key (the catalog's keys are global and immutable).
 */
export function entryKeyFor(serverKey: string, label: string): string {
  if (!label) return serverKey;
  const joined = `${serverKey}-${label}`;
  if (joined.length <= MCP_SERVER_KEY_MAX) return joined;
  const hash = createHash('sha1').update(joined).digest('hex').slice(0, 4);
  return `${joined.slice(0, MCP_SERVER_KEY_MAX - 5).replace(/-+$/, '')}-${hash}`;
}

export const entryNameFor = (server: McpBuiltinServer, label: string): string => (label ? `${server.name} ${label}` : server.name).slice(0, 80);
export const setNameFor = (template: McpBuiltinTemplate, label: string): string => (label ? `${template.name} ${label}` : template.name).slice(0, 60);

/* ---------- Samples (validation at start-up, tests) ---------- */

/** Values for every param in a mode: its default, else a harmless sample of its kind. */
export function sampleValues(template: McpBuiltinTemplate, mode: McpBuiltinAuth): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of template.params) {
    if (!paramApplies(p, mode)) continue;
    out[p.key] = p.default ?? (p.kind === 'url' ? 'https://example.com' : 'sample-client-id');
  }
  return out;
}
