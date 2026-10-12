// What a workspace is called, checked in one place. A target or a name ends up in Docker API URLs, tmux session names, shell words and
// database rows, so one that is not plain (a slash, `..`, `?`, a control character, a space) is not a workspace (QA-029, QA-032).
// New code that takes a workspace id from a person or an agent uses `isWorkspaceId`; it does not write its own pattern.

import { AppError } from '@isnanme/core';

/** A target or a name: one plain segment, 1 to 63 characters, starting with a letter or digit. */
export const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** `<target>/<name>`, each a plain name: the id a workspace has in the API, the database and the runtimes. */
export const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export const isWorkspaceId = (value: unknown): value is string => typeof value === 'string' && WORKSPACE_ID.test(value);

/**
 * For the runtimes, whatever called them: a name that is not plain is a workspace that does not exist, so it is never put into a Docker
 * URL, a Kubernetes label selector or a command. (A plain name needs no encoding; nothing else gets this far.)
 */
export function plainName(name: string): string {
  if (!PLAIN_NAME.test(name)) throw new AppError('NOT_FOUND', 'That workspace doesn’t exist.');
  return name;
}
