import { AppError, newId } from '@isnanme/core';
import {
  CLAUDE_CREDENTIAL_MESSAGE,
  SECRET_CREDENTIAL_LABEL,
  SECRET_ENTRY_NAME,
  SECRET_LIMITS,
  SECRET_VARIABLE_NAME,
  SECRETS_DIR,
  SECRETS_ENV_SH,
  hasClaudeCredential,
  secretCredentialType,
  secretFilePath,
  secretVariableReserved,
  type SecretEntryView,
  type SecretOptions,
  type SecretsContent as SecretsContentView,
  type WorkspaceSecrets,
} from '@portal/contracts';
import { CompileError } from '../delivery/compile.js';
import { mayUseEnv } from '../delivery/ownership.js';
import { parsePending } from '../delivery/pending.js';
import { NODE, ROOT, type DeliveredFile, type Fragment } from '../delivery/types.js';
import type { AssignedPool, KindContext, MultiPoolType, ParseContext, PoolKind } from '../pools/kinds.js';
import type { References, ReferencingPool, SecretName, SecretNameSource } from '../pools/references.js';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import { denyRules, placeholder, renderEnvSh, type ShellVariable } from './render.js';
import { exposureRef, SecretValues } from './values.js';

/** A secret field → the `secret_values` version current when the revision was made; null while it needs one. */
type ValueIds = Record<string, string | null>;

/** One entry as a revision stores it (PRD §9). Never a secret value or ciphertext: only value IDs (A8). */
export interface StoredEntry {
  id: string;
  kind: 'variable' | 'secret';
  name: string;
  /** Variables: the plain value. */
  value?: string;
  /** Variables: a credential-looking value the admin chose to keep plain (FR6). */
  confirmed?: true;
  /** Secrets: `{ value: id }`. Tool logins (S2) hold one ID per secret field. */
  values?: ValueIds;
  options?: SecretOptions;
}

/** A secret set's revision content. */
export interface SecretsContent {
  entries: StoredEntry[];
}

/**
 * Pointers' safe values once removed (FR13): the tool's default home path where it has one, so the tool
 * falls back to the user's own login rather than to nothing; every other name falls back to `""`. Tool
 * logins (S2) deliver these pointers; until then no set can (FR4 reserves them).
 */
const POINTER_SAFE_VALUES: Record<string, string> = {
  GH_CONFIG_DIR: '/home/node/.config/gh',
  DOCKER_CONFIG: '/home/node/.docker',
  KUBECONFIG: '/home/node/.kube/config',
  AWS_SHARED_CREDENTIALS_FILE: '/home/node/.aws/credentials',
  AWS_CONFIG_FILE: '/home/node/.aws/config',
};

const VALUE_FIELD = 'value';
const FILES_DIR = `${SECRETS_DIR}/files`;

const TYPE_LABEL: Record<MultiPoolType, string> = { mcpset: 'MCP set', skillset: 'Skillset', secrets: 'Secret set' };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const kb = (n: number) => `${Math.ceil(n / 1024)} KB`;
const quoteList = (names: string[]) => names.map((n) => `“${n}”`).join(', ');
const pools = (list: ReferencingPool[]) => [...new Map(list.map((p) => [p.poolId, `${TYPE_LABEL[p.type]} “${p.poolName}”`])).values()].join(', ');

/** Why a variable name can't be used here (FR4): the pool's own list, then the env registry (A2). */
function reserved(name: string): string | null {
  return secretVariableReserved(name) ?? (mayUseEnv('secrets', name) ? null : 'Another part of the portal sets this name.');
}

/**
 * The names an entry takes in a workspace (FR9, FR21): its own name, and its path variable. One namespace
 * for everything, so `{{secret-file:NAME}}` and `${NAME}` never mean two different entries.
 */
function claims(e: StoredEntry): string[] {
  return e.kind === 'secret' && e.options?.pathVariable ? [e.name, e.options.pathVariable] : [e.name];
}

