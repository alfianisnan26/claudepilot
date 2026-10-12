// Who owns what, for the platform track (notifications, triggers, auto transfer): ONE adapter over the authorization seam
// (apps/server/src/authz/seam.ts, PLAN-10). Nothing else in the track reads a cookie, names a user id or decides a right: it asks this.
//
// Today the seam is single-owner (the founding user `u_owner` owns everything), so this answers what the portal always did. When the real
// authorization layer lands (`useAuthz`), this file keeps working unchanged: it only calls the seam. Tests inject their own `PlatformOwner`
// (two fake users) to prove that user B never sees, hears of or answers user A's things.

import type { Context } from 'hono';
import { actorString, actorUserId, isUserId, objectRef, platformRef, type Actor, type ObjectRef, type NotifySubject, type Verb } from '@portal/contracts';
import { actorOf, can, canUser, isPlatformAdmin, ownersOf, usersWith } from '../authz/seam.js';

/** Who is asking an HTTP request, as the platform's routes use it. */
export interface PlatformActor {
  /** The seam's actor, to pass down. */
  actor: Actor;
  /** The user whose rights apply; null for anonymous (never reaches a guarded route). */
  userId: string | null;
  /** A platform admin (the founding user today). */
  admin: boolean;
  /** How the actor is written into an audit row or an `actor` column (`user:<id>`, ...). */
  label: string;
}

export interface PlatformOwner {
  actorOf(c: Context): PlatformActor;
  /** The users who own what an event is about: who hears of it. */
  ownersOf(subject: NotifySubject): string[];
  /** Users who hold at least `view` on it without owning it (a share): told only where a destination opted in. */
  sharersOf(subject: NotifySubject): string[];
  /** The decision, for code that holds a user id (routing at delivery, an answer arriving). */
  can(userId: string, verb: Verb, subject: NotifySubject): boolean;
  /** A user that is disabled, pending or gone hears nothing and answers nothing. */
  userEnabled(userId: string): boolean;
  isAdmin(userId: string): boolean;
}

/** The authorization object a notification subject stands for. */
export function subjectRef(s: NotifySubject): ObjectRef {
  switch (s.type) {
    case 'session':
      return objectRef('session', s.id);
    case 'ticket':
      return objectRef('ticket', s.id);
    case 'ci_run':
      return objectRef('ci_run', s.id);
    case 'claude':
      return objectRef('claude', s.id);
    case 'workspace':
      return objectRef('workspace', s.id);
    case 'trigger':
    case 'trigger_run': // a run is its trigger's: N3 names the trigger in `audience`, and the run id resolves through the trigger's resolver
      return objectRef('trigger', s.id);
    case 'budget':
      return objectRef('budget', s.id);
    case 'portal':
    default:
      return platformRef('notifications');
  }
}

/** The default: the seam, whatever implementation it has. */
export const seamOwner: PlatformOwner = {
  actorOf(c) {
    const actor = actorOf(c);
    const userId = actorUserId(actor);
    return { actor, userId, admin: !!userId && isPlatformAdmin(userId), label: actorString(actor) };
  },
  ownersOf: (subject) => ownersOf(subjectRef(subject)),
  sharersOf(subject) {
    const ref = subjectRef(subject);
    const owners = new Set(ownersOf(ref));
    return usersWith(ref, 'view').filter((u) => !owners.has(u));
  },
  can: (userId, verb, subject) => isUserId(userId) && canUser(userId, verb, subjectRef(subject)),
  userEnabled(userId) {
    if (!isUserId(userId)) return false;
    const d = can({ kind: 'job', userId, job: 'notify' }, 'view', objectRef('user', userId));
    return d.allow || (d.reason !== 'actor_disabled' && d.reason !== 'owner_disabled');
  },
  isAdmin: (userId) => isUserId(userId) && isPlatformAdmin(userId),
};
