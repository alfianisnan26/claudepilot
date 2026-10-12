// Teams (docs/prd/teams.md): a group of users that can OWN objects and RECEIVE shares. A person creates teams, belongs to as many as they like,
// and is invited by username and must accept. A team has one or more OWNERS, who alone decide who may join; it can never be without one.
//
// Rights through a team (authz.ts evaluates them; these are the two numbers it uses):
// - an object a team OWNS: the team's owners hold `manage` on it, its members hold `operate`;
// - an object SHARED to a team at a level: every member holds that level on it while they are members (leaving the team ends it at once).
// A team is private: a person who is not a member (or an invitee) cannot see that it exists.

import type { Verb, TeamId } from './authz.js';
import type { UserSummary } from './identity.js';

export type TeamRole = 'owner' | 'member';

/** The level team-owned objects give. */
export const TEAM_OWNER_LEVEL: Verb = 'manage';
export const TEAM_MEMBER_LEVEL: Verb = 'operate';

export interface TeamSummary {
  id: TeamId;
  name: string;
  members: number;
  /** The signed-in person's role in it. */
  myRole: TeamRole;
}

export interface Team extends TeamSummary {
  description: string | null;
  createdAt: string;
  createdBy: UserSummary;
  /** Objects the team owns, by type: what must be moved before it can be deleted. Only for its owners. */
  owns?: Record<string, number>;
}

export interface TeamMember {
  user: UserSummary;
  role: TeamRole;
  joinedAt: string;
}

export type TeamInviteState = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';

export interface TeamInvite {
  id: string;
  team: { id: TeamId; name: string };
  invited: UserSummary;
  invitedBy: UserSummary;
  /** The role the person would get: `member`, or `owner` for a co-owner. */
  role: TeamRole;
  state: TeamInviteState;
  createdAt: string;
  expiresAt: string;
}

export interface CreateTeamRequest {
  name: string;
  description?: string;
}
export interface UpdateTeamRequest {
  name?: string;
  description?: string | null;
}

/** An owner invites a user by exact username. The invited person sees it under "Invitations" and accepts or declines. */
export interface InviteMemberRequest {
  username: string;
  role?: TeamRole;
}
export interface ChangeMemberRoleRequest {
  role: TeamRole;
}

export const TEAM_LIMITS = {
  nameMax: 40,
  descriptionMax: 200,
  maxMembers: 200,
  /** Teams one person may belong to (a guard against a flood, not a product limit). */
  maxTeamsPerUser: 50,
  /** Invitations an owner may send in a day, across teams. */
  invitesPerOwnerPerDay: 20,
  /** Pending invitations one person may hold at once, from all teams. */
  pendingPerInvitee: 10,
  inviteTtlDays: 14,
} as const;

export const TEAMS_API = {
  /** GET: my teams; POST: CreateTeamRequest -> Team (the creator is its first owner). */
  teams: '/api/teams',
  team: (id: TeamId) => `/api/teams/${id}`,
  members: (id: TeamId) => `/api/teams/${id}/members`,
  member: (id: TeamId, userId: string) => `/api/teams/${id}/members/${userId}`,
  /** GET (owners): the team's pending invitations; POST: InviteMemberRequest -> TeamInvite. */
  invites: (id: TeamId) => `/api/teams/${id}/invites`,
  invite: (id: TeamId, inviteId: string) => `/api/teams/${id}/invites/${inviteId}`,
  /** GET: the invitations addressed to me, across teams. */
  myInvites: '/api/teams/invites',
  accept: (inviteId: string) => `/api/teams/invites/${inviteId}/accept`,
  decline: (inviteId: string) => `/api/teams/invites/${inviteId}/decline`,
  /** DELETE: leave a team (refused for the last owner). */
  leave: (id: TeamId) => `/api/teams/${id}/leave`,
} as const;

export const TEAMS_ERROR_CODES = {
  /** The change would leave a team with no owner: promote another first (409). */
  TEAM_NEEDS_OWNER: 'TEAM_NEEDS_OWNER',
  /** A team that still owns objects cannot be deleted: move them first (409, `details.owns`). */
  TEAM_OWNS_OBJECTS: 'TEAM_OWNS_OBJECTS',
  /** A pending invitation for this person already exists, or they are a member (409). */
  TEAM_INVITE_EXISTS: 'TEAM_INVITE_EXISTS',
  TEAM_FULL: 'TEAM_FULL',
} as const;
export type TeamsErrorCode = (typeof TEAMS_ERROR_CODES)[keyof typeof TEAMS_ERROR_CODES];
