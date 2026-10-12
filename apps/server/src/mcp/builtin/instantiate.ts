import { createHash } from 'node:crypto';
import { AppError, isAppError, newId } from '@isnanme/core';
import type {
  McpBuiltinAdded,
  McpBuiltinAddRequest,
  McpBuiltinAddResult,
  McpBuiltinAuth,
  McpBuiltinItem,
  McpBuiltinPreview,
  McpBuiltinServer,
  McpBuiltinTemplate,
  McpRiskFlag,
  McpSetContent,
  McpSetServer,
  McpSlot,
  McpVersionSpec,
  SecretsContent,
} from '@portal/contracts';
import { MCP_BUILTIN_NAME_MAX, secretFileRef } from '@portal/contracts';
import type { PoolService } from '../../pools/service.js';
import type { Store } from '../../store/store.js';
import type { McpCatalog } from '../catalog.js';
import { slugFrom } from '../spec.js';
import { type BuiltinRegistry, paramsFor, serversFor } from './registry.js';
import { entryKeyFor, entryNameFor, fill, INSTANCE_NAME, paramValue, placeholdersOf, SECRET_NAME, serverSlots, serverSpec, setNameFor } from './template.js';

/**
 * Add, update and list built-in instances (built-in catalogue PRD FR4–FR12). A template becomes ordinary catalog entries (one per
 * server, approved by "Admin" with the note `Built-in catalogue v<N>`) and one `mcpset` set; the instance row remembers which, so
 * the same inputs find them again. Everything an entry is goes through the catalog's own parse, URL rules and SSRF guard.
 */

const REVIEWER_NOTE = (version: number) => `Built-in catalogue v${version}`;
const NOTE_PREFIX = 'Built-in catalogue v';
const ADDED_BY = 'Admin';
const MAX_AUTO_LABEL = 50;

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sortedObject = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
/** Key order does not change what a definition is. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (isObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

interface InstanceRow {
  id: string;
  template_id: string;
  template_version: number;
  name: string;
  auth: McpBuiltinAuth;
  params: string;
  servers: string;
  secret_names: string;
  allow_private_network: number;
  fingerprint: string;
  pool_id: string;
  added_at: string;
  added_by: string;
  updated_at: string;
}

interface PlannedServer {
  server: McpBuiltinServer;
  spec: McpVersionSpec;
  slots: McpSlot[];
  flags: McpRiskFlag[];
}

/** A checked request: what Add would build, before the instance's label and existing entries are known. */
interface Plan {
  template: McpBuiltinTemplate;
  auth: McpBuiltinAuth;
  params: Record<string, string>;
  servers: PlannedServer[];
  allowPrivateNetwork: boolean;
  fingerprint: string;
}

/** What the catalog holds for a planned server: nothing, a version that is exactly it, or an entry that needs a new version. */
type Assessment = { kind: 'new' } | { kind: 'reuse'; entryId: string; version: string } | { kind: 'version'; entryId: string };

/** A server's entry and the version of it the set points at. */
interface Made {
  key: string;
  entryId: string;
  version: string;
}

/** What the request resolved to: the instance it changes (if any) and the label its keys and set name use. */
interface Target {
  row: InstanceRow | null;
  label: string;
  secretNames: Record<string, string>;
}

export class McpBuiltin {
  readonly #store: Store;
  readonly #catalog: McpCatalog;
  readonly #pools: PoolService;
  readonly #registry: BuiltinRegistry;
  /** Adds run one at a time: two at once could both make the same entry. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: { store: Store; catalog: McpCatalog; pools: PoolService; registry: BuiltinRegistry }) {
    this.#store = deps.store;
    this.#catalog = deps.catalog;
    this.#pools = deps.pools;
    this.#registry = deps.registry;
  }

  get #db() {
    const db = this.#store.db;
    if (!db || !this.#store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not writable.');
    return db;
  }

  /* ---------- Reading ---------- */

