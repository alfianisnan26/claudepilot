// Workspace identity (T-42, docs/prd/targets-connect.md §24). An identity must not be a name: every workspace gets a stable opaque id
// (`ws_` and 12 hex digits) the first time the portal knows it, kept for good in `workspace_identities`, never changed, never reused (a
// removed workspace's row stays, marked removed) and never derived from the name. The old `<target>/<name>` is the workspace's ALIAS and
// resolves for ever, here, in one place: `resolve` takes either form.
//
// The runtime name (the Docker container, the Kubernetes Deployment; the home volume is `<runtimeName>-home`) is STORED here too, never
// recomputed from the name: a new workspace gets `ws-<12 hex>`; one that existed before is recorded with what its runtime reports it is
// called today (its list), so `kubernetes/kohi-event` keeps `ws-kohi-event` and its volume `ws-kohi-event-home`. The old derivation is
// kept in `legacyRuntimeName` for one case only: a workspace the runtime is asked about before the portal has a record of it.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeWorkspaceLabel, STABLE_WORKSPACE_ID, workspaceId, type Workspace } from '@portal/contracts';
import { PLAIN_NAME, WORKSPACE_ID } from '../names.js';
import type { RuntimeNames } from './runtime.js';
import { pinRefsOfRemoved } from './refRewrite.js';

/**
 * What a module that stores workspace references needs from the registry (T-42 slice 3): `storedRef` on save (the stable id), `keyOf` on
 * read (the `<target>/<name>` key the rest of the portal speaks), `storedForms` in a filter (every form a row may hold while the move runs).
 */
export interface WorkspaceRefs {
  storedRef(ref: string | null): string | null;
  keyOf(stored: string | null): string | null;
  storedForms(ref: string): string[];
}

export interface WorkspaceIdentity {
  /** `ws_` and 12 hex digits. */
  id: string;
  target: string;
  /** The name it was made with (the label, until names become labels of their own: T-42 slice 2). */
  name: string;
  /** `<target>/<name>`: the alias every older reference carries. */
  legacyId: string;
  /** What the runtime calls it; null until the runtime first lists it (a row the migration made). */
  runtimeName: string | null;
  /** The name shown (slice 2): null until a first rename, which is the name it was made with. Changing it changes nothing else. */
  label: string | null;
  createdAt: string;
  /** Set when the workspace was removed: its id is never given again, and its alias goes to whichever workspace holds the name now. */
  removedAt: string | null;
}

interface Row {
  id: string;
  target: string;
  name: string;
  legacy_id: string;
  runtime_name: string | null;
  label: string | null;
  created_at: string;
  removed_at: string | null;
}

/** How a form is looked up: `<target>/<name or label>`, case-insensitive (a label differing only in case is the same label). */
const formKey = (target: string, name: string) => workspaceId(target, name).normalize('NFC').toLowerCase();

/** The runtime name a new workspace gets: `ws-` and the 12 hex digits of its stable id (a DNS label: no underscore). */
export const newRuntimeName = (stableId: string) => `ws-${stableId.slice(3)}`;

/** The home volume (Docker) or claim (Kubernetes) of a workspace: its runtime name and `-home`. */
export const homeVolumeOf = (runtimeName: string) => `${runtimeName}-home`;

/**
 * What a workspace was named on its runtime before T-42, derived from its name. ONLY for a workspace the runtime is asked about before the
 * portal has a record of it (the record is made from what the runtime reports, which for those workspaces is exactly this).
 */
export function legacyRuntimeName(kind: 'docker' | 'kubernetes', name: string): string {
  return kind === 'docker' ? `claudepilot-${name}` : `ws-${name}`;
}

/**
 * The registry. Reads are from memory (loaded once), so a runtime can ask on every call; writes go through to the database when it is
 * writable. A portal whose database cannot be written (read-only, or no database at all) keeps what it learns in memory only.
 */
export class WorkspaceIdentities implements RuntimeNames, WorkspaceRefs {
  readonly #byId = new Map<string, WorkspaceIdentity>();
  /** The key alias (`<target>/<name it was made with>`) -> the live workspace that holds it: what runtimes and stored references use. */
  readonly #live = new Map<string, WorkspaceIdentity>();
  /**
   * Every form a live workspace answers to (`formKey`): its key alias, its label and every label it had (the aliases a rename leaves).
   * One workspace per form: what makes a label unique on its target.
   */
  readonly #forms = new Map<string, WorkspaceIdentity>();
  #loaded = false;

