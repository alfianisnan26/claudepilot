import { createHash } from 'node:crypto';
import { AppError, defineErrorCodes, newId } from '@isnanme/core';
import {
  ACCOUNT_NAME_MAX,
  type Account,
  type AccountHealthState,
  type AccountsOverview,
  type BulkAddAccountsRequest,
  type BulkAddAccountsResult,
  type CheckResult,
  type CreateAccountRequest,
  type Endpoint,
  type EndpointRequest,
  type ModelNames,
  type UpdateAccountRequest,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import { checkKey, listModels, normalizeBaseUrl, type CheckOutcome } from './check.js';

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    LOCKED: true;
  }
}
defineErrorCodes({ LOCKED: { status: 423, message: 'Secrets are locked.' } });

const EVENT_RETENTION_DAYS = 90;
const BULK_SPACING_MS = 1_000;

interface EndpointRow {
  id: string;
  kind: 'anthropic' | 'custom';
  name: string;
  base_url: string;
  model_names: string;
  context_tokens: number | null;
  max_output_tokens: number | null;
  disable_betas: number;
  allow_private_network: number;
  created_at: string;
  accounts: number;
}

interface AccountRow {
  id: string;
  endpoint_id: string;
  name: string;
  secret: string | null;
  fingerprint: string;
  masked: string;
  enabled: number;
  notes: string;
  organization_id: string | null;
  anthropic_workspace_id: string | null;
  check_result: CheckResult;
  check_status: number | null;
  check_detail: string | null;
  checked_at: string | null;
  health: AccountHealthState;
  health_until: string | null;
  health_detail: string | null;
  health_at: string | null;
  created_at: string;
}

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });

/** Short SHA-256 of a key: recognizes it (and duplicates) without decrypting anything. */
export const fingerprintOf = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);

/** `sk-ant-…a1b2` for Anthropic keys, `…a1b2` for others: never more than the last four characters. */
export const maskKey = (key: string) => `${key.startsWith('sk-ant-') ? 'sk-ant-' : ''}…${key.slice(-4)}`;

function cleanName(input: unknown): string {
  const name = typeof input === 'string' ? input.trim() : '';
  if (!name) throw invalid('name', 'Give it a name.');
  if (name.length > ACCOUNT_NAME_MAX) throw invalid('name', `Use at most ${ACCOUNT_NAME_MAX} characters.`);
  return name;
}

/** Keys end up in an HTTP header through apiKeyHelper, which must print only printable ASCII. */
function cleanKey(input: unknown): string {
  const key = typeof input === 'string' ? input.trim() : '';
  if (!key) throw invalid('key', 'Paste the key.');
  if (key.length > 4096) throw invalid('key', 'That is too long to be a key.');
  if (!/^[\x21-\x7e]+$/.test(key)) throw invalid('key', 'A key is one line of letters, digits and symbols, with no spaces.');
  return key;
}

function cleanTokens(input: unknown, field: string): number | null {
  if (input === undefined || input === null || input === '') return null;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1024 || n > 10_000_000) throw invalid(field, 'Use a whole number of tokens between 1,024 and 10,000,000.');
  return n;
}

function cleanModelNames(input: unknown): ModelNames {
  const out: ModelNames = {};
  if (!input || typeof input !== 'object') return out;
  for (const slot of ['opus', 'sonnet', 'haiku', 'default'] as const) {
    const v = (input as Record<string, unknown>)[slot];
    if (typeof v === 'string' && v.trim()) {
      if (!/^[\x21-\x7e]{1,200}$/.test(v.trim())) throw invalid(`modelNames.${slot}`, 'Model names have no spaces.');
      out[slot] = v.trim();
    }
  }
  return out;
}

/**
 * Accounts (keys) and the endpoints they're used with (Account Pool PRD §8, FR1–FR5). Keys are sealed
 * in the store and never leave it in a response.
 */
