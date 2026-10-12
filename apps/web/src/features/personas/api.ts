import {
  PERSONAS_API,
  type PersonaIdentity,
  type PersonaPoolInfo,
  type PersonaPolicy,
  type PersonaProposal,
  type PersonaProposalStatus,
  type PersonaContent,
  type ContextContent,
  type WorkspacePersona,
} from '@portal/contracts';
import { poolRequest } from '@/features/pools/request';

export interface PersonaRevision {
  revision: number;
  status: string;
  note: string;
  createdAt: string;
  current: boolean;
}

export interface PersonaRevisionContent<C = PersonaContent | ContextContent> extends PersonaRevision {
  content: C;
}

/** The persona routes (`/api/personas`); the pools themselves go through the shared pool API. */
export const personasApi = {
  /** What a workspace's persona is, and the contexts it gets (assigned or held by the persona). */
  workspace: (workspaceId: string) => poolRequest<WorkspacePersona>('GET', PERSONAS_API.workspace(workspaceId)),
  /** Every workspace's persona name and avatar at once, for lists. */
  identities: () => poolRequest<Record<string, PersonaIdentity>>('GET', PERSONAS_API.identities),
  /** What each persona's card shows: avatar, default flag, proposals waiting. */
  pools: () => poolRequest<PersonaPoolInfo[]>('GET', PERSONAS_API.pools),
  /** The persona new workspaces start with. */
  default: () => poolRequest<{ poolId: string | null }>('GET', PERSONAS_API.default),
  setDefault: (poolId: string | null) => poolRequest<{ poolId: string | null }>('PUT', PERSONAS_API.default, { poolId }),
  policy: (poolId: string) => poolRequest<PersonaPolicy>('GET', PERSONAS_API.policy(poolId)),
  setPolicy: (poolId: string, body: { agentsMayPropose?: boolean; autoApproveCosmetic?: boolean }) => poolRequest<PersonaPolicy>('PUT', PERSONAS_API.policy(poolId), body),
  /** The raw bytes of an image: the portal re-encodes it and keeps its own PNG. */
  setAvatar: (poolId: string, file: Blob) => poolRequest<{ avatar: string }>('POST', PERSONAS_API.avatarOf(poolId), undefined, { body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } }),
  clearAvatar: (poolId: string) => poolRequest<{ avatar: null }>('DELETE', PERSONAS_API.avatarOf(poolId)),
  proposals: (opts: { pool?: string; status?: PersonaProposalStatus } = {}) => {
    const q = new URLSearchParams();
    if (opts.pool) q.set('pool', opts.pool);
    if (opts.status) q.set('status', opts.status);
    return poolRequest<PersonaProposal[]>('GET', `${PERSONAS_API.proposals}${q.size ? `?${q}` : ''}`);
  },
  decide: (id: string, verb: 'approve' | 'reject') => poolRequest<PersonaProposal>('POST', PERSONAS_API.decide(id, verb)),
  revisions: (poolId: string) => poolRequest<PersonaRevision[]>('GET', PERSONAS_API.revisions(poolId)),
  revision: <C = PersonaContent | ContextContent>(poolId: string, revision: number) => poolRequest<PersonaRevisionContent<C>>('GET', PERSONAS_API.revision(poolId, revision)),
};