/** A secret value as typed or uploaded: a one-line value loses the newline a paste brings along. */
function cleanSecret(raw: string): string {
  const one = raw.replace(/\r?\n$/, '');
  return /[\r\n]/.test(one) ? raw : one;
}

/**
 * Secrets & env (secrets-env-pool PRD, milestone S1): sets of plain variables and secrets, assigned to
 * many workspaces, several per workspace. Secret values live in `secret_values` as encrypted versions and
 * never come back out of the API. Delivery (§10.1): secrets as files under `/etc/claudepilot/secrets/files/`,
 * variables and exposed secrets in the drop-in's `env` (live for Claude Code) and in `env.sh` for shells,
 * deny rules for Claude's own reads (A1), tombstones for removed names (A6). Also the place other pools
 * resolve secret names (FR21–FR23), through the shared References.
 */
export class SecretsKind implements PoolKind<SecretsContent>, SecretNameSource {
  readonly type = 'secrets' as const;
  readonly values: SecretValues;

  constructor(
    private readonly store: Store,
    private readonly service: Pick<PoolService, 'assignedPools'>,
    private readonly references: References,
  ) {
    this.values = new SecretValues(store);
    references.provideSecretNames(this);
  }

  /* ---------- Content ---------- */

  parse(input: unknown, prev: SecretsContent | null, ctx?: ParseContext): SecretsContent {
    const poolId = ctx?.poolId ?? '';
    const raw = isObject(input) ? input.entries : undefined;
    if (raw !== undefined && !Array.isArray(raw)) throw invalid('entries', 'Send the list of entries.');
    const list = (raw ?? []) as unknown[];
    if (list.length > SECRET_LIMITS.entries) throw invalid('entries', `Use at most ${SECRET_LIMITS.entries} entries.`);

    const before = new Map((prev?.entries ?? []).map((e) => [e.id, e]));
    const errors: Record<string, string> = {};
    const fail = (field: string, message: string) => void (errors[field] ??= message);
    const entries: StoredEntry[] = [];
    const fresh: { entry: StoredEntry; value: string }[] = [];
    const ids = new Set<string>();
    const taken = new Map<string, string>(); // name → the field that claimed it first
    let size = 0;

    list.forEach((item, i) => {
      const at = `entries.${i}`;
      if (!isObject(item)) return fail(at, 'Each entry needs a kind and a name.');
      const kind = item.kind;
      if (kind !== 'variable' && kind !== 'secret') return fail(`${at}.kind`, 'Pick Variable or Secret.');
      const was = typeof item.id === 'string' ? before.get(item.id) : undefined;
      const id = was && !ids.has(was.id) ? was.id : newId();
      ids.add(id);
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const claim = (n: string, field: string) => {
        if (taken.has(n)) return fail(field, `“${n}” is already used in this set.`);
        taken.set(n, field);
      };

      if (kind === 'variable') {
        if (!name) return fail(`${at}.name`, 'Give it a name.');
        if (!SECRET_VARIABLE_NAME.test(name)) return fail(`${at}.name`, 'Letters, digits and _, not starting with a digit.');
        const why = reserved(name);
        if (why) return fail(`${at}.name`, `${name} is reserved. ${why}`);
        const value = typeof item.value === 'string' ? item.value : '';
        if (bytes(value) > SECRET_LIMITS.variableBytes) return fail(`${at}.value`, `Use at most ${kb(SECRET_LIMITS.variableBytes)}.`);
        if (/[\r\n\0]/.test(value)) return fail(`${at}.value`, 'A variable is one line. Make it a secret to deliver a file.');
        if (hasClaudeCredential(value)) return fail(`${at}.value`, CLAUDE_CREDENTIAL_MESSAGE);
        const looks = secretCredentialType(value);
        if (looks && item.confirmed !== true)
          return fail(`${at}.value`, `This looks like a ${SECRET_CREDENTIAL_LABEL[looks]}. Make it a secret, or confirm it stays a plain variable.`);
        claim(name, `${at}.name`);
        size += bytes(name) + bytes(value);
        entries.push({ id, kind, name, value, ...(looks ? { confirmed: true as const } : {}) });
        return;
      }

      if (!name) return fail(`${at}.name`, 'Give it a name.');
      if (!SECRET_ENTRY_NAME.test(name)) return fail(`${at}.name`, 'Letters, digits, ., _ and -, starting with a letter or digit.');
      const o = isObject(item.options) ? item.options : {};
      const options: SecretOptions = {};
      const pathVariable = typeof o.pathVariable === 'string' ? o.pathVariable.trim() : '';
      if (pathVariable) {
        if (!SECRET_VARIABLE_NAME.test(pathVariable)) return fail(`${at}.pathVariable`, 'Letters, digits and _, not starting with a digit.');
        const why = reserved(pathVariable);
        if (why) return fail(`${at}.pathVariable`, `${pathVariable} is reserved. ${why}`);
        options.pathVariable = pathVariable;
      }
      if (o.expose === true) {
        if (!SECRET_VARIABLE_NAME.test(name)) return fail(`${at}.name`, 'To expose it as a variable, use letters, digits and _ only.');
        const why = reserved(name);
        if (why) return fail(`${at}.name`, `${name} is reserved as a variable. ${why}`);
        options.expose = true;
        if (o.terminals === true) options.terminals = true;
      }
      if (o.ownerOnly === true) options.ownerOnly = true;
      claim(name, `${at}.name`);
      if (options.pathVariable) claim(options.pathVariable, `${at}.pathVariable`);

      const entry: StoredEntry = { id, kind, name, values: { [VALUE_FIELD]: null }, ...(Object.keys(options).length ? { options } : {}) };
      if (typeof item.newValue === 'string' && item.newValue !== '') {
        const value = cleanSecret(item.newValue);
        if (bytes(value) > SECRET_LIMITS.secretBytes) return fail(`${at}.newValue`, `Use at most ${kb(SECRET_LIMITS.secretBytes)}.`);
        if (value.includes('\0')) return fail(`${at}.newValue`, 'Binary files aren’t supported: use text, such as base64.');
        if (hasClaudeCredential(value)) return fail(`${at}.newValue`, CLAUDE_CREDENTIAL_MESSAGE);
        fresh.push({ entry, value });
        size += bytes(value);
      } else {
        // The current value carries over, unless it belongs to another set (a duplicate starts empty, FR10).
        const current = was?.kind === 'secret' ? (was.values?.[VALUE_FIELD] ?? null) : null;
        if (current && this.values.belongsTo(current, poolId)) {
          entry.values![VALUE_FIELD] = current;
          size += this.values.info(current)?.length ?? 0;
        }
      }
      size += bytes(name);
      entries.push(entry);
    });

    const first = Object.values(errors)[0];
    if (first) throw new AppError('VALIDATION_FAILED', first, { details: errors });
    if (size > SECRET_LIMITS.workspaceBytes)
      throw invalid('entries', `This set holds about ${kb(size)}; a workspace can take ${kb(SECRET_LIMITS.workspaceBytes)} from its sets.`);

    const content: SecretsContent = { entries };
    if (poolId) {
      this.#checkReferences(prev, content);
      this.#checkWorkspaces(poolId, content);
    }
    // Only now, with everything checked: each new value becomes the entry's next version.
    for (const { entry, value } of fresh) entry.values![VALUE_FIELD] = this.values.add(poolId, entry.id, VALUE_FIELD, value);
    return content;
  }

