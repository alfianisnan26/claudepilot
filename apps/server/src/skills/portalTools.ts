import { AppError } from '@isnanme/core';
import { SKILL_PROPOSAL_LIMITS } from '@portal/contracts';
import { PortalToolError, portalTools, z, type PortalToolContext, type ToolRegistry } from '../portalmcp/registry.js';
import { uiLink } from '../portalmcp/tools/common.js';
import type { SkillsModule } from './module.js';

// The skill tools of the Portal MCP (Skillset FR-P, interfaces I2 and I11). A session proposes a new skill, or a
// changed one, for ITS OWN workspace; the workspace comes from the token (`ctx.workspaceId`), never from an argument,
// so an agent can't aim a proposal at another workspace. A proposal is an unreviewed library version: nothing here
// approves, publishes or delivers anything, and no skillset accepts a version a person has not approved. Skills are
// code-like, so there is no switch that lets one through on its own.

export interface SkillToolDeps {
  /** The portal-wide setting "Agents may propose changes" (Settings, default off). It gates a session's proposals, not an admin token's. */
  agentSelfEdit: () => boolean;
}

/** A failure of the proposal service as the tool error a caller can act on. */
function asToolError(e: unknown): never {
  if (e instanceof AppError) throw new PortalToolError(e.code, e.message, e.details);
  throw e;
}

/** The workspace a proposal is for: an agent's own (verified from its token); an admin's token names one or none. */
function workspaceOf(ctx: PortalToolContext, named: string | undefined): string | null {
  if (ctx.isAgent) {
    if (!ctx.workspaceId) throw new PortalToolError('FORBIDDEN', 'This session is not bound to a workspace.');
    if (named && named !== ctx.workspaceId) throw new PortalToolError('FORBIDDEN', 'A session proposes skills for its own workspace only.');
    return ctx.workspaceId;
  }
  if (!named) return null;
  ctx.assertWorkspace(named);
  return named;
}

export function registerSkillTools(skills: SkillsModule, deps: SkillToolDeps, registry: ToolRegistry = portalTools): void {
  const register = registry.register.bind(registry);
  const proposals = skills.proposals;

  register({
    name: 'skill_propose',
    title: 'Propose a skill',
    description:
      'Proposes a new skill, or a changed version of one, for this workspace. It is saved as a draft that a person must review and approve in the portal before any workspace can get it. You give the name, a description of when to use it, and the instructions; the portal writes the frontmatter itself. Never include a secret value.',
    scope: 'agent',
    // A proposal fills a review queue: a looping or injected agent is stopped early (the queue is capped per proposer and per workspace, too).
    rate: { perHour: 10 },
    maxArgsBytes: SKILL_PROPOSAL_LIMITS.totalBytes + 8 * 1024,
    input: z.object({
      name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, digits and single dashes.').describe('The skill’s folder name, e.g. code-review.'),
      description: z.string().min(1).max(SKILL_PROPOSAL_LIMITS.descriptionChars).describe('What it does and when to use it: this is what the model reads to decide.'),
      body: z.string().min(1).max(SKILL_PROPOSAL_LIMITS.skillMdBytes).describe('The instructions (the body of SKILL.md), without frontmatter.'),
      files: z
        .array(
          z
            .object({
              path: z.string().min(1).max(200).describe('A short relative path, e.g. scripts/check.sh or references/style.md.'),
              content: z.string().max(SKILL_PROPOSAL_LIMITS.fileBytes),
              executable: z.boolean().optional().describe('For a script a person will review and may run.'),
            })
            .strict(),
        )
        .max(SKILL_PROPOSAL_LIMITS.files)
        .optional()
        .describe('Extra text files: scripts and references. A reviewer reads every one.'),
      replaces: z.string().max(64).optional().describe('The name of the existing skill this changes, if any.'),
      reason: z.string().max(SKILL_PROPOSAL_LIMITS.reasonChars).optional().describe('Why it is wanted, in a sentence or two. The reviewer reads it as plain text.'),
      workspace: z.string().max(200).optional().describe('Only for an administrator’s token: the workspace it is for. A session’s is its own.'),
    }),
    handler(ctx, args) {
      if (ctx.isAgent && !deps.agentSelfEdit())
        throw new PortalToolError('FORBIDDEN', 'Agents may not propose changes right now: the setting is off in the portal. A person adds skills in the portal (Pools → Skills).');
      const workspaceId = workspaceOf(ctx, args.workspace);
      try {
        const r = proposals.propose(ctx.actor, workspaceId, { name: args.name, description: args.description, body: args.body, files: args.files, reason: args.reason, replaces: args.replaces });
        if (workspaceId) ctx.affected(`workspace:${workspaceId}`);
        const waiting = r.status === 'waiting_review';
        return {
          summary: r.duplicate
            ? waiting
              ? `This exact skill is already waiting for review.`
              : `This exact skill already exists and was ${r.status === 'approved' ? 'approved' : r.status}.`
            : `Proposed ${r.name}: waiting for a person to review it.`,
          proposal: { version_id: r.versionId, name: r.name, status: r.status, duplicate: r.duplicate, runs_scripts: r.scripted, risk: r.risk, review_path: r.reviewPath, review_url: uiLink(r.reviewPath) },
          note: 'It is a draft. A person must read it and approve it in the portal, and put it in a skillset assigned to the workspace, before any session can use it.',
        };
      } catch (e) {
        asToolError(e);
      }
    },
  });

  register({
    name: 'skill_proposals_list',
    title: 'List skill proposals',
    description: 'Skill proposals for this workspace and what a person decided about each: waiting for review, approved, rejected or revoked. An administrator’s token sees every workspace’s.',
    scope: 'agent',
    hints: { readOnly: true },
    input: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    handler(ctx, args) {
      if (ctx.isAgent && !ctx.workspaceId) throw new PortalToolError('FORBIDDEN', 'This session is not bound to a workspace.');
      const rows = proposals.list({ workspaceId: ctx.isAgent ? ctx.workspaceId : null, limit: args.limit ?? 20 });
      return {
        summary: rows.length ? `${rows.length} proposal${rows.length === 1 ? '' : 's'}, ${rows.filter((r) => r.state === 'needs_review').length} waiting for review.` : 'No skill proposals.',
        proposals: rows.map((r) => ({
          version_id: r.versionId,
          name: r.name,
          status: r.state === 'needs_review' ? 'waiting_review' : r.state,
          // What the proposer wrote, labelled as data: another session may have proposed it.
          reason: ctx.untrusted(r.reason, 'agent', 600),
          replaces: r.replaces,
          ...(ctx.isAgent ? {} : { workspace: r.workspaceId }),
          proposed_at: r.at,
          review_path: `/admin/pools/skills/review/${r.versionId}`,
        })),
      };
    },
  });
}
