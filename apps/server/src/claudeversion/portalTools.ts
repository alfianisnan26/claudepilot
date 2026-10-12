// Claude Code versions over the Portal MCP (docs/prd/claude-version-pinning.md FR15): `claude_versions` reads what each workspace runs next to what it is
// pinned to, the default pin, the candidate and the canary's verdict; `claude_minimums` reads the feature-minimum registry. Both are reads (no tool here
// upgrades, builds or rolls back: that is a person's action in the portal). A workspace's own text never appears: ids, versions and fixed words only.

import { AppError } from '@isnanme/core';
import { claudeBelowMinimum, isExactClaudeVersion } from '@portal/contracts';
import { actorOfPrincipal } from '../authz/seam.js';
import { portalTools, z, type ToolRegistry } from '../portalmcp/registry.js';
import type { ClaudeVersions } from './service.js';

export function registerClaudeVersionTools(svc: ClaudeVersions, registry: ToolRegistry = portalTools): void {
  registry.register({
    name: 'claude_versions',
    title: 'Claude Code versions',
    description:
      'The Claude Code version of each workspace: what its image is pinned to, what it really runs (read inside it, with the time), what looks wrong (the two differ, a feature needs a newer version, the updater is on, the version was never tested), the default pin new workspaces get, the newest version the npm registry offers and what the compatibility canary found (which behaviours the portal relies on pass or fail on the installed version and on that newest one). Versions are exact x.y.z. Read only: upgrades, builds and rollbacks are a person’s action in the portal.',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({ workspace_id: z.string().max(120).optional().describe('One workspace, as <target>/<name>. Default: every workspace.') }),
    async handler(ctx, args) {
      const actor = actorOfPrincipal(ctx.principal);
      const [overview, infos] = await Promise.all([svc.overview(actor), svc.infos(actor)]);
      let rows = Object.values(infos);
      if (args.workspace_id) {
        ctx.assertWorkspace(args.workspace_id);
        rows = rows.filter((i) => i.workspaceId === args.workspace_id);
        if (!rows.length) throw new AppError('NOT_FOUND', 'No such workspace.');
      }
      const r = overview.report;
      return {
        summary: `${rows.length} workspace(s); default pin ${overview.defaultVersion}; candidate ${r.candidateInfo.version ?? 'unavailable'}${r.breaks.length ? `, which fails ${r.breaks.join(', ')}` : ''}; ${overview.warnings.length} warning(s).`,
        default_version: overview.defaultVersion,
        installed: overview.installed,
        candidate: { status: r.candidateInfo.status, version: r.candidateInfo.version, channels: r.candidateInfo.channels, checked_at: r.candidateInfo.checkedAt, reason: r.candidateInfo.reason },
        canary: {
          schedule_days: overview.schedule.everyDays,
          last_at: overview.schedule.lastAt,
          next_at: overview.schedule.nextAt,
          running: overview.schedule.running,
          candidate_breaks: r.breaks,
          items: r.items.map((i) => ({ check: i.id, label: i.label, installed: i.installed, candidate: i.candidate })),
        },
        workspaces: rows.map((i) => ({
          workspace_id: i.workspaceId,
          pinned: i.pinned,
          running: i.running,
          checked_at: i.checkedAt,
          image: i.imageTag,
          auto_update: i.autoUpdate,
          flags: i.flags,
          below_minimum: i.belowMinimum.map((b) => ({ feature: b.feature, needs: b.needs })),
          tested: i.tested,
          can_recreate: i.canRecreate,
        })),
        warnings: overview.warnings.map((w) => ({ id: w.id, kind: w.kind, severity: w.severity, title: w.title, workspace_id: w.workspaceId, version: w.version })),
      };
    },
  });

  registry.register({
    name: 'claude_minimums',
    title: 'Claude Code minimum versions',
    description:
      'The minimum Claude Code version each portal feature needs (pool delivery, the MCP lockdown, MCP sets, skillsets, the browser, plan usage, MCP sign-in, chat, personas, the update pin), how each minimum is known (observed on a real version, or documented by the vendor), what breaks below it and what the portal does then. With a version, also lists the features that version is below. One registry, shared by the portal’s checks and its pages.',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({ version: z.string().max(40).optional().describe('An exact x.y.z: list the features it is below.') }),
    async handler(_ctx, args) {
      if (args.version !== undefined && !isExactClaudeVersion(args.version)) throw new AppError('VALIDATION_FAILED', 'Use an exact version such as 2.1.296.');
      const below = args.version ? claudeBelowMinimum(args.version) : null;
      return {
        summary: args.version ? `${args.version} is below ${below!.length} feature minimum(s).` : `${svc.features().length} features with a minimum version.`,
        features: svc.features().map((f) => ({ id: f.id, label: f.label, needs: f.needs, basis: f.basis, observed_on: f.observedOn, enforced: f.enforced, why: f.why, degrades: f.degrades, source: f.source })),
        ...(below ? { below: below.map((b) => ({ feature: b.feature, needs: b.needs, enforced: b.enforced })) } : {}),
      };
    },
  });
}