  constructor(
    private readonly store: { db: DatabaseSync | null; writable: boolean } | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A registry that keeps nothing (tests, and a manager made without one). */
  static memory(): WorkspaceIdentities {
    return new WorkspaceIdentities(null);
  }

  #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    const db = this.store?.db;
    if (!db) return;
    let rows: Row[] = [];
    let aliases: { alias: string; workspace_id: string }[] = [];
    try {
      rows = db.prepare('SELECT id, target, name, legacy_id, runtime_name, label, created_at, removed_at FROM workspace_identities ORDER BY created_at').all() as unknown as Row[];
      aliases = db.prepare('SELECT alias, workspace_id FROM workspace_aliases WHERE released_at IS NULL ORDER BY created_at').all() as unknown as typeof aliases;
    } catch (e) {
      console.error(`[workspaces] could not read workspace identities: ${(e as Error).message}`);
    }
    for (const r of rows) this.#remember({ id: r.id, target: r.target, name: r.name, legacyId: r.legacy_id, runtimeName: r.runtime_name, label: r.label ?? null, createdAt: r.created_at, removedAt: r.removed_at });
    for (const a of aliases) {
      const w = this.#byId.get(a.workspace_id);
      if (w && !w.removedAt && !this.#forms.has(a.alias.normalize('NFC').toLowerCase())) this.#forms.set(a.alias.normalize('NFC').toLowerCase(), w);
    }
  }

  #remember(w: WorkspaceIdentity) {
    this.#byId.set(w.id, w);
    if (!w.removedAt) {
      this.#live.set(w.legacyId, w);
      this.#forms.set(formKey(w.target, w.name), w);
      if (w.label) this.#forms.set(formKey(w.target, w.label), w);
      return;
    }
    if (this.#live.get(w.legacyId)?.id === w.id) this.#live.delete(w.legacyId);
    for (const [form, holder] of this.#forms) if (holder.id === w.id) this.#forms.delete(form);
  }

  #write(sql: string, ...args: (string | null)[]) {
    const db = this.store?.db;
    if (!db || !this.store?.writable) return;
    try {
      db.prepare(sql).run(...args);
    } catch (e) {
      console.error(`[workspaces] could not save a workspace identity: ${(e as Error).message}`);
    }
  }

  #newId(): string {
    for (;;) {
      const id = `ws_${randomBytes(6).toString('hex')}`;
      if (!this.#byId.has(id)) return id;
    }
  }

  #insert(target: string, name: string, runtimeName: string | null, id = this.#newId()): WorkspaceIdentity {
    const w: WorkspaceIdentity = { id, target, name, legacyId: workspaceId(target, name), runtimeName, label: null, createdAt: this.now().toISOString(), removedAt: null };
    this.#remember(w);
    this.#write('INSERT INTO workspace_identities (id, target, name, legacy_id, runtime_name, created_at) VALUES (?, ?, ?, ?, ?, ?)', w.id, w.target, w.name, w.legacyId, w.runtimeName, w.createdAt);
    return w;
  }

