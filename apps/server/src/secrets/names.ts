import type { References } from '../pools/references.js';

/**
 * Local git and CI/CD (A5): whether a Secrets & env NAME reaches a workspace, so a pipeline that lists
 * `secrets: [NAME]` can be warned before it runs. Names and kinds only, never a value, and never a file's path.
 *
 * `asFile`: a file under the workspace's secrets folder holds the value (secrets, and a tool login's token),
 * readable by the workspace user. `asVariable`: the value is in Claude Code's managed `env`, so it reaches
 * Claude Code's own processes (variables, and secrets an agent may print) and not a pipeline runner's shell.
 * A name that neither is nor reaches the workspace is not in the list: ask `secretName`, which says `null`.
 */
export interface SecretNameInfo {
  name: string;
  /** `variable`, `secret`, or a tool login such as `github` or `npm`. */
  kind: string;
  asFile: boolean;
  asVariable: boolean;
}

/** Every name the workspace's assigned sets provide, at the revisions it gets, sorted. */
export function secretNamesOf(references: Pick<References, 'secretNamesFor'>, workspaceId: string): SecretNameInfo[] {
  return [...references.secretNamesFor(workspaceId)]
    .map(([name, v]) => ({ name, kind: v.kind, asFile: v.file, asVariable: v.variable }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One name's reach in the workspace, or null when no assigned set provides it. */
export function secretName(references: Pick<References, 'secretNamesFor'>, workspaceId: string, name: string): SecretNameInfo | null {
  const v = references.secretNamesFor(workspaceId).get(name);
  return v ? { name, kind: v.kind, asFile: v.file, asVariable: v.variable } : null;
}
