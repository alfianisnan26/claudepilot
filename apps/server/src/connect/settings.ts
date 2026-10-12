// Portal-wide Connect settings (docs/prd/targets-connect.md §14 `connect_settings`, §15 `GET`/`PUT /api/connect/settings`): the address targets use,
// the default token lifetime, the default target, the scanned targets a person hid, and the tombstones of removed nodes. Small values, one table.

import { AppError } from '@isnanme/core';
import {
  CONNECT_TOKEN_TTL_MINUTES,
  connectOriginProblem,
  type ConnectSettings,
  type UpdateConnectSettingsRequest,
} from '@portal/contracts';
import type { ConnectConfig } from './config.js';
import type { ConnectEvents } from './events.js';
import type { ConnectStore } from './store.js';

const KEYS = { publicUrl: 'public_url', ttl: 'token_ttl_minutes', defaultTarget: 'default_target', hidden: 'hidden_scanned', removedNodes: 'removed_nodes' } as const;

/** How long a removed target's nodes are remembered, so an agent that comes back is told "target removed" and not "unknown node". */
const TOMBSTONE_DAYS = 14;
const TOMBSTONES_MAX = 500;

interface Tombstone {
  node: string;
  target: string;
  at: string;
}

/** What the settings need to know about the rest of the module. */
export interface SettingsDeps {
  /** Whether `id` names a target (enrolled or scanned): a default must be one. */
  knownTarget(id: string): boolean;
  /** The agent bundle this portal serves (T2's constants). */
  bundle(): { build: string; version: string };
}

export class ConnectSettingsStore {
  constructor(
    private readonly store: ConnectStore,
    private readonly config: ConnectConfig,
    private readonly events: ConnectEvents,
    private readonly deps: SettingsDeps,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The address targets use for the portal when the operator or the admin set one: the environment first, then the setting. */
  publicUrl(): { url: string; source: 'env' | 'setting' } | null {
    if (this.config.url) return { url: this.config.url.replace(/\/+$/, ''), source: 'env' };
    const s = this.store.setting(KEYS.publicUrl);
    return s ? { url: s, source: 'setting' } : null;
  }

  tokenTtlMinutes(): number {
    const n = Number(this.store.setting(KEYS.ttl));
    return Number.isInteger(n) && n >= 1 && n <= CONNECT_TOKEN_TTL_MINUTES.max ? n : this.config.tokenTtlMin;
  }

  defaultTarget(): string | null {
    return this.store.setting(KEYS.defaultTarget);
  }

  get(): ConnectSettings {
    const pub = this.publicUrl();
    const bundle = this.deps.bundle();
    return {
      publicUrl: pub?.url ?? null,
      publicUrlSource: pub?.source ?? null,
      allowHttp: this.config.allowHttp,
      caConfigured: !!this.config.caFile,
      tokenTtlMinutes: this.tokenTtlMinutes(),
      defaultTarget: this.defaultTarget(),
      workspaceImage: this.config.workspaceImage,
      agentBuild: bundle.build,
      agentVersion: bundle.version,
    };
  }

  update(req: UpdateConnectSettingsRequest, actor: string, ip: string | null): ConnectSettings {
    if (!req || typeof req !== 'object') throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
    const changed: string[] = [];
    const details: Record<string, string> = {};
    let publicUrl: string | null | undefined;
    if (req.publicUrl !== undefined) {
      if (this.config.url) throw new AppError('CONFLICT', 'The address is set by PORTAL_CONNECT_URL; change it there.', { details: { publicUrl: 'Set in the environment.' } });
      if (req.publicUrl === null || req.publicUrl === '') publicUrl = null;
      else if (typeof req.publicUrl !== 'string') details.publicUrl = 'An address, or null.';
      else {
        const url = req.publicUrl.trim().replace(/\/+$/, '');
        const problem = connectOriginProblem(url, this.config.allowHttp);
        if (problem) details.publicUrl = problem;
        else publicUrl = url;
      }
    }
    let ttl: number | undefined;
    if (req.tokenTtlMinutes !== undefined) {
      if (!Number.isInteger(req.tokenTtlMinutes) || req.tokenTtlMinutes < 1 || req.tokenTtlMinutes > CONNECT_TOKEN_TTL_MINUTES.max) details.tokenTtlMinutes = `A whole number of minutes, 1 to ${CONNECT_TOKEN_TTL_MINUTES.max}.`;
      else ttl = req.tokenTtlMinutes;
    }
    let target: string | null | undefined;
    if (req.defaultTarget !== undefined) {
      if (req.defaultTarget === null || req.defaultTarget === '') target = null;
      else if (typeof req.defaultTarget !== 'string' || !this.deps.knownTarget(req.defaultTarget)) details.defaultTarget = 'No such target.';
      else target = req.defaultTarget;
    }
    if (Object.keys(details).length) throw new AppError('VALIDATION_FAILED', 'Some settings can’t be used.', { details });

    this.store.tx(() => {
      if (publicUrl !== undefined) (this.store.putSetting(KEYS.publicUrl, publicUrl), changed.push('publicUrl'));
      if (ttl !== undefined) (this.store.putSetting(KEYS.ttl, String(ttl)), changed.push('tokenTtlMinutes'));
      if (target !== undefined) (this.store.putSetting(KEYS.defaultTarget, target), changed.push('defaultTarget'));
      if (changed.length) this.events.record({ type: 'settings.changed', actor, ip, detail: { changed: changed.join(',') } });
    });
    return this.get();
  }

  /** Sets or clears the default target (a target PATCH with `default`). Does not check that it exists: the caller did. */
  setDefaultTarget(id: string | null): void {
    this.store.putSetting(KEYS.defaultTarget, id);
  }

  // ---- scanned targets a person hid ----------------------------------------------------------------------------------------------

  hiddenScanned(): string[] {
    try {
      const v: unknown = JSON.parse(this.store.setting(KEYS.hidden) ?? '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  setHidden(id: string, hidden: boolean): void {
    const set = new Set(this.hiddenScanned());
    if (hidden) set.add(id);
    else set.delete(id);
    this.store.putSetting(KEYS.hidden, JSON.stringify([...set].slice(0, 100)));
  }

  // ---- nodes of removed targets --------------------------------------------------------------------------------------------------

  private tombstones(): Tombstone[] {
    try {
      const v: unknown = JSON.parse(this.store.setting(KEYS.removedNodes) ?? '[]');
      return Array.isArray(v) ? (v as Tombstone[]).filter((t) => t && typeof t.node === 'string' && typeof t.target === 'string' && typeof t.at === 'string') : [];
    } catch {
      return [];
    }
  }

  /** Remembers the nodes of a target that is being removed (call it before the rows go). */
  addTombstones(targetId: string, nodeIds: string[]): void {
    if (!nodeIds.length) return;
    const at = this.now().toISOString();
    const cutoff = new Date(this.now().getTime() - TOMBSTONE_DAYS * 86_400_000).toISOString();
    const keep = this.tombstones().filter((t) => t.at >= cutoff);
    keep.push(...nodeIds.map((node) => ({ node, target: targetId, at })));
    this.store.putSetting(KEYS.removedNodes, JSON.stringify(keep.slice(-TOMBSTONES_MAX)));
  }

  /** The target a node belonged to when that target was removed, or null when it is simply unknown. */
  removedNode(nodeId: string): string | null {
    return this.tombstones().find((t) => t.node === nodeId)?.target ?? null;
  }
}
