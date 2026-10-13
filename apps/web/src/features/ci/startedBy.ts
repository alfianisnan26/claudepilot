/** Who started a CI run, in words: a Portal MCP token by the label its owner gave it (as stored with the run). */
export function startedBy(run: { actor: string; actorLabel?: string | null }): string {
  if (run.actor.startsWith('session:')) return 'an agent';
  if (run.actor.startsWith('portal-mcp:')) return run.actorLabel?.trim() ? `MCP client “${run.actorLabel.trim()}”` : 'a Portal MCP token';
  return 'a person';
}
