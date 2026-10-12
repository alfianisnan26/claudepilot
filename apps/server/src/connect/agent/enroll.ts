// The enrollment client (docs/prd/targets-connect.md §10.2): make a key pair, send the PUBLIC half with the token to
// `POST /connect/v1/enroll`, keep the private half. The token is used up by the call; it goes only in the Authorization header and is
// never logged, put in an error, or left in the process list. Every refusal is an `EnrollError` with a plain next step.
import {
  CONNECT_ENROLL_REASONS,
  CONNECT_PUBLIC,
  connectOriginProblem,
  type ConnectAgentHello,
  type ConnectEnrollReason,
  type ConnectEnrollRequest,
  type ConnectEnrollResult,
} from '@portal/contracts';
import { generateNodeKeyPair, keyFingerprint, type NodeKeyPair } from '../tunnel/auth.js';
import { fingerprintOf, type Identity, type IdentityStore } from './identity.js';
import type { Logger } from './log.js';
import { describeNetError, httpRequest, type NetConfig } from './net.js';

export type EnrollFailure = ConnectEnrollReason | 'unreachable' | 'rate_limited' | 'not_found' | 'bad_response' | 'server_error' | 'cannot_save';

export class EnrollError extends Error {
  override readonly name = 'EnrollError';
  constructor(
    readonly reason: EnrollFailure,
    message: string,
    readonly hint?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const NEW_COMMAND = 'Make a new command in the portal (Targets).';

const BY_REASON: Record<ConnectEnrollReason, { message: string; hint: string }> = {
  token_invalid: { message: 'The portal does not know this token.', hint: NEW_COMMAND },
  token_expired: { message: 'The token has expired.', hint: NEW_COMMAND },
  token_used: { message: 'The token was already used. If that wasn’t you, revoke the node in the portal.', hint: NEW_COMMAND },
  token_revoked: { message: 'The token was revoked.', hint: NEW_COMMAND },
  target_enrolled: { message: 'This target already has its machine.', hint: 'Revoke the old node in the portal first.' },
  name_taken: { message: 'That node name is taken in this target.', hint: 'Pick another name (PILOT_NODE_NAME).' },
  bad_key: { message: 'The portal refused the key this agent made.', hint: 'Run the installer again; if it persists, update the agent.' },
  insecure_url: { message: 'The portal wants https.', hint: 'Use its https address.' },
  store_locked: { message: 'The portal can’t take new machines right now (its store is locked).', hint: 'Try again later.' },
};

const isReason = (r: unknown): r is ConnectEnrollReason => typeof r === 'string' && (CONNECT_ENROLL_REASONS as readonly string[]).includes(r);

interface EnrollBody {
  data?: unknown;
  error?: { message?: unknown; details?: { reason?: unknown } };
}

export interface EnrollOptions {
  url: string;
  token: string;
  hello: ConnectAgentHello;
  nodeName?: string | null;
  net: NetConfig;
  store: IdentityStore;
  log: Logger;
  allowHttp?: boolean;
  now?: () => Date;
  /** Tests: the key pair to use. */
  keyPair?: NodeKeyPair;
}

/** Enrolls and saves the identity; resolves with it. Throws `EnrollError`. */
export async function enroll(opts: EnrollOptions): Promise<Identity> {
  const { log } = opts;
  log.addSecret(opts.token);
  const problem = connectOriginProblem(opts.url, opts.allowHttp ?? false);
  if (problem) throw new EnrollError('insecure_url', `The portal address is not usable: ${problem}`, 'Use the https address.');

  const keys = opts.keyPair ?? generateNodeKeyPair();
  log.addSecret(keys.privateKey);
  const body: ConnectEnrollRequest = { publicKey: keys.publicKey, hello: opts.hello, ...(opts.nodeName ? { nodeName: opts.nodeName } : {}) };

  let status: number;
  let json: EnrollBody | null = null;
  try {
    const res = await httpRequest(
      new URL(CONNECT_PUBLIC.enroll, opts.url),
      { method: 'POST', headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
      opts.net,
    );
    status = res.status;
    try {
      json = JSON.parse(res.body.toString('utf8')) as EnrollBody;
    } catch {
      json = null;
    }
  } catch (e) {
    const d = describeNetError(e);
    log.warn('enroll.unreachable', { code: d.code });
    throw new EnrollError('unreachable', d.message, d.hint ?? 'Run `pilot-agent doctor`.');
  }

  if (status >= 200 && status < 300) {
    const r = json?.data as Partial<ConnectEnrollResult> | undefined;
    if (!r || typeof r.node !== 'string' || typeof r.target !== 'string') throw new EnrollError('bad_response', 'The portal’s answer was not what an agent expects.', 'Is this address a ClaudePilot portal?', status);
    const identity: Identity = {
      node: r.node,
      target: r.target,
      portalUrl: opts.url,
      portalId: typeof r.portalId === 'string' && r.portalId ? r.portalId : null,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      enrolledAt: (opts.now ?? (() => new Date()))().toISOString(),
    };
    try {
      await opts.store.save(identity);
    } catch {
      // The token is spent; the key is lost. Say exactly that, with the node id the person needs to revoke.
      throw new EnrollError('cannot_save', `Enrolled as ${identity.node}, but the identity could not be saved to ${opts.store.describe()}.`, `Revoke node ${identity.node} in the portal and enroll again after fixing the folder.`);
    }
    log.info('enroll.done', { node: identity.node, target: identity.target, fingerprint: fingerprintOf(identity) });
    return identity;
  }

  const reason = json?.error?.details?.reason;
  if (isReason(reason)) {
    const known = BY_REASON[reason];
    log.warn('enroll.refused', { reason, status });
    throw new EnrollError(reason, known.message, known.hint, status);
  }
  log.warn('enroll.refused', { status });
  if (status === 429) throw new EnrollError('rate_limited', 'Too many wrong tokens from this address.', 'Wait ten minutes, then use the right command.', status);
  if (status === 404) throw new EnrollError('not_found', 'The portal does not offer Connect at this address.', 'Check the address; an admin may have turned Connect off.', status);
  const serverText = typeof json?.error?.message === 'string' ? json.error.message.slice(0, 200) : '';
  throw new EnrollError('server_error', `The portal answered ${status}${serverText ? `: ${serverText}` : ''}.`, 'Run `pilot-agent doctor`.', status);
}

export { keyFingerprint };