  #template(id: string): McpBuiltinTemplate {
    const t = this.#registry.get(id);
    if (!t) throw new AppError('NOT_FOUND', 'There is no such built-in server.');
    return t;
  }

  #rows(templateId?: string): InstanceRow[] {
    const db = this.#store.db;
    if (!db) return [];
    const sql = `SELECT * FROM mcp_builtin_instances ${templateId ? 'WHERE template_id = ?' : ''} ORDER BY added_at, name`;
    return (templateId ? db.prepare(sql).all(templateId) : db.prepare(sql).all()) as unknown as InstanceRow[];
  }

  #view(row: InstanceRow, template: McpBuiltinTemplate): McpBuiltinAdded {
    const servers = JSON.parse(row.servers) as Record<string, string>;
    const pool = this.#store.db!.prepare('SELECT name FROM pools WHERE id = ?').get(row.pool_id) as { name: string } | undefined;
    return {
      id: row.id,
      name: row.name,
      poolId: row.pool_id,
      poolName: pool?.name ?? '',
      entries: Object.values(servers),
      auth: row.auth,
      params: JSON.parse(row.params) as Record<string, string>,
      servers: Object.keys(servers),
      secretNames: JSON.parse(row.secret_names) as Record<string, string>,
      allowPrivateNetwork: row.allow_private_network === 1,
      templateVersion: row.template_version,
      updateAvailable: row.template_version < template.version,
      addedAt: row.added_at,
    };
  }

  /** Every template with the instances made from it (the set of an instance that was deleted took its row with it). */
  list(): McpBuiltinItem[] {
    const rows = this.#rows();
    return this.#registry.list().map((template) => ({
      template: structuredClone(template),
      added: rows.filter((r) => r.template_id === template.id).map((r) => this.#view(r, template)),
    }));
  }

  /* ---------- Checking a request ---------- */

  /** Names of Secrets & env secrets that hold a value, in any set: what "exists" means for a token slot (PRD B1-3). */
  #heldSecretNames(): Set<string> {
    const out = new Set<string>();
    try {
      for (const pool of this.#pools.list('secrets')) {
        for (const e of (pool.content as SecretsContent | null)?.entries ?? []) if (e.kind === 'secret' && e.secret?.stored && !e.secret.revokedAt) out.add(e.name);
      }
    } catch {
      // Secrets & env isn't registered (a bare test): nothing exists yet.
    }
    return out;
  }

  async #plan(template: McpBuiltinTemplate, req: Partial<McpBuiltinAddRequest>): Promise<Plan> {
    if (!isObject(req)) throw invalid('auth', 'Describe what to add.');
    const auth = req.auth;
    if (auth !== 'oauth' && auth !== 'token') throw invalid('auth', 'Pick OAuth or Token.');
    if (!template.auth.includes(auth)) throw invalid('auth', `${template.name} doesn’t offer ${auth === 'oauth' ? 'OAuth' : 'a token'}.`);

    const given = req.params === undefined ? {} : req.params;
    if (!isObject(given)) throw invalid('params', 'Values are an object.');
    for (const key of Object.keys(given)) if (!template.params.some((p) => p.key === key)) throw invalid(`params.${key}`, 'Not a setting of this server.');
    const params: Record<string, string> = {};
    for (const p of paramsFor(template, auth)) {
      const raw = given[p.key];
      const value = paramValue(p, raw === undefined || raw === null || raw === '' ? (p.default ?? '') : raw);
      if (value) params[p.key] = value;
      else if (p.required) throw invalid(`params.${p.key}`, 'Fill this in.');
    }

    const wanted = req.servers === undefined ? null : req.servers;
    if (wanted !== null && (!Array.isArray(wanted) || wanted.some((k) => typeof k !== 'string'))) throw invalid('servers', 'Servers are a list of keys.');
    const offered = serversFor(template, auth);
    // Changing an instance without saying which servers keeps the ones it has (those the template and the mode still offer); a new one gets the defaults.
    const had = req.instance === undefined ? [] : Object.keys(JSON.parse(this.#rows(template.id).find((r) => r.id === req.instance)?.servers ?? '{}') as Record<string, string>);
    const kept = offered.filter((s) => had.includes(s.key));
    const chosen =
      wanted === null
        ? kept.length
          ? kept
          : offered.filter((s) => s.default)
        : [...new Set(wanted)].map((key) => {
            const server = template.servers.find((s) => s.key === key);
            if (!server) throw invalid('servers', `${key} is not a server of ${template.name}.`);
            if (!offered.includes(server)) throw invalid('servers', `${server.name} isn’t offered with ${auth === 'oauth' ? 'OAuth' : 'a token'}.`);
            return server;
          });
    if (!chosen.length) throw invalid('servers', 'Pick at least one server.');
    const allowPrivateNetwork = req.allowPrivateNetwork === true;

    // The catalog's own parse, URL rules and SSRF guard, per server, so an Add can't make what a manual entry couldn't.
    const servers: PlannedServer[] = [];
    for (const server of chosen) {
      // Claude Code rejects an http:// metadata URL when it loads the config, and the server would silently be missing: say it here.
      const meta = auth === 'oauth' ? server.oauth?.authServerMetadataUrl : undefined;
      if (meta && !/^https:\/\//i.test(fill(meta, params))) {
        const holder = placeholdersOf(meta)[0];
        const label = template.params.find((p) => p.key === holder)?.label;
        throw invalid(holder ? `params.${holder}` : 'servers', `${label ?? 'The address'} must be https for OAuth.`);
      }
      try {
        const checked = await this.#catalog.check('remote', serverSpec(server, auth, params, allowPrivateNetwork), serverSlots(server, auth));
        servers.push({ server, ...checked });
      } catch (e) {
        throw this.#rekey(e, template, server, chosen.length > 1);
      }
    }
    const fingerprint = createHash('sha256')
      .update(canonical({ t: template.id, a: auth, p: sortedObject(params), s: servers.map((s) => s.server.key).sort(), x: allowPrivateNetwork }))
      .digest('hex')
      .slice(0, 32);
    return { template, auth, params, servers, allowPrivateNetwork, fingerprint };
  }

  /** A failure in a server's URL or OAuth fields belongs to the param that made it, which is where the dialog can show it. */
  #rekey(e: unknown, template: McpBuiltinTemplate, server: McpBuiltinServer, several: boolean): unknown {
    if (!isAppError(e) || e.code !== 'VALIDATION_FAILED') return e;
    const failed = Object.keys((e.details ?? {}) as Record<string, string>)[0] ?? '';
    const holder =
      failed === 'spec.url'
        ? placeholdersOf(server.url)[0]
        : failed === 'spec.oauth.authServerMetadataUrl'
          ? placeholdersOf(server.oauth?.authServerMetadataUrl ?? '')[0]
          : failed === 'spec.oauth.clientId'
            ? server.oauth?.clientIdParam
            : undefined;
    const message = several ? `${server.name}: ${e.message}` : e.message;
    const key = holder && template.params.some((p) => p.key === holder) ? `params.${holder}` : 'servers';
    return new AppError('VALIDATION_FAILED', message, { details: { [key]: message } });
  }

  /** Which instance a request means, and the label and secret names it gets (PRD FR8, FR10). */
  #target(plan: Plan, req: Partial<McpBuiltinAddRequest>): Target {
    const { template } = plan;
    const rows = this.#rows(template.id);
    let row: InstanceRow | null = null;
    let label: string | null = null;
    if (req.instance !== undefined) {
      row = rows.find((r) => r.id === req.instance) ?? null;
      if (!row) throw new AppError('NOT_FOUND', 'That instance no longer exists.');
      label = row.name;
    } else if (req.name !== undefined && req.name !== '') {
      if (typeof req.name !== 'string' || !INSTANCE_NAME.test(req.name) || req.name.length > MCP_BUILTIN_NAME_MAX)
        throw invalid('name', `Use lowercase letters, digits and dashes, at most ${MCP_BUILTIN_NAME_MAX} characters.`);
      label = req.name;
      row = rows.find((r) => r.name === label) ?? null;
    } else {
      row = rows.find((r) => r.fingerprint === plan.fingerprint) ?? null;
      label = row ? row.name : this.#freshLabel(plan, rows);
    }
    return { row, label, secretNames: this.#secretNames(plan, row, req.secretNames) };
  }

  /** The first label whose entry keys are free of anything that isn't a built-in: '', then 2, 3, … */
  #freshLabel(plan: Plan, rows: InstanceRow[]): string {
    for (let n = 1; n <= MAX_AUTO_LABEL; n++) {
      const label = n === 1 ? '' : String(n);
      if (rows.some((r) => r.name === label)) continue;
      if (plan.servers.every((s) => this.#keyFree(entryKeyFor(s.server.key, label)))) return label;
    }
    throw new AppError('CONFLICT', 'Give this one a name: the default names are taken.', { details: { name: 'Pick a name.' } });
  }

  /** A key nothing uses, or one a built-in entry already holds (it is reused). */
  #keyFree(key: string): boolean {
    const entry = this.#catalog.findByKey(key);
    return !entry || this.#isBuiltIn(entry.id);
  }

  /** Whether the catalog entry came from the built-in catalogue: an instance holds it, or every version carries its note. */
  #isBuiltIn(entryId: string): boolean {
    const held = this.#rows().some((r) => Object.values(JSON.parse(r.servers) as Record<string, string>).includes(entryId));
    if (held) return true;
    const versions = this.#catalog.versionsOf(entryId);
    return versions.length > 0 && versions.every((v) => v.row.review_note?.startsWith(NOTE_PREFIX));
  }

  /** Token slot → Secrets & env name: the suggested one, then what the instance had, then what the request gives. */
  #secretNames(plan: Plan, row: InstanceRow | null, input: unknown): Record<string, string> {
    if (plan.auth !== 'token') return {};
    const slots = [...new Set(plan.servers.flatMap((s) => (s.server.token ? [s.server.token.slot] : [])))];
    const had = row ? (JSON.parse(row.secret_names) as Record<string, string>) : {};
    const out: Record<string, string> = Object.fromEntries(slots.map((slot) => [slot, had[slot] ?? slot]));
    if (input === undefined) return out;
    if (!isObject(input)) throw invalid('secretNames', 'Names are an object.');
    for (const [slot, name] of Object.entries(input)) {
      if (!slots.includes(slot)) throw invalid(`secretNames.${slot}`, 'This server has no such token.');
      if (typeof name !== 'string' || !SECRET_NAME.test(name)) throw invalid(`secretNames.${slot}`, 'Use a Secrets & env name: letters, digits, dots, dashes and underscores.');
      out[slot] = name;
    }
    return out;
  }

  /**
   * What the catalog holds for each planned server, read without changing anything, so a refusal comes before the first write
   * (preview shows it too). A definition that exists as a revoked or deprecated version is never recreated (PRD FR9): that is the
   * admin's decision, not Add's to undo; one that waits as a draft is the reviewer's to approve, not Add's.
   */
  #assess(plan: Plan, target: Target): Assessment[] {
    const owned = target.row ? (JSON.parse(target.row.servers) as Record<string, string>) : {};
    return plan.servers.map((planned) => {
      const entryKey = entryKeyFor(planned.server.key, target.label);
      const ownedId = owned[planned.server.key];
      const existing = ownedId ? { id: ownedId } : this.#catalog.findByKey(entryKey);
      if (!existing) return { kind: 'new' };
      if (!ownedId && !this.#isBuiltIn(existing.id))
        throw new AppError('CONFLICT', `The catalog already has an entry “${entryKey}” that didn’t come from the built-in catalogue. Pick another name.`, { details: { name: 'Pick a name.' } });
      const wanted = canonical({ spec: planned.spec, slots: planned.slots });
      const same = this.#catalog.versionsOf(existing.id).find((v) => canonical({ spec: v.spec, slots: v.slots }) === wanted);
      if (!same) return { kind: 'version', entryId: existing.id };
      const shown = `${same.entry.display_name} ${same.row.version}`;
      if (same.row.review_state === 'approved') return { kind: 'reuse', entryId: existing.id, version: same.row.version };
      if (same.row.review_state === 'draft') throw new AppError('CONFLICT', `${shown} is waiting for review in the catalog: approve or delete it first.`);
      throw new AppError('CONFLICT', `${shown} was ${same.row.review_state} in the catalog, so Add won’t bring it back. Review it there.`);
    });
  }

  #action(plan: Plan, target: Target, assessments: Assessment[]): 'create' | 'update' | 'unchanged' {
    const { row } = target;
    if (!row) return 'create';
    const same =
      row.fingerprint === plan.fingerprint &&
      row.template_version === plan.template.version &&
      canonical(sortedObject(JSON.parse(row.secret_names) as Record<string, string>)) === canonical(sortedObject(target.secretNames)) &&
      assessments.every((a) => a.kind === 'reuse');
    return same ? 'unchanged' : 'update';
  }

  /** Changes nothing: what Add would make, with the exact URLs (PRD FR4: this is what the person consents to). */
  async preview(templateId: string, req: Partial<McpBuiltinAddRequest>): Promise<McpBuiltinPreview> {
    const template = this.#template(templateId);
    const plan = await this.#plan(template, req);
    const target = this.#target(plan, req);
    const action = this.#action(plan, target, this.#assess(plan, target));
    const held = this.#heldSecretNames();
    return {
      servers: plan.servers.map((s) => ({
        key: s.server.key,
        name: s.server.name,
        url: s.spec.url ?? '',
        transport: s.spec.transport ?? 'http',
        auth: s.spec.auth ?? 'none',
        headers: s.slots.filter((x) => x.target === 'header').map((x) => x.name),
        oauth: s.spec.oauth ?? null,
        flags: s.flags,
      })),
      secretNames: Object.entries(target.secretNames).map(([slot, name]) => ({ slot, name, exists: held.has(name) })),
      setName: target.row ? this.#poolName(target.row.pool_id) : this.#freeSetName(setNameFor(template, target.label)),
      action,
      instance: target.row?.id ?? null,
    };
  }

  /* ---------- Adding and updating ---------- */

  /** Add: make the instance, change it, or find it unchanged (PRD FR8, FR11). */
  add(templateId: string, req: Partial<McpBuiltinAddRequest>): Promise<McpBuiltinAddResult> {
    const run = this.#queue.then(() => this.#add(templateId, req));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #add(templateId: string, req: Partial<McpBuiltinAddRequest>): Promise<McpBuiltinAddResult> {
    const template = this.#template(templateId);
    const plan = await this.#plan(template, req);
    const target = this.#target(plan, req);
    const assessments = this.#assess(plan, target);
    if (this.#action(plan, target, assessments) === 'unchanged' && target.row) return { ...this.#view(target.row, template), result: 'unchanged' };

    const note = REVIEWER_NOTE(template.version);
    const owned = target.row ? (JSON.parse(target.row.servers) as Record<string, string>) : {};
    // Entries first: each is created, reused, or gets a version that is approved the same way (nothing is delivered until the set points at it).
    const made: Made[] = [];
    for (const [i, planned] of plan.servers.entries()) made.push(await this.#perform(planned, assessments[i]!, target.label, note));

    const entries = Object.fromEntries(made.map((m) => [m.key, m.entryId]));
    const now = new Date().toISOString();
    let row: InstanceRow;
    let result: 'created' | 'updated';
    if (target.row) {
      const current = this.#pools.get(target.row.pool_id).content as McpSetContent | null;
      this.#pools.update(target.row.pool_id, { content: this.#content(plan, target, made, current, Object.keys(owned)), note });
      this.#db
        .prepare(
          `UPDATE mcp_builtin_instances SET template_version = ?, auth = ?, params = ?, servers = ?, secret_names = ?, allow_private_network = ?, fingerprint = ?, updated_at = ? WHERE id = ?`,
        )
        .run(template.version, plan.auth, JSON.stringify(plan.params), JSON.stringify(entries), JSON.stringify(target.secretNames), plan.allowPrivateNetwork ? 1 : 0, plan.fingerprint, now, target.row.id);
      row = this.#rows(template.id).find((r) => r.id === target.row!.id)!;
      result = 'updated';
    } else {
      const pool = this.#pools.create('mcpset', {
        name: this.#freeSetName(setNameFor(template, target.label)),
        description: template.summary,
        content: { ...this.#content(plan, target, made, null, []), slug: this.#freeSlug(template, target.label) },
        note,
      });
      const id = newId();
      try {
        this.#db
          .prepare(
            `INSERT INTO mcp_builtin_instances (id, template_id, template_version, name, auth, params, servers, secret_names, allow_private_network, fingerprint, pool_id, added_at, added_by, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, template.id, template.version, target.label, plan.auth, JSON.stringify(plan.params), JSON.stringify(entries), JSON.stringify(target.secretNames), plan.allowPrivateNetwork ? 1 : 0, plan.fingerprint, pool.id, now, ADDED_BY, now);
      } catch (e) {
        this.#pools.delete(pool.id);
        throw e;
      }
      row = this.#rows(template.id).find((r) => r.id === id)!;
      result = 'created';
    }
    this.#catalog.event(result === 'created' ? 'builtin_added' : 'builtin_updated', { ...(made[0] ? { entryId: made[0].entryId } : {}) }, {
      template: template.id,
      templateVersion: template.version,
      auth: plan.auth,
      instance: row.id,
      name: target.label,
      pool: row.pool_id,
      servers: made.map((m) => ({ key: m.key, entry: m.entryId, version: m.version })),
    });
    this.#catalog.onChange();
    return { ...this.#view(row, template), result };
  }

  /** The catalog writes for one server: its entry made, or a new version added; each approved by "Admin" with the built-in note. */
  async #perform(planned: PlannedServer, assessment: Assessment, label: string, note: string): Promise<Made> {
    const key = planned.server.key;
    if (assessment.kind === 'reuse') return { key, entryId: assessment.entryId, version: assessment.version };
    if (assessment.kind === 'new') {
      const entry = await this.#catalog.create({
        key: entryKeyFor(key, label),
        displayName: entryNameFor(planned.server, label),
        description: planned.server.description,
        kind: 'remote',
        spec: planned.spec,
        slots: planned.slots,
      });
      const version = entry.versions[0]!;
      this.#catalog.approve(entry.id, version.id, { reviewed: true, note });
      return { key, entryId: entry.id, version: version.version };
    }
    const entry = await this.#catalog.addVersion(assessment.entryId, { spec: planned.spec, slots: planned.slots });
    const version = entry.versions[0]!;
    this.#catalog.approve(entry.id, version.id, { reviewed: true, note });
    return { key, entryId: assessment.entryId, version: version.version };
  }

  /** The set's content: the instance's servers on their entries' versions, other servers of the set left as they are. */
  #content(plan: Plan, target: Target, made: Made[], current: McpSetContent | null, ownedKeys: string[]): McpSetContent {
    const owned = new Set([...ownedKeys, ...made.map((m) => m.key)]);
    const mine: McpSetServer[] = plan.servers.map((planned, i) => {
      const m = made[i]!;
      const was = current?.servers.find((s) => s.key === m.key);
      const token = planned.server.token;
      return {
        key: m.key,
        entry: m.entryId,
        version: m.version,
        enabled: was?.enabled ?? true,
        config: {},
        secrets: token && plan.auth === 'token' ? { [token.header]: secretFileRef(target.secretNames[token.slot] ?? token.slot) } : {},
      };
    });
    const others = (current?.servers ?? []).filter((s) => !owned.has(s.key));
    return { slug: current?.slug ?? '', servers: [...mine, ...others] };
  }

  /* ---------- Names ---------- */

  #poolName(poolId: string): string {
    return (this.#store.db!.prepare('SELECT name FROM pools WHERE id = ?').get(poolId) as { name: string } | undefined)?.name ?? '';
  }

  /** The set name, with ` (2)`, ` (3)` … when another set of any origin has it (pool names are unique per type). */
  #freeSetName(base: string): string {
    const taken = new Set(this.#pools.list('mcpset').map((p) => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; n < 100; n++) {
      const name = `${base.slice(0, 60 - ` (${n})`.length)} (${n})`;
      if (!taken.has(name.toLowerCase())) return name;
    }
    throw new AppError('CONFLICT', 'Give this one a name: the default set names are taken.', { details: { name: 'Pick a name.' } });
  }

  /** A set ID no other set uses: `gitea`, `gitea-2` … (at most 12 characters, fixed once delivered). */
  #freeSlug(template: McpBuiltinTemplate, label: string): string {
    const taken = new Set(this.#pools.list('mcpset').map((p) => (p.content as McpSetContent | null)?.slug));
    const base = slugFrom(label ? `${template.id}-${label}` : template.id);
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const suffix = `-${n}`;
      const slug = `${base.slice(0, 12 - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!taken.has(slug)) return slug;
    }
    throw new AppError('CONFLICT', 'Give this one a name: the default set IDs are taken.', { details: { name: 'Pick a name.' } });
  }
}
