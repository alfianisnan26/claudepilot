import { isAppError } from '@isnanme/core';
import type { McpBuiltinAuth, McpBuiltinParam, McpBuiltinServer, McpBuiltinTemplate } from '@portal/contracts';
import { MCP_BUILTIN_IDS } from '@portal/contracts';
import { parseSlots, parseSpec, serverKeyProblem } from '../spec.js';
import { hasStrayBraces, paramApplies, paramValue, placeholdersOf, sampleValues, SECRET_NAME, serverSlots, serverSpec, supports } from './template.js';

/**
 * The built-in templates (built-in catalogue PRD FR1, FR2): code-defined, in this repository, each checked when the
 * server starts. A template that breaks a rule stops the start and names the problem, so a mistake is caught in
 * tests and never shown to an admin. The templates themselves live in `providers/` (MCP providers PRD).
 */

const MODES: readonly McpBuiltinAuth[] = ['oauth', 'token'];
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const words = (text: string) => text.trim().split(/\s+/).length;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const httpsUrl = (v: unknown): boolean => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
};
const messageOf = (e: unknown): string => (isAppError(e) ? e.message : e instanceof Error ? e.message : String(e));

/** Every rule a template must meet, as a list of problems (empty when it is fine). */
export function validateTemplate(t: McpBuiltinTemplate): string[] {
  const problems: string[] = [];
  const bad = (message: string) => void problems.push(message);

  if (!(MCP_BUILTIN_IDS as readonly string[]).includes(t.id)) bad(`id “${String(t.id)}” is not one of ${MCP_BUILTIN_IDS.join(', ')}`);
  if (t.icon !== t.id) bad('icon must equal id: the web draws one inline SVG per id');
  if (!text(t.name, 40)) bad('name must be 1 to 40 characters');
  if (!text(t.summary, 160)) bad('summary must be one short line (at most 160 characters)');
  if (!httpsUrl(t.docUrl) || String(t.docUrl).length > 300) bad('docUrl must be an https URL');
  if (!Number.isInteger(t.version) || t.version < 1) bad('version must be an integer of 1 or more');
  if (!DATE.test(String(t.checkedAt)) || Number.isNaN(Date.parse(`${t.checkedAt}T00:00:00Z`))) bad('checkedAt must be a date, YYYY-MM-DD');
  if (!Array.isArray(t.notes) || t.notes.length > 10 || t.notes.some((n) => !text(n, 400))) bad('notes are at most 10 lines of at most 400 characters');
  if (!Array.isArray(t.auth) || !t.auth.length || new Set(t.auth).size !== t.auth.length || t.auth.some((a) => !MODES.includes(a))) bad('auth lists oauth and/or token, each once, in preference order');
  if (!Array.isArray(t.params) || !Array.isArray(t.servers) || !t.servers.length) {
    bad('params and servers must be lists, with at least one server');
    return problems;
  }
  const modes = (Array.isArray(t.auth) ? t.auth : []).filter((a) => MODES.includes(a));

  const params = new Map<string, McpBuiltinParam>();
  for (const p of t.params) {
    const at = `param ${String(p.key)}`;
    if (!PARAM_KEY.test(String(p.key))) bad(`${at}: key is letters and digits, starting with a letter`);
    if (params.has(p.key)) bad(`${at}: listed twice`);
    params.set(p.key, p);
    if (!text(p.label, 30) || words(p.label) > 3) bad(`${at}: label is one or two words`);
    if (p.hint !== undefined && !text(p.hint, 300)) bad(`${at}: hint is at most 300 characters`);
    if (p.kind !== 'url' && p.kind !== 'text') bad(`${at}: kind is url or text`);
    if (typeof p.required !== 'boolean') bad(`${at}: required is true or false`);
    if (p.auth !== undefined && !modes.includes(p.auth)) bad(`${at}: auth ${String(p.auth)} is not a mode the template offers`);
    if (p.placeholder !== undefined && !text(p.placeholder, 100)) bad(`${at}: placeholder is at most 100 characters`);
    if (p.default !== undefined) {
      try {
        if (!paramValue(p, p.default)) bad(`${at}: default is empty`);
      } catch (e) {
        bad(`${at}: default is not a valid ${p.kind}: ${messageOf(e)}`);
      }
    }
  }

  const used = new Set<string>();
  const keys = new Set<string>();
  for (const s of t.servers) {
    const at = `server ${String(s.key)}`;
    const keyProblem = serverKeyProblem(String(s.key));
    if (keyProblem) bad(`${at}: ${keyProblem}`);
    if (keys.has(s.key)) bad(`${at}: listed twice`);
    keys.add(s.key);
    if (!text(s.name, 40)) bad(`${at}: name must be 1 to 40 characters`);
    if (!text(s.description, 200)) bad(`${at}: description must be one short line (at most 200 characters)`);
    if (s.transport !== 'http' && s.transport !== 'sse') bad(`${at}: transport is http or sse`);
    if (typeof s.default !== 'boolean') bad(`${at}: default is true or false`);
    if (typeof s.url !== 'string' || hasStrayBraces(s.url)) bad(`${at}: url has a brace that is not a {param} placeholder`);
    // A template never ships plain http: where the scheme comes from a param, the admin chose it (and the review flags it).
    if (typeof s.url === 'string' && /^http:/i.test(s.url)) bad(`${at}: url must be https`);
    const holders = [...placeholdersOf(String(s.url)), ...placeholdersOf(String(s.oauth?.authServerMetadataUrl ?? ''))];
    for (const key of holders) {
      used.add(key);
      if (!params.has(key)) bad(`${at}: {${key}} is not a declared param`);
    }
    if (s.oauth) {
      const o = s.oauth;
      if (typeof o.dcr !== 'boolean') bad(`${at}: oauth.dcr is true or false`);
      if (!o.dcr && !o.clientIdParam) bad(`${at}: without dynamic client registration, oauth needs clientIdParam`);
      if (o.clientIdParam !== undefined) {
        used.add(o.clientIdParam);
        const p = params.get(o.clientIdParam);
        if (!p) bad(`${at}: clientIdParam ${o.clientIdParam} is not a declared param`);
        else {
          if (p.kind !== 'text') bad(`${at}: clientIdParam ${o.clientIdParam} must be a text param`);
          if (p.auth !== 'oauth') bad(`${at}: clientIdParam ${o.clientIdParam} must have auth "oauth": a client ID is asked only for OAuth`);
          if (!o.dcr && !p.required) bad(`${at}: clientIdParam ${o.clientIdParam} must be required: there is no dynamic registration to fall back on`);
        }
      }
      if (o.callbackPort !== undefined && (!Number.isInteger(o.callbackPort) || o.callbackPort < 1024 || o.callbackPort > 65535)) bad(`${at}: oauth.callbackPort is 1024 to 65535`);
      if (o.scopes !== undefined && (!Array.isArray(o.scopes) || o.scopes.some((x) => !/^[\x21-\x7e]{1,200}$/.test(x)))) bad(`${at}: oauth.scopes are words without spaces`);
      if (o.authServerMetadataUrl !== undefined && hasStrayBraces(o.authServerMetadataUrl)) bad(`${at}: authServerMetadataUrl has a brace that is not a {param} placeholder`);
      // Claude Code rejects a plain-http metadata URL when it loads the config (and the server goes missing): https, after the params are in.
      if (o.authServerMetadataUrl !== undefined && /^http:/i.test(o.authServerMetadataUrl)) bad(`${at}: authServerMetadataUrl must be https`);
      if (!t.auth.includes('oauth')) bad(`${at}: offers OAuth but the template's auth does not list oauth`);
    }
    if (s.token) {
      const k = s.token;
      if (!SECRET_NAME.test(String(k.slot))) bad(`${at}: token.slot is a Secrets & env name: letters, digits, . _ - (at most 64)`);
      if (!t.auth.includes('token')) bad(`${at}: offers a token but the template's auth does not list token`);
    }
    // What the catalog itself would make of it, in every mode the server is offered in.
    for (const mode of modes) {
      if (!supports(s, mode)) continue;
      try {
        const values = sampleValues(t, mode);
        const spec = parseSpec('remote', serverSpec(s, mode, values, false));
        parseSlots('remote', serverSlots(s, mode), spec);
      } catch (e) {
        bad(`${at} in ${mode} mode: ${messageOf(e)}`);
      }
    }
  }
  for (const key of params.keys()) if (!used.has(key)) bad(`param ${key}: no server uses it`);

  for (const mode of modes) {
    const offered = t.servers.filter((s) => supports(s, mode));
    if (!offered.length) bad(`auth lists ${mode} but no server offers it`);
    else if (!offered.some((s) => s.default)) bad(`no server is on by default in ${mode} mode`);
  }
  return problems;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** The validated templates, in the order their list gives. Throws, naming every problem, when one breaks a rule. */
export class BuiltinRegistry {
  readonly #templates: readonly McpBuiltinTemplate[];

  constructor(templates: readonly McpBuiltinTemplate[]) {
    const problems = templates.flatMap((t) => validateTemplate(t).map((p) => `built-in template ${String(t.id)}: ${p}`));
    const seen = new Set<string>();
    for (const t of templates) {
      if (seen.has(t.id)) problems.push(`built-in template ${String(t.id)}: listed twice`);
      seen.add(t.id);
    }
    if (problems.length) throw new Error(`The built-in MCP catalogue has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n- ${problems.join('\n- ')}`);
    this.#templates = deepFreeze(templates.map((t) => structuredClone(t)));
  }

  list(): readonly McpBuiltinTemplate[] {
    return this.#templates;
  }

  get(id: string): McpBuiltinTemplate | undefined {
    return this.#templates.find((t) => t.id === id);
  }
}

/** Servers of a template that a mode offers, in the template's order. */
export const serversFor = (t: McpBuiltinTemplate, mode: McpBuiltinAuth): McpBuiltinServer[] => t.servers.filter((s) => supports(s, mode));

/** Params a mode asks for, in the template's order. */
export const paramsFor = (t: McpBuiltinTemplate, mode: McpBuiltinAuth): McpBuiltinParam[] => t.params.filter((p) => paramApplies(p, mode));