  /**
   * THE resolver: a stable id (`ws_…`) or an alias to the workspace's identity: `<target>/<name it was made with>`, `<target>/<label>`, or
   * `<target>/<any label it had>` (slice 2: every form it was ever called by keeps working while it lives). Null when it is none of these,
   * unknown, or removed. Callers decide authorization on what this returns (its `legacyId`, which the seam knows), never on the string given.
   */
  resolve(ref: string): WorkspaceIdentity | null {
    this.#load();
    if (typeof ref !== 'string' || ref.length > 200) return null;
    // Plain tests, not the type guards: a guard's false branch would leave `ref` typed as nothing.
    if (STABLE_WORKSPACE_ID.test(ref)) {
      const w = this.#byId.get(ref);
      return w && !w.removedAt ? w : null;
    }
    if (WORKSPACE_ID.test(ref) && this.#live.has(ref)) return this.#live.get(ref)!;
    const slash = ref.indexOf('/');
    if (slash <= 0) return null;
    return this.#forms.get(formKey(ref.slice(0, slash), normalizeWorkspaceLabel(ref.slice(slash + 1)))) ?? null;
  }

  /* ---------- Stored references (slice 3): written as the id, read as the key ---------- */

  /**
   * What a row should store for a workspace reference: the stable id when the reference resolves to a live workspace, else the reference as it
   * is (a workspace the portal has no record of, or none: null). Every converted module writes through this on save.
   */
  storedRef(ref: string | null): string | null {
    if (ref === null) return null;
    return this.resolve(ref)?.id ?? ref;
  }

  /**
   * The key (`<target>/<name>`) a stored reference stands for, which every runtime call and every unconverted module still speaks: a stable id
   * gives its workspace's key (a removed one's too, so history still reads); anything else is returned as it is (an old row: the alias).
   */
  keyOf(stored: string | null): string | null {
    if (stored === null || !STABLE_WORKSPACE_ID.test(stored)) return stored;
    this.#load();
    return this.#byId.get(stored)?.legacyId ?? stored;
  }

  /**
   * Every form a reference to this workspace may be stored under while the move runs: its key and its stable id. A filter matches either
   * (`IN (…)`). A key with no live workspace gives the key alone, so rows of a REMOVED workspace (stored with its id) never match a new
   * workspace that took its name.
   */
  storedForms(ref: string): string[] {
    const w = this.resolve(ref);
    return w ? [w.legacyId, w.id] : [ref];
  }

  /** `{ [<target>/<name>]: label }` for every live workspace that has a label of its own (was renamed). */
  labels(): Record<string, string> {
    this.#load();
    const out: Record<string, string> = {};
    for (const w of this.#live.values()) if (w.label) out[w.legacyId] = w.label;
    return out;
  }

  /** The live workspace on `target` that answers to `nameOrLabel` (its name, its label or a label it had), if any: who holds that name there. */
  holder(target: string, nameOrLabel: string): WorkspaceIdentity | null {
    this.#load();
    return this.#forms.get(formKey(target, normalizeWorkspaceLabel(nameOrLabel))) ?? null;
  }

  /**
   * Renames a workspace: its label only (slice 2). The id, the key alias, the runtime name and every stored reference stay. The new label also
   * becomes an alias (`<target>/<label>`), and the labels it had stay aliases, for as long as the workspace lives. The caller has checked the
   * label (`workspaceLabelProblem`) and that no other workspace on the target holds it (`holder`); one that does is refused here too.
   */
  relabel(id: string, label: string): WorkspaceIdentity {
    this.#load();
    const w = this.#byId.get(id);
    if (!w || w.removedAt) throw new Error('no such workspace');
    const clean = normalizeWorkspaceLabel(label);
    const form = formKey(w.target, clean);
    const other = this.#forms.get(form);
    if (other && other.id !== w.id) throw new Error('that name is taken on this target');
    w.label = clean === w.name ? null : clean;
    this.#write('UPDATE workspace_identities SET label = ? WHERE id = ?', w.label, w.id);
    if (!other) {
      this.#forms.set(form, w);
      this.#write('INSERT INTO workspace_aliases (alias, workspace_id, created_at) VALUES (?, ?, ?)', workspaceId(w.target, clean), w.id, this.now().toISOString());
    }
    return w;
  }

  /** The identity of the workspace that holds this name on this target now, if the portal has one. */
  of(target: string, name: string): WorkspaceIdentity | null {
    this.#load();
    return this.#live.get(workspaceId(target, name)) ?? null;
  }

  runtimeNameOf(target: string, name: string): string | undefined {
    return this.of(target, name)?.runtimeName ?? undefined;
  }

  /**
   * A workspace a runtime reports (a list): its identity, made now when the portal has none, and its runtime name filled in from what the
   * runtime says it is called when the record has none yet (a row the migration made). A runtime name on record is never replaced.
   */
  adopt(target: string, name: string, reported?: string): WorkspaceIdentity {
    const runtimeName = reported && PLAIN_NAME.test(reported) ? reported : null;
    const known = this.of(target, name);
    if (!known) return this.#insert(target, name, runtimeName);
    if (!known.runtimeName && runtimeName) {
      known.runtimeName = runtimeName;
      this.#write('UPDATE workspace_identities SET runtime_name = ? WHERE id = ? AND runtime_name IS NULL', runtimeName, known.id);
    }
    return known;
  }

  /**
   * A new workspace (a create): a new id and the runtime name `ws-<12 hex>`, or the one the target's runtime must use (`pick`, see
   * `Runtime.runtimeNameForNew`). The caller has checked the target has no workspace of that name, so a record still holding the name is a
   * workspace that is gone: it is marked removed first (its id is never given again).
   */
  allocate(target: string, name: string, pick?: (stableId: string) => string | undefined): WorkspaceIdentity {
    const stale = this.of(target, name);
    if (stale) this.retire(target, name);
    const id = this.#newId();
    const picked = pick?.(id);
    return this.#insert(target, name, picked && PLAIN_NAME.test(picked) ? picked : newRuntimeName(id), id);
  }

  /** The workspace was removed: its record stays (the id is never reused), the name is free for another. */
  retire(target: string, name: string): void {
    const w = this.of(target, name);
    if (!w) return;
    // Rows still holding its key (not yet rewritten) keep this workspace's id, not the name a later workspace may take (slice 3).
    const db = this.store?.db;
    if (db && this.store?.writable) pinRefsOfRemoved(db, w.legacyId, w.id);
    w.removedAt = this.now().toISOString();
    this.#remember(w);
    this.#write('UPDATE workspace_identities SET removed_at = ? WHERE id = ?', w.removedAt, w.id);
    // The labels it had are free for another workspace now; the rows stay, as history.
    this.#write('UPDATE workspace_aliases SET released_at = ? WHERE workspace_id = ? AND released_at IS NULL', w.removedAt, w.id);
  }
}

/**
 * One workspace out of a list by any form of its id: the stable id, the key alias `<target>/<name>`, or `<target>/<label>`; with `resolve`
 * (the manager's resolver) also a label it had before a rename. Null when none matches.
 */
export function findWorkspace(all: Workspace[], ref: string, resolve?: (ref: string) => { legacyId: string } | null): Workspace | null {
  const wanted = ref.trim();
  if (STABLE_WORKSPACE_ID.test(wanted)) return all.find((w) => w.stableId === wanted) ?? null;
  const direct = all.find((w) => w.id === wanted);
  if (direct) return direct;
  const slash = wanted.indexOf('/');
  if (slash <= 0) return null;
  const form = formKey(wanted.slice(0, slash), normalizeWorkspaceLabel(wanted.slice(slash + 1)));
  const labelled = all.find((w) => !!w.label && formKey(w.target, w.label) === form);
  if (labelled) return labelled;
  const known = resolve?.(wanted);
  return known ? (all.find((w) => w.id === known.legacyId) ?? null) : null;
}
