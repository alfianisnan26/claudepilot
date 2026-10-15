// Upstream sync, the portal's side (local-git-ci PRD FR8a, T-486): checking what a person sets (an https URL, a Secrets & env NAME, how
// often), the SSRF guard on the upstream's host (resolved here, every address public, the one checked handed to git as a pin), and the
// state a sync leaves (diverged branches keep the time they were first seen, so the Needs you item does not jump).

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from '@isnanme/core';
import { CI_UPSTREAM_EVERY_S, type CiUpstream, type CiUpstreamDiverged, type UpdateCiUpstream } from '@portal/contracts';
import { isPrivateAddress } from '../accounts/check.js';

/** A Secrets & env name as the runner accepts it (runner/upstream.ts SECRET_NAME). */
const SECRET_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });

export interface UpstreamSetting {
  url: string;
  secret: string | null;
  everyS: number;
}

/** The setting as stored, or a VALIDATION_FAILED naming the field. The URL is returned as URL normalises it. */
export function checkUpstream(req: unknown): UpstreamSetting {
  const r = (req && typeof req === 'object' ? req : {}) as Partial<UpdateCiUpstream>;
  if (typeof r.url !== 'string' || r.url.length > 500 || /[\s\0]/.test(r.url)) throw invalid('upstream.url', 'An https URL.');
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    throw invalid('upstream.url', 'An https URL.');
  }
  if (u.protocol !== 'https:' || !u.hostname) throw invalid('upstream.url', 'An https URL.');
  // A token never rides in a URL: name a secret instead.
  if (u.username || u.password) throw invalid('upstream.url', 'No user or password in the URL; name a secret instead.');
  if (u.search || u.hash) throw invalid('upstream.url', 'No query or fragment.');
  if (!/^\/[A-Za-z0-9._~/-]+$/.test(u.pathname) || u.pathname.includes('..')) throw invalid('upstream.url', 'The path is letters, digits and . _ ~ / -.');
  let secret: string | null = null;
  if (r.secret !== undefined && r.secret !== null && r.secret !== '') {
    if (typeof r.secret !== 'string' || !SECRET_NAME.test(r.secret) || r.secret.includes('..')) throw invalid('upstream.secret', 'A Secrets & env name.');
    secret = r.secret;
  }
  let everyS: number = CI_UPSTREAM_EVERY_S.default;
  if (r.everyS !== undefined) {
    if (!Number.isInteger(r.everyS) || r.everyS < CI_UPSTREAM_EVERY_S.min || r.everyS > CI_UPSTREAM_EVERY_S.max) throw invalid('upstream.everyS', `Seconds, from ${CI_UPSTREAM_EVERY_S.min} to ${CI_UPSTREAM_EVERY_S.max}.`);
    everyS = r.everyS;
  }
  return { url: u.href, secret, everyS };
}

export type Lookup = (host: string) => Promise<string[]>;

export const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/**
 * The SSRF guard for an upstream: the host is on the allow-list when there is one, it resolves, and every address is public. Returns the
 * address git is pinned to (IPv4 first). Refusals are VALIDATION_FAILED and name the host, never anything else.
 */
export async function upstreamPin(url: string, lookup: Lookup, allow?: readonly string[]): Promise<string> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allow && !allow.map((h) => h.toLowerCase()).includes(host)) throw invalid('upstream.url', `${host} is not on the portal's list of upstream hosts.`);
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await lookup(host);
  } catch {
    addresses = [];
  }
  if (!addresses.length) throw invalid('upstream.url', `${host} does not resolve.`);
  if (addresses.some(isPrivateAddress)) throw invalid('upstream.url', `${host} is a private address; an upstream must be public.`);
  return addresses.find((a) => isIP(a) === 4) ?? addresses[0]!;
}

/** What the last sync left, as stored in `upstream_state`. */
export interface UpstreamState {
  at: string | null;
  error: string | null;
  diverged: CiUpstreamDiverged[];
  ahead: string[];
  gone: string[];
  /**
   * Set when the upstream was changed or removed: the staging refs of the old one are still in the remote, so the next sync must clear
   * them (`--reset`) and is a baseline again. Kept through a removal (the state is hidden while no upstream is set) and dropped by the
   * first sync that succeeds.
   */
  reset?: true;
}

export const EMPTY_STATE: UpstreamState = { at: null, error: null, diverged: [], ahead: [], gone: [] };

export function readState(text: string | null | undefined): UpstreamState {
  if (!text) return EMPTY_STATE;
  try {
    const s = JSON.parse(text) as Partial<UpstreamState>;
    return {
      at: typeof s.at === 'string' ? s.at : null,
      error: typeof s.error === 'string' ? s.error : null,
      diverged: Array.isArray(s.diverged) ? s.diverged.filter((d) => d && typeof d.branch === 'string' && typeof d.local === 'string' && typeof d.upstream === 'string' && typeof d.since === 'string') : [],
      ahead: Array.isArray(s.ahead) ? s.ahead.filter((b) => typeof b === 'string') : [],
      gone: Array.isArray(s.gone) ? s.gone.filter((b) => typeof b === 'string') : [],
      ...(s.reset === true ? { reset: true as const } : {}),
    };
  } catch {
    return EMPTY_STATE;
  }
}

/** The runner's reply to `repo sync`, the parts the portal keeps. */
export interface SyncReply {
  moved: { branch: string; old: string; new: string }[];
  diverged: { branch: string; local: string; upstream: string }[];
  ahead: string[];
  deleted: string[];
  onlyHere: string[];
}

const MAX_LISTED = 200;

/**
 * The state after a sync. A diverged branch keeps the `since` it was first seen with the same pair of shas. A branch gone upstream stays
 * listed while it is still here and not upstream again (`onlyHere`): the sync keeps it, and the list says so.
 */
export function nextState(prev: UpstreamState, r: SyncReply, at: string): UpstreamState {
  const diverged = r.diverged.slice(0, MAX_LISTED).map((d) => {
    const was = prev.diverged.find((p) => p.branch === d.branch && p.local === d.local && p.upstream === d.upstream);
    return { branch: d.branch, local: d.local, upstream: d.upstream, since: was?.since ?? at };
  });
  const here = new Set(r.onlyHere);
  const gone = [...new Set([...prev.gone, ...r.deleted])].filter((b) => here.has(b)).sort().slice(0, MAX_LISTED);
  return { at, error: null, diverged, ahead: r.ahead.slice(0, MAX_LISTED), gone };
}

/** The API's view of a remote's upstream, or null when it follows none. */
export function upstreamView(row: { upstream_url?: string | null; upstream_secret?: string | null; upstream_every_s?: number | null; upstream_state?: string | null }): CiUpstream | null {
  if (!row.upstream_url) return null;
  const s = readState(row.upstream_state);
  return {
    url: row.upstream_url,
    secret: row.upstream_secret ?? null,
    everyS: row.upstream_every_s ?? CI_UPSTREAM_EVERY_S.default,
    lastAt: s.at,
    error: s.error,
    diverged: s.diverged,
    ahead: s.ahead,
    gone: s.gone,
  };
}