export class AccountsService {
  #lastPrune = 0;
  /**
   * Wired at startup: `changed` (an account was edited, disabled or enabled), `checked` (a key check
   * was saved; health decides what it means), `poolsWith` (pools holding an account).
   */
  hooks: {
    changed?: (accountId: string, why: string) => void;
    checked?: (accountId: string, result: CheckResult, manual: boolean) => void;
    poolsWith?: (accountId: string) => string[];
    /** Any account or endpoint change worth showing (every one is also an event in the log). */
    event?: () => void;
  } = {};

  constructor(private readonly store: Store) {}

  get #db() {
    const db = this.store.db;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', this.#lockReason() ?? 'The database is not available.');
    return db;
  }

  #lockReason(): string | null {
    if (this.store.secrets && this.store.writable) return null;
    return this.store.trust.reasons.map((r) => r.message).join(' ') || 'The database is read-only.';
  }

  /** Anything that stores or uses a key needs the secret key and a writable database. */
  #secrets() {
    const reason = this.#lockReason();
    if (reason) throw new AppError('LOCKED', `Secrets are locked: ${reason}`);
    return this.store.secrets!;
  }

  #requireWritable() {
    if (!this.store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The database is read-only.');
  }

  overview(): AccountsOverview {
    const reason = this.#lockReason();
    return {
      endpoints: this.#endpoints(),
      accounts: (this.#db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as unknown as AccountRow[]).map(toAccount),
      locked: reason ? { reason } : null,
    };
  }

  #endpoints(): Endpoint[] {
    return (
      this.#db
        .prepare(
          `SELECT e.*, (SELECT count(*) FROM accounts a WHERE a.endpoint_id = e.id) AS accounts
           FROM endpoints e ORDER BY e.kind, e.created_at`,
        )
        .all() as unknown as EndpointRow[]
    ).map(toEndpoint);
  }

  #endpoint(id: unknown): Endpoint {
    const found = this.#endpoints().find((e) => e.id === id);
    if (!found) throw invalid('endpointId', 'Pick where the key is used.');
    return found;
  }

  #account(id: string): AccountRow {
    const row = this.#db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as AccountRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'That account no longer exists.');
    return row;
  }

  #assertUnique(name: string, fingerprint: string | null, exceptId?: string) {
    const byName = this.#db.prepare('SELECT id FROM accounts WHERE name = ? COLLATE NOCASE').get(name) as { id: string } | undefined;
    if (byName && byName.id !== exceptId) throw new AppError('CONFLICT', `An account named “${name}” already exists.`, { details: { name: 'Already used.' } });
    if (!fingerprint) return;
    const byKey = this.#db.prepare('SELECT id, name FROM accounts WHERE fingerprint = ?').get(fingerprint) as { id: string; name: string } | undefined;
    if (byKey && byKey.id !== exceptId)
      throw new AppError('CONFLICT', `This key is already saved as “${byKey.name}”.`, { details: { key: `Already saved as “${byKey.name}”.` } });
  }

  #event(type: string, accountId: string | null, details: Record<string, unknown> = {}) {
    const now = Date.now();
    this.#db.prepare('INSERT INTO account_events (at, type, account_id, details) VALUES (?, ?, ?, ?)').run(new Date(now).toISOString(), type, accountId, JSON.stringify(details));
    this.hooks.event?.();
    if (now - this.#lastPrune > 60 * 60 * 1000) {
      this.#lastPrune = now;
      this.#db.prepare('DELETE FROM account_events WHERE at < ?').run(new Date(now - EVENT_RETENTION_DAYS * 86_400_000).toISOString());
    }
  }

  #saveCheck(id: string, outcome: CheckOutcome, manual = true) {
    this.#db
      .prepare(
        `UPDATE accounts SET check_result = ?, check_status = ?, check_detail = ?, checked_at = ?,
           organization_id = coalesce(?, organization_id), anthropic_workspace_id = coalesce(?, anthropic_workspace_id)
         WHERE id = ?`,
      )
      .run(outcome.result, outcome.status, outcome.detail, new Date().toISOString(), outcome.organizationId, outcome.anthropicWorkspaceId, id);
    this.#event('account_checked', id, { result: outcome.result, status: outcome.status, manual });
    this.hooks.checked?.(id, outcome.result, manual);
  }

  #insert(endpoint: Endpoint, name: string, key: string, notes: string): string {
    const box = this.#secrets();
    const fingerprint = fingerprintOf(key);
    this.#assertUnique(name, fingerprint);
    const id = newId();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO accounts (id, endpoint_id, name, secret, fingerprint, masked, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, endpoint.id, name, box.seal(key, { table: 'accounts', row: id, column: 'secret' }), fingerprint, maskKey(key), notes, now, now);
    this.#event('account_added', id, { name, endpoint: endpoint.id, fingerprint });
    return id;
  }

  async create(req: Partial<CreateAccountRequest>): Promise<Account> {
    if (req.confirmOwned !== true) throw invalid('confirmOwned', 'Confirm that this key belongs to you or your organization.');
    const endpoint = this.#endpoint(req.endpointId);
    const name = cleanName(req.name);
    const key = cleanKey(req.key);
    const notes = typeof req.notes === 'string' ? req.notes.trim().slice(0, 500) : '';
    const id = this.#insert(endpoint, name, key, notes);
    this.#saveCheck(id, await checkKey(endpoint, key));
    return toAccount(this.#account(id));
  }

  /** Creates every valid line now and checks them one at a time, a second apart, in the background. */
  bulkAdd(req: Partial<BulkAddAccountsRequest>): BulkAddAccountsResult {
    if (req.confirmOwned !== true) throw invalid('confirmOwned', 'Confirm that these keys belong to you or your organization.');
    const endpoint = this.#endpoint(req.endpointId);
    this.#secrets();
    const lines = typeof req.lines === 'string' ? req.lines.split(/\r?\n/) : [];
    const created: { id: string; key: string }[] = [];
    const skipped: BulkAddAccountsResult['skipped'] = [];
    lines.forEach((raw, i) => {
      if (!raw.trim()) return;
      const bar = raw.indexOf('|');
      if (bar < 0) return skipped.push({ line: i + 1, reason: 'Use “name|key”.' });
      try {
        const name = cleanName(raw.slice(0, bar));
        const key = cleanKey(raw.slice(bar + 1));
        created.push({ id: this.#insert(endpoint, name, key, ''), key });
      } catch (e) {
        skipped.push({ line: i + 1, reason: (e as Error).message });
      }
    });
    if (created.length === 0 && skipped.length === 0) throw invalid('lines', 'Paste one “name|key” per line.');
    void (async () => {
      for (const [i, c] of created.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, BULK_SPACING_MS));
        try {
          this.#saveCheck(c.id, await checkKey(endpoint, c.key));
        } catch (e) {
          console.error(`[accounts] bulk check failed: ${(e as Error).message}`);
        }
      }
    })();
    return { created: created.map((c) => toAccount(this.#account(c.id))), skipped };
  }

  async update(id: string, req: Partial<UpdateAccountRequest>): Promise<Account> {
    this.#requireWritable();
    const row = this.#account(id);
    const name = req.name === undefined ? row.name : cleanName(req.name);
    const key = req.key === undefined || req.key === '' ? null : cleanKey(req.key);
    this.#assertUnique(name, key ? fingerprintOf(key) : null, id);
    const changes: string[] = [];
    if (name !== row.name) changes.push('name');
    if (req.notes !== undefined && req.notes !== row.notes) changes.push('notes');
    if (req.enabled !== undefined && Number(req.enabled) !== row.enabled) changes.push(req.enabled ? 'enabled' : 'disabled');
    const now = new Date().toISOString();
    this.#db
      .prepare('UPDATE accounts SET name = ?, notes = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(name, typeof req.notes === 'string' ? req.notes.trim().slice(0, 500) : row.notes, req.enabled === undefined ? row.enabled : Number(!!req.enabled), now, id);
    if (key) {
      const box = this.#secrets();
      this.#db
        .prepare(
          `UPDATE accounts SET secret = ?, fingerprint = ?, masked = ?, check_result = 'unknown', check_status = NULL, check_detail = NULL,
             health = 'ok', health_until = NULL, health_detail = NULL, health_at = NULL, backoff_ms = NULL WHERE id = ?`,
        )
        .run(box.seal(key, { table: 'accounts', row: id, column: 'secret' }), fingerprintOf(key), maskKey(key), id);
      changes.push('key replaced');
    }
    if (changes.length) this.#event('account_updated', id, { changes });
    if (key) this.#saveCheck(id, await checkKey(this.#endpoint(row.endpoint_id), key));
    else if (changes.length) this.hooks.changed?.(id, changes.join(', '));
    return toAccount(this.#account(id));
  }

  /** `manual`: an admin asked (Check now); scheduled checks every 15 minutes pass false. */
  async check(id: string, opts: { manual?: boolean } = {}): Promise<Account> {
    const box = this.#secrets();
    const row = this.#account(id);
    if (!row.secret) throw new AppError('CONFLICT', 'This account has no key. Enter it again first.');
    const key = box.open(row.secret, { table: 'accounts', row: id, column: 'secret' });
    this.#saveCheck(id, await checkKey(this.#endpoint(row.endpoint_id), key), opts.manual ?? true);
    return toAccount(this.#account(id));
  }

  get(id: string): Account {
    return toAccount(this.#account(id));
  }

  remove(id: string) {
    this.#requireWritable();
    const row = this.#account(id);
    const pools = this.hooks.poolsWith?.(id) ?? [];
    if (pools.length) throw new AppError('CONFLICT', `Take it out of ${pools.map((p) => `“${p}”`).join(', ')} first.`);
    this.#db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    this.#event('account_removed', id, { name: row.name, fingerprint: row.fingerprint });
  }

  createEndpoint(req: Partial<EndpointRequest>): Endpoint {
    this.#requireWritable();
    const fields = this.#endpointFields(req);
    const clash = this.#db.prepare('SELECT id FROM endpoints WHERE name = ? COLLATE NOCASE').get(fields.name);
    if (clash) throw new AppError('CONFLICT', `An endpoint named “${fields.name}” already exists.`, { details: { name: 'Already used.' } });
    const id = newId();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO endpoints (id, kind, name, base_url, model_names, context_tokens, max_output_tokens, disable_betas, allow_private_network, created_at, updated_at)
         VALUES (?, 'custom', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, fields.name, fields.baseUrl, JSON.stringify(fields.modelNames), fields.contextTokens, fields.maxOutputTokens, Number(fields.disableBetas), Number(fields.allowPrivateNetwork), now, now);
    this.#event('endpoint_added', null, { endpoint: id, name: fields.name, baseUrl: fields.baseUrl });
    return this.#endpoint(id);
  }

  updateEndpoint(id: string, req: Partial<EndpointRequest>): Endpoint {
    this.#requireWritable();
    const current = this.#endpoint(id);
    if (current.kind === 'anthropic') throw new AppError('FORBIDDEN', 'The Anthropic API endpoint is built in.');
    const fields = this.#endpointFields({ ...toRequest(current), ...req });
    const clash = this.#db.prepare('SELECT id FROM endpoints WHERE name = ? COLLATE NOCASE AND id != ?').get(fields.name, id);
    if (clash) throw new AppError('CONFLICT', `An endpoint named “${fields.name}” already exists.`, { details: { name: 'Already used.' } });
    this.#db
      .prepare(
        `UPDATE endpoints SET name = ?, base_url = ?, model_names = ?, context_tokens = ?, max_output_tokens = ?,
           disable_betas = ?, allow_private_network = ?, updated_at = ? WHERE id = ?`,
      )
      .run(fields.name, fields.baseUrl, JSON.stringify(fields.modelNames), fields.contextTokens, fields.maxOutputTokens, Number(fields.disableBetas), Number(fields.allowPrivateNetwork), new Date().toISOString(), id);
    this.#event('endpoint_updated', null, { endpoint: id });
    return this.#endpoint(id);
  }

  removeEndpoint(id: string) {
    this.#requireWritable();
    const current = this.#endpoint(id);
    if (current.kind === 'anthropic') throw new AppError('FORBIDDEN', 'The Anthropic API endpoint is built in.');
    if (current.accounts > 0) throw new AppError('CONFLICT', `Remove its ${current.accounts} account(s) first.`);
    this.#db.prepare('DELETE FROM endpoints WHERE id = ?').run(id);
    this.#event('endpoint_removed', null, { endpoint: id, name: current.name });
  }

  /** The host's model IDs, read with one of its working keys. */
  async endpointModels(id: string): Promise<string[]> {
    const box = this.#secrets();
    const endpoint = this.#endpoint(id);
    const row = this.#db
      .prepare(
        `SELECT id, secret FROM accounts WHERE endpoint_id = ? AND enabled = 1 AND secret IS NOT NULL
         ORDER BY check_result IN ('ok', 'rate_limited') DESC, created_at LIMIT 1`,
      )
      .get(id) as { id: string; secret: string } | undefined;
    if (!row) throw new AppError('CONFLICT', 'Add a key for this host first.');
    return listModels(endpoint, box.open(row.secret, { table: 'accounts', row: row.id, column: 'secret' }));
  }

  #endpointFields(req: Partial<EndpointRequest>) {
    const name = cleanName(req.name);
    const baseUrl = normalizeBaseUrl(typeof req.baseUrl === 'string' ? req.baseUrl : '');
    if (baseUrl === 'https://api.anthropic.com') throw invalid('baseUrl', 'That is the Anthropic API; add its keys there instead.');
    return {
      name,
      baseUrl,
      modelNames: cleanModelNames(req.modelNames),
      contextTokens: cleanTokens(req.contextTokens, 'contextTokens'),
      maxOutputTokens: cleanTokens(req.maxOutputTokens, 'maxOutputTokens'),
      disableBetas: !!req.disableBetas,
      allowPrivateNetwork: !!req.allowPrivateNetwork,
    };
  }
}

function toEndpoint(r: EndpointRow): Endpoint {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    baseUrl: r.base_url,
    modelNames: JSON.parse(r.model_names) as ModelNames,
    contextTokens: r.context_tokens,
    maxOutputTokens: r.max_output_tokens,
    disableBetas: !!r.disable_betas,
    allowPrivateNetwork: !!r.allow_private_network,
    accounts: Number(r.accounts),
    createdAt: r.created_at,
  };
}

function toRequest(e: Endpoint): EndpointRequest {
  return {
    name: e.name,
    baseUrl: e.baseUrl,
    modelNames: e.modelNames,
    contextTokens: e.contextTokens,
    maxOutputTokens: e.maxOutputTokens,
    disableBetas: e.disableBetas,
    allowPrivateNetwork: e.allowPrivateNetwork,
  };
}

/** Never includes the secret: only its mask and fingerprint. */
function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    endpointId: r.endpoint_id,
    name: r.name,
    masked: r.masked,
    fingerprint: r.fingerprint.slice(0, 12),
    hasSecret: r.secret !== null,
    enabled: !!r.enabled,
    notes: r.notes,
    organizationId: r.organization_id,
    anthropicWorkspaceId: r.anthropic_workspace_id,
    check: { result: r.check_result, status: r.check_status, detail: r.check_detail, at: r.checked_at },
    health: { state: r.health, until: r.health_until, detail: r.health_detail, at: r.health_at },
    createdAt: r.created_at,
  };
}