  view(content: SecretsContent): SecretsContentView {
    return {
      entries: content.entries.map((e): SecretEntryView => {
        if (e.kind === 'variable') return { id: e.id, kind: e.kind, name: e.name, value: e.value ?? '', ...(e.confirmed ? { confirmed: true } : {}) };
        const valueId = e.values?.[VALUE_FIELD] ?? null;
        return { id: e.id, kind: e.kind, name: e.name, options: { ...e.options }, secret: valueId ? this.values.info(valueId) : null };
      }),
    };
  }

  /**
   * FR23: renaming or removing an entry that another pool references is refused, as is a set losing a path
   * variable someone uses. (Whether one still resolves elsewhere is that pool's concern, FR22.)
   */
  #checkReferences(prev: SecretsContent | null, next: SecretsContent) {
    if (!prev) return;
    const kept = new Set(next.entries.flatMap(claims));
    for (const name of prev.entries.flatMap(claims)) {
      if (kept.has(name)) continue;
      const users = this.references.referencing(name);
      if (users.length)
        throw new AppError('CONFLICT', `${pools(users)} uses “${name}”. Change it there first, then rename or remove it here.`, { details: { entries: `“${name}” is in use.` } });
    }
  }

  /** FR9: a name the set now has may not clash with another set of a workspace that follows this one. */
  #checkWorkspaces(poolId: string, next: SecretsContent) {
    const rows = this.store.db!.prepare('SELECT workspace_id FROM assignments WHERE pool_id = ? AND pinned_revision IS NULL').all(poolId) as { workspace_id: string }[];
    const mine = new Set(next.entries.flatMap(claims));
    for (const { workspace_id: ws } of rows) {
      for (const other of this.service.assignedPools<SecretsContent>(ws, 'secrets')) {
        if (other.pool.id === poolId) continue;
        const clash = other.content.entries.flatMap(claims).filter((n) => mine.has(n));
        if (clash.length)
          throw new AppError('CONFLICT', `${quoteList(clash)} ${clash.length === 1 ? 'is' : 'are'} also in “${other.pool.name}”, which ${workspaceName(ws)} uses. Names must be unique across a workspace’s sets.`, {
            details: { entries: 'Names clash with another set.' },
          });
      }
    }
  }

  /* ---------- Assignment ---------- */

  /** FR9: refuses giving a workspace sets whose names clash (409), before anything is written. */
  beforeAssign(workspaceId: string, adding: string[], keeping: string[]): void {
    const kept = this.service.assignedPools<SecretsContent>(workspaceId, 'secrets').filter((a) => keeping.includes(a.pool.id) && !adding.includes(a.pool.id));
    const added = adding.flatMap((id) => {
      const row = this.store.db!.prepare(
        'SELECT p.name, r.content FROM pools p JOIN pool_revisions r ON r.pool_id = p.id AND r.revision = p.current_revision WHERE p.id = ?',
      ).get(id) as { name: string; content: string } | undefined;
      return row ? [{ name: row.name, content: JSON.parse(row.content) as SecretsContent }] : [];
    });
    const owner = new Map<string, string>();
    for (const set of [...kept.map((a) => ({ name: a.pool.name, content: a.content })), ...added]) {
      for (const n of new Set(set.content.entries.flatMap(claims))) {
        const other = owner.get(n);
        if (other) throw new AppError('CONFLICT', `“${n}” is in both “${other}” and “${set.name}”. Names must be unique across a workspace’s sets.`);
        owner.set(n, set.name);
      }
    }
  }

  /**
   * Deleting (workspace ''): refused while another pool references one of the set's names (FR19). Removing it
   * from a workspace: warns about names that pools there use and no other set there provides (FR23).
   */
  beforeUnassign(workspaceId: string, poolId: string): string[] {
    if (!workspaceId) {
      const rows = this.store.db!.prepare(
        `SELECT content FROM pool_revisions WHERE pool_id = ? AND (revision = (SELECT max(revision) FROM pool_revisions WHERE pool_id = ?)
           OR revision = (SELECT current_revision FROM pools WHERE id = ?))`,
      ).all(poolId, poolId, poolId) as { content: string }[];
      const names = [...new Set(rows.flatMap((r) => (JSON.parse(r.content) as SecretsContent).entries.flatMap(claims)))];
      const used = names.map((n) => ({ n, users: this.references.referencing(n) })).filter((u) => u.users.length);
      if (used.length)
        throw new AppError('CONFLICT', `${pools(used.flatMap((u) => u.users))} uses ${quoteList(used.map((u) => u.n))}. Change that first, then delete this set.`);
      return [];
    }
    const used = this.references.namesUsedBy(workspaceId);
    if (used.size === 0) return [];
    const assigned = this.service.assignedPools<SecretsContent>(workspaceId, 'secrets');
    const others = new Set(assigned.filter((a) => a.pool.id !== poolId).flatMap((a) => a.content.entries.flatMap(claims)));
    const leaving = assigned.find((a) => a.pool.id === poolId)?.content.entries.flatMap(claims) ?? [];
    const lost = leaving.filter((n) => used.has(n) && !others.has(n));
    if (!lost.length) return [];
    return [`${pools(lost.flatMap((n) => used.get(n) ?? []))} on ${workspaceName(workspaceId)} needs ${quoteList(lost)}, which no other set there provides.`];
  }

  /* ---------- Delivery ---------- */

  fragments(assigned: AssignedPool<SecretsContent>[], ctx: KindContext): Fragment[] {
    if (assigned.length === 0) return [];
    const env: Record<string, string> = {};
    const shell: ShellVariable[] = [];
    const owner = new Map<string, string>();
    const perPool: Fragment[] = [];
    let exposed = false;
    let size = 0;

    for (const a of assigned) {
      const files: DeliveredFile[] = [];
      for (const e of a.content.entries) {
        for (const n of claims(e)) {
          const other = owner.get(n);
          if (other) throw new CompileError('secrets', `“${n}” is in both “${other}” and “${a.pool.name}”. Remove it from one of them.`);
          owner.set(n, a.pool.name);
        }
        // A name another owner claimed after the set was saved fails this workspace's delivery, and only
        // here (FR4); what it has keeps working meanwhile.
        for (const n of [...(e.kind === 'variable' || e.options?.expose ? [e.name] : []), ...(e.options?.pathVariable ? [e.options.pathVariable] : [])]) {
          const why = reserved(n);
          if (why) throw new CompileError('secrets', `${n} in “${a.pool.name}” is reserved now. ${why}`);
        }
        if (e.kind === 'variable') {
          env[e.name] = e.value ?? '';
          shell.push({ name: e.name, value: e.value ?? '' });
          continue;
        }
        const valueId = e.values?.[VALUE_FIELD] ?? null;
        // Never given a value (a fresh duplicate, FR10): nothing to deliver yet, and nothing to take away.
        if (!valueId) continue;
        const info = this.values.info(valueId);
        let content: string;
        if (ctx.preview) content = placeholder(e.name, info);
        else {
          try {
            content = this.values.open(valueId);
          } catch (err) {
            // A value that was delivered and can't be opened now fails the delivery, so the workspace keeps
            // its last files (foundation §6.5) instead of losing the secret.
            throw new CompileError('secrets', `secret “${e.name}” in “${a.pool.name}”: ${(err as Error).message}`);
          }
        }
        const path = secretFilePath(e.name);
        const ownerOnly = !!e.options?.ownerOnly;
        files.push({ path, content, mode: ownerOnly ? 0o400 : 0o440, uid: ownerOnly ? NODE : ROOT, gid: NODE, secretRef: exposureRef(valueId) });
        size += bytes(content);
        if (e.options?.pathVariable) {
          env[e.options.pathVariable] = path;
          shell.push({ name: e.options.pathVariable, value: path });
        }
        if (e.options?.expose) {
          exposed = true;
          env[e.name] = content;
          if (e.options.terminals) shell.push({ name: e.name, file: path });
        }
      }
      // Each set is named in the manifest, so a set the database forgot freezes the workspace (§6.5).
      perPool.push({ owner: 'secrets', pool: { id: a.pool.id, revision: a.pool.revision }, files, checkReadable: true });
    }
    if (Object.keys(env).length === 0 && perPool.every((f) => !f.files?.length)) return perPool;

    const envSh = renderEnvSh(shell);
    const settings = { ...(Object.keys(env).length ? { env } : {}), permissions: { deny: denyRules(exposed) } };
    size += bytes(envSh) + bytes(JSON.stringify(settings));
    if (size > SECRET_LIMITS.workspaceBytes) throw new CompileError('secrets', `the sets deliver ${kb(size)} here; a workspace takes at most ${kb(SECRET_LIMITS.workspaceBytes)}.`);
    const shared: Fragment = {
      owner: 'secrets',
      dirs: [
        { path: SECRETS_DIR, mode: 0o750, uid: ROOT, gid: NODE },
        { path: FILES_DIR, mode: 0o750, uid: ROOT, gid: NODE },
      ],
      files: [{ path: SECRETS_ENV_SH, content: envSh, mode: 0o440, uid: ROOT, gid: NODE }],
      settings,
      // A removed name keeps a safe value while older sessions run (A6, FR13).
      envTombstones: { safeValues: Object.fromEntries(Object.keys(env).filter((n) => n in POINTER_SAFE_VALUES).map((n) => [n, POINTER_SAFE_VALUES[n]!])) },
      hooks: ['shell'],
      checkReadable: true,
    };
    return [shared, ...perPool];
  }

  /* ---------- References (FR21, FR22) ---------- */

  namesFor(workspaceId: string): Map<string, SecretName> {
    const out = new Map<string, SecretName>();
    for (const a of this.service.assignedPools<SecretsContent>(workspaceId, 'secrets')) {
      for (const e of a.content.entries) {
        if (e.kind === 'variable') {
          out.set(e.name, { kind: 'variable', file: false, variable: true });
          continue;
        }
        // A secret without a value isn't delivered, so nothing resolves to it.
        if (!e.values?.[VALUE_FIELD]) continue;
        out.set(e.name, { kind: 'secret', file: true, variable: !!e.options?.expose });
        if (e.options?.pathVariable) out.set(e.options.pathVariable, { kind: 'variable', file: false, variable: true });
      }
    }
    return out;
  }

  /* ---------- The workspace's Configuration row ---------- */

  /** What a workspace's sets deliver, by name only, and the variables still on their way out (A6). */
  workspaceView(workspaceId: string): WorkspaceSecrets {
    const sets = this.service.assignedPools<SecretsContent>(workspaceId, 'secrets').map((a) => {
      const secrets = a.content.entries.filter((e) => e.kind === 'secret');
      const valued = secrets.filter((e) => !!e.values?.[VALUE_FIELD]);
      return {
        poolId: a.pool.id,
        poolName: a.pool.name,
        revision: a.pool.revision,
        variables: a.content.entries.filter((e) => e.kind === 'variable').map((e) => e.name),
        files: valued.map((e) => e.name),
        exposed: valued.filter((e) => e.options?.expose).map((e) => e.name),
        pointers: valued.flatMap((e) => (e.options?.pathVariable ? [e.options.pathVariable] : [])),
        needsValue: secrets.filter((e) => !e.values?.[VALUE_FIELD]).map((e) => e.name),
      };
    });
    const row = this.store.db?.prepare('SELECT pending_deletes FROM workspace_delivery WHERE workspace_id = ?').get(workspaceId) as { pending_deletes: string } | undefined;
    const removing = parsePending(row?.pending_deletes)
      .tombstones.filter((t) => t.owner === 'secrets')
      .map((t) => t.name)
      .sort();
    return { workspaceId, sets, removing, exposesVariables: sets.some((s) => s.exposed.length > 0) };
  }
}

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const workspaceName = (id: string) => id.slice(id.indexOf('/') + 1);
