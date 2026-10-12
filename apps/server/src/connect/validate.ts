// Checks on what an admin sends when making a target or a token (docs/prd/targets-connect.md §10.2, §15): kinds and the matrix, the id, the label,
// the install options, lifetimes and uses. Each returns the cleaned value or throws a 422 whose `details` names the fields, as every other route does.
// What passes here is what the plan text and the manifest carry (`[A-Za-z0-9._:/@,+=-]` values), so the patterns are narrower than a name could be.

import { AppError } from '@isnanme/core';
import {
  CONNECT_KINDS,
  CONNECT_LABEL_MAX,
  CONNECT_PLATFORMS,
  CONNECT_ROLE,
  CONNECT_TOKEN_TTL_MINUTES,
  CONNECT_TOKEN_USES_MAX,
  connectSupport,
  connectTargetIdProblem,
  type ConnectInstallOptions,
  type ConnectKind,
  type ConnectPlatform,
  type ConnectTargetSettings,
} from '@portal/contracts';
import { cleanText, looksLikeSecret } from '../portalmcp/sanitize.js';

/** Where a Kubernetes target's connector and workspaces live unless the wizard says otherwise (what the portal's own Kubernetes target uses). */
export const DEFAULT_NAMESPACE = 'claudepilot-workspaces';
export const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
export const STORAGE_CLASS = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
export const STORAGE = /^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|K|M|G|T|P|E)?$/;
export const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
export const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export const invalid = (details: Record<string, string>, message = 'Some fields can’t be used.'): AppError => new AppError('VALIDATION_FAILED', message, { details });

export const isKind = (v: unknown): v is ConnectKind => (CONNECT_KINDS as readonly unknown[]).includes(v);
export const isPlatform = (v: unknown): v is ConnectPlatform => (CONNECT_PLATFORMS as readonly unknown[]).includes(v);

/** The kind and platform of a request, and that the matrix offers that cell. */
export function checkCell(kind: unknown, platform: unknown): { kind: ConnectKind; platform: ConnectPlatform } {
  const details: Record<string, string> = {};
  if (!isKind(kind)) details.kind = `One of ${CONNECT_KINDS.join(', ')}.`;
  if (!isPlatform(platform)) details.platform = `One of ${CONNECT_PLATFORMS.join(', ')}.`;
  if (Object.keys(details).length) throw invalid(details);
  const cell = connectSupport(kind as ConnectKind, platform as ConnectPlatform);
  if (cell.support === 'later' || cell.support === 'no') throw invalid({ platform: cell.note || 'Not available yet.' });
  return { kind: kind as ConnectKind, platform: platform as ConnectPlatform };
}

/** The target's id: a plain name that is not reserved, scanned or taken (the caller says which ids are scanned). */
export function checkId(id: unknown, scanned: readonly string[]): string {
  if (typeof id !== 'string') throw invalid({ id: 'Give it a name.' });
  const problem = connectTargetIdProblem(id);
  if (problem) throw invalid({ id: problem });
  if (scanned.includes(id)) throw new AppError('CONFLICT', 'That name is taken by a built-in target.', { details: { id: 'That name is taken by a built-in target.' } });
  return id;
}

export function checkLabel(label: unknown, fallback: string): string {
  if (label === undefined || label === null || label === '') return fallback;
  if (typeof label !== 'string') throw invalid({ label: 'Text, 1 to 40 characters.' });
  const clean = cleanText(label, 200).replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > CONNECT_LABEL_MAX) throw invalid({ label: `Text, 1 to ${CONNECT_LABEL_MAX} characters.` });
  return clean;
}

type OptionKey = keyof ConnectInstallOptions;

/** Which options mean something for which kind; the others are dropped, not refused (a wizard may send its whole form). */
const OPTIONS_OF: Record<ConnectKind, OptionKey[]> = {
  docker: ['workspaceImage', 'nodeName', 'sudo', 'privateCa'],
  swarm: ['workspaceImage', 'nodeName', 'sudo', 'privateCa'],
  kubernetes: ['namespace', 'storageClass', 'storage', 'privateCa'],
  container: ['workspaceImage', 'sudo', 'privateCa'],
  host: ['nodeName', 'hostAccess', 'privateCa'],
};

export function checkOptions(kind: ConnectKind, platform: ConnectPlatform, raw: unknown, caConfigured: boolean): ConnectInstallOptions {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid({ options: 'An object.' });
  const src = raw as Record<string, unknown>;
  const out: ConnectInstallOptions = {};
  const details: Record<string, string> = {};
  const text = (key: OptionKey, pattern: RegExp, hint: string) => {
    const v = src[key];
    if (v === undefined || v === null || v === '') return;
    // a value shaped like a credential is never kept: it would be shown in the wizard and written into the plan
    if (typeof v !== 'string' || !pattern.test(v) || looksLikeSecret(v)) details[key] = hint;
    else (out as Record<string, unknown>)[key] = v;
  };
  const flag = (key: OptionKey) => {
    const v = src[key];
    if (v === undefined || v === null) return;
    if (typeof v !== 'boolean') details[key] = 'true or false.';
    else (out as Record<string, unknown>)[key] = v;
  };
  for (const key of OPTIONS_OF[kind]) {
    if (key === 'namespace') text(key, NAMESPACE, 'A Kubernetes name: lowercase letters, digits and dashes.');
    else if (key === 'storageClass') text(key, STORAGE_CLASS, 'A storage class name.');
    else if (key === 'storage') text(key, STORAGE, 'A size such as 10Gi.');
    else if (key === 'workspaceImage') text(key, IMAGE_REF, 'An image reference such as registry/name:tag.');
    else if (key === 'nodeName') text(key, NODE_NAME, 'Letters, digits, dots, dashes and underscores.');
    else flag(key);
  }
  if (out.sudo && platform !== 'linux') delete out.sudo; // only a Linux command starts with sudo
  if (out.privateCa && !caConfigured) details.privateCa = 'No private CA is configured on the portal (PORTAL_CONNECT_CA_FILE).';
  if (kind === 'host' && out.hostAccess !== true) details.hostAccess = 'Confirm: a shell as the installing user, with no isolation.';
  if (Object.keys(details).length) throw invalid(details);
  return out;
}

