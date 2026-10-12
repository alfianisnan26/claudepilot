import { posix } from 'node:path';
import { AppError } from '@isnanme/core';
import { PERSONA_AVATAR, PERSONA_PROPOSAL_LIMITS, type PersonaProposal } from '@portal/contracts';
import { PortalToolError, portalTools, z, type PortalToolContext, type ToolRegistry } from '../portalmcp/registry.js';
import { normalizeAvatar } from './avatar.js';
import type { Personas } from './index.js';

// The persona tools of the Portal MCP (Persona PRD A10, interface I11). They are for agents only: a session reads
// and proposes changes to ITS OWN persona, the one its workspace has, and the workspace and session come from the
// token (`ctx.workspaceId`, `ctx.sessionId`), never from an argument, so there is nothing to name another persona
// with. Nothing here approves anything: a proposal waits for a person, except a name or an avatar when the persona's
// own switch says so, and instructions never go through on their own.

export interface PersonaToolDeps {
  /** A file of a workspace as the workspace user, or null when it isn't a plain file within `maxBytes` (index.ts reads it through the runtime). */
  readWorkspaceFile?: (workspaceId: string, path: string, maxBytes: number) => Promise<Buffer | null>;
  /** The bytes of a file this session links in the portal's blob store (an image it showed, an artifact), or null. */
  readSessionBlob?: (sessionId: string, blobId: string, maxBytes: number) => Buffer | null;
}

/** The session this call is, verified from its token. Admin tokens have none: personas are edited in the portal. */
function selfOf(ctx: PortalToolContext): { workspaceId: string; sessionId: string } {
  if (!ctx.isAgent || !ctx.workspaceId || !ctx.sessionId)
    throw new PortalToolError('FORBIDDEN', 'Only a session can use this tool: it works on the persona of the session’s own workspace. A person edits personas in the portal.');
  return { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId };
}

/** A failure of the proposal service as the tool error a caller can act on. */
function asToolError(e: unknown): never {
  if (e instanceof AppError) throw new PortalToolError(e.code, e.message, e.details);
  throw e;
}

const proposalView = (ctx: PortalToolContext, p: PersonaProposal) => ({
  id: p.id,
  kind: p.kind,
  status: p.status,
  ...(p.name ? { name: ctx.untrusted(p.name, 'agent', 120) } : {}),
  decided_by: p.decidedBy,
});

/** `~/avatar.png`, `avatar.png` or `/home/node/work/avatar.png` as an absolute path in the workspace user's home, or an error. */
export function homePath(raw: string, home = '/home/node'): string {
  let p = raw.trim();
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
  else if (!p.startsWith('/')) p = `${home}/${p}`;
  if (/[\0\r\n]/.test(p) || p.split('/').includes('..')) throw new PortalToolError('VALIDATION_FAILED', 'Use a plain path inside your home folder.');
  const norm = posix.normalize(p);
  if (!norm.startsWith(`${home}/`)) throw new PortalToolError('VALIDATION_FAILED', `Only files in ${home} can be read.`);
  return norm;
}

export function registerPersonaTools(personas: Personas, deps: PersonaToolDeps = {}, registry: ToolRegistry = portalTools): void {
  const register = registry.register.bind(registry);

  register({
    name: 'persona_get_self',
    title: 'Read my persona',
    description:
      'The persona this workspace runs: its name, instructions, styles, subagents and defaults, whether agents may propose changes to it, and your own proposals still waiting for a person to review them.',
    scope: 'agent',
    hints: { readOnly: true },
    input: z.object({}),
    handler(ctx) {
      const me = selfOf(ctx);
      const self = personas.proposals.getSelf(me);
      if (!self) return { summary: 'This workspace has no persona.', persona: null, proposals_allowed: false };
      const chars = self.instructions.length;
      return {
        summary: `${self.name}, revision ${self.revision}. ${self.allowed ? 'You may propose changes; a person reviews them.' : 'Proposals from agents are switched off for it.'}`,
        persona: {
          name: ctx.untrusted(self.name, 'persona', 120),
          description: ctx.untrusted(self.description, 'persona', 300),
          revision: self.revision,
          has_avatar: self.hasAvatar,
          instructions: ctx.untrusted(self.instructions, 'persona', 8_000),
          instructions_chars: chars,
          instructions_truncated: chars > 8_000,
          styles: self.styles,
          subagents: self.subagents,
          model: self.model,
          effort: self.effort,
        },
        proposals_allowed: self.allowed,
        auto_approves_name_and_avatar: self.autoApproves,
        your_pending_proposals: self.pending.map((p) => proposalView(ctx, p)),
      };
    },
  });

  register({
    name: 'persona_propose_update',
    title: 'Propose a change to my persona',
    description:
      'Proposes a new name and/or edits to the instructions of the persona this workspace runs, with your reason. Nothing changes until a person approves it in the portal; a name may be applied at once when the persona allows it, instructions never are. Edits are exact: `replace` swaps text that occurs once in the instructions, `append` adds text at the end.',
    scope: 'agent',
    hints: { readOnly: false, idempotent: true },
    rate: { perMinute: 5, perHour: PERSONA_PROPOSAL_LIMITS.perHour },
    maxArgsBytes: 24 * 1024,
    input: z.object({
      name: z.string().max(120).optional().describe('A new name for the persona, up to 60 characters.'),
      instructions_patch: z
        .object({
          append: z.string().max(8_192).optional().describe('Text added after the existing instructions.'),
          replace: z
            .array(z.object({ find: z.string().max(8_192).describe('Exact text in the instructions; it has to occur once.'), with: z.string().max(8_192).describe('What it becomes.') }))
            .max(PERSONA_PROPOSAL_LIMITS.edits)
            .optional(),
        })
        .optional()
        .describe(`Edits to the instructions: at most ${PERSONA_PROPOSAL_LIMITS.instructionsBytes / 1024} KB in all.`),
      reason: z.string().max(PERSONA_PROPOSAL_LIMITS.reasonChars + 100).describe('Why, in a sentence or two. A person reads it when deciding.'),
    }),
    handler(ctx, args) {
      const me = selfOf(ctx);
      try {
        const made = personas.proposals.proposeUpdate(me, { name: args.name, instructionsPatch: args.instructions_patch, reason: args.reason });
        ctx.affected(...made.map((m) => `persona-proposal:${m.proposal.id}`));
        const waiting = made.filter((m) => m.proposal.status === 'pending').length;
        return {
          summary: waiting ? `${waiting} proposal${waiting === 1 ? '' : 's'} waiting for a person to review.` : 'Applied: the persona allows it.',
          proposals: made.map((m) => ({ ...proposalView(ctx, m.proposal), duplicate: m.duplicate })),
        };
      } catch (e) {
        return asToolError(e);
      }
    },
  });

  register({
    name: 'persona_set_avatar_proposal',
    title: 'Propose an avatar for my persona',
    description:
      'Proposes an image as the avatar of the persona this workspace runs. Give a PNG, JPEG or WebP file in your home folder (`workspace_path`), a file of this session by `blob_id`, or a small image inline (`image_base64`). The portal re-encodes it as a square PNG of at most 512 pixels and drops everything else in the file. A person approves it in the portal; a persona may apply it at once when it allows that.',
    scope: 'agent',
    hints: { readOnly: false },
    rate: { perMinute: 6, perHour: PERSONA_PROPOSAL_LIMITS.perHour },
    maxArgsBytes: Math.ceil((PERSONA_AVATAR.inlineBytes * 4) / 3) + 4096,
    input: z.object({
      workspace_path: z.string().max(300).optional().describe('A PNG, JPEG or WebP file in your home folder, for example ~/avatar.png.'),
      blob_id: z.string().length(64).optional().describe('A file of this session the portal already holds, by its id.'),
      image_base64: z.string().max(Math.ceil((PERSONA_AVATAR.inlineBytes * 4) / 3) + 16).optional().describe('A small image inline, base64. Prefer workspace_path.'),
      reason: z.string().max(PERSONA_PROPOSAL_LIMITS.reasonChars + 100).describe('Why this image, in a sentence. A person reads it when deciding.'),
    }),
    async handler(ctx, args) {
      const me = selfOf(ctx);
      const sources = [args.workspace_path, args.blob_id, args.image_base64].filter((s) => s !== undefined).length;
      if (sources !== 1) throw new PortalToolError('VALIDATION_FAILED', 'Give exactly one image: workspace_path, blob_id or image_base64.');
      let bytes: Buffer | null = null;
      if (args.workspace_path !== undefined) {
        if (!deps.readWorkspaceFile) throw new PortalToolError('UNAVAILABLE', 'Files in this workspace can’t be read from here: send the image as image_base64.');
        bytes = await deps.readWorkspaceFile(me.workspaceId, homePath(args.workspace_path), PERSONA_AVATAR.inputBytes);
        if (!bytes) throw new PortalToolError('NOT_FOUND', 'No image at that path, or it isn’t a plain file of at most 3 MB.');
      } else if (args.blob_id !== undefined) {
        bytes = deps.readSessionBlob?.(me.sessionId, args.blob_id, PERSONA_AVATAR.inputBytes) ?? null;
        if (!bytes) throw new PortalToolError('NOT_FOUND', 'This session has no such file.');
      } else if (args.image_base64 !== undefined) {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(args.image_base64)) throw new PortalToolError('VALIDATION_FAILED', 'image_base64 isn’t base64.');
        bytes = Buffer.from(args.image_base64, 'base64');
        if (bytes.length > PERSONA_AVATAR.inlineBytes) throw new PortalToolError('VALIDATION_FAILED', `Inline images are at most ${PERSONA_AVATAR.inlineBytes / 1024} KB: put it in a file and use workspace_path.`);
      }
      try {
        const avatar = await normalizeAvatar(bytes!);
        const { proposal, duplicate } = personas.proposals.proposeAvatar(me, avatar, args.reason);
        ctx.affected(`persona-proposal:${proposal.id}`);
        return {
          summary: proposal.status === 'pending' ? 'Waiting for a person to review it.' : 'Applied: the persona allows it.',
          proposal: { ...proposalView(ctx, proposal), duplicate },
          image: { side: avatar.side, format: 'png' },
        };
      } catch (e) {
        return asToolError(e);
      }
    },
  });
}