/** How long a token lives: the request's, else a cluster's hour, else the setting; at most 24 hours. */
export function checkTtl(raw: unknown, kind: ConnectKind, settingMinutes: number): number {
  const fallback = CONNECT_ROLE[kind] === 'cluster' ? Math.max(settingMinutes, CONNECT_TOKEN_TTL_MINUTES.cluster) : settingMinutes;
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > CONNECT_TOKEN_TTL_MINUTES.max) {
    throw invalid({ ttlMinutes: `A whole number of minutes, 1 to ${CONNECT_TOKEN_TTL_MINUTES.max}.` });
  }
  return raw;
}

/** How many nodes one token may enroll: a single always 1; a cluster 1 by default (Swarm 20), at most 50. */
export function checkMaxUses(raw: unknown, kind: ConnectKind): number {
  if (CONNECT_ROLE[kind] === 'single') return 1;
  const fallback = kind === 'swarm' ? 20 : 1;
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > CONNECT_TOKEN_USES_MAX) throw invalid({ maxUses: `A whole number, 1 to ${CONNECT_TOKEN_USES_MAX}.` });
  return raw;
}

/** The settings a new target starts with: what the options say, and the delivery default (on for clusters, off for singles: owner decision O5). */
export function initialSettings(kind: ConnectKind, options: ConnectInstallOptions): ConnectTargetSettings {
  const s: ConnectTargetSettings = { delivery: CONNECT_ROLE[kind] === 'cluster' };
  if (kind === 'kubernetes') {
    s.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    if (options.storageClass) s.storageClass = options.storageClass;
    if (options.storage) s.storage = options.storage;
  } else if (options.workspaceImage) s.workspaceImage = options.workspaceImage;
  return s;
}

/** A `PATCH` of a target's settings: what may change, and 409 for the namespace (fixed when the connector is installed). */
export function checkSettingsPatch(kind: ConnectKind, current: ConnectTargetSettings, patch: unknown): ConnectTargetSettings {
  if (patch === undefined) return current;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid({ settings: 'An object.' });
  const p = patch as Record<string, unknown>;
  const next: ConnectTargetSettings = { ...current };
  const details: Record<string, string> = {};
  for (const [key, v] of Object.entries(p)) {
    switch (key) {
      case 'namespace':
        if (kind !== 'kubernetes') details.namespace = 'Only a Kubernetes target has a namespace.';
        else if (v !== (current.namespace ?? DEFAULT_NAMESPACE)) throw new AppError('CONFLICT', 'The namespace is fixed when the connector is installed. Enroll again to change it.', { details: { namespace: 'Fixed at install.' } });
        break;
      case 'storageClass':
      case 'storage': {
        if (kind !== 'kubernetes') details[key] = 'Only a Kubernetes target has this.';
        else if (v === null || v === '') delete next[key];
        else if (typeof v !== 'string' || !(key === 'storage' ? STORAGE : STORAGE_CLASS).test(v) || looksLikeSecret(v)) details[key] = key === 'storage' ? 'A size such as 10Gi.' : 'A storage class name.';
        else next[key] = v;
        break;
      }
      case 'workspaceImage':
        if (kind === 'kubernetes') details.workspaceImage = 'A Kubernetes target uses the portal’s image.';
        else if (v === null || v === '') delete next.workspaceImage;
        else if (typeof v !== 'string' || !IMAGE_REF.test(v) || looksLikeSecret(v)) details.workspaceImage = 'An image reference such as registry/name:tag.';
        else next.workspaceImage = v;
        break;
      case 'maxWorkspaces':
        if (CONNECT_ROLE[kind] !== 'cluster') details.maxWorkspaces = 'Only a cluster has a limit.';
        else if (v === null) next.maxWorkspaces = null;
        else if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10_000) details.maxWorkspaces = 'A whole number, 1 or more, or none.';
        else next.maxWorkspaces = v;
        break;
      case 'delivery':
        if (typeof v !== 'boolean') details.delivery = 'true or false.';
        else next.delivery = v;
        break;
      case 'running':
        details.running = 'Use Start and Stop on the workspace.';
        break;
      default:
        details[key] = 'Not a setting.';
    }
  }
  if (Object.keys(details).length) throw invalid(details);
  return next;
}
