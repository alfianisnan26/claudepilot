/** Who started a CI run, in words: a Portal MCP token by the label its owner gave it (as stored with the run). */
export function startedBy(run: { actor: string; actorLabel?: string | null }): string {
  if (run.actor.startsWith('session:')) return 'an agent';
  if (run.actor.startsWith('portal-mcp:')) return run.actorLabel?.trim() ? `MCP client “${run.actorLabel.trim()}”` : 'a Portal MCP token';
  return 'a person';
}

/** Who cancelled a run and why, in a few words (T-95); null for a run nobody cancelled, or one cancelled before this was recorded. */
export function cancelledLine(run: { status: string; cancelledBy?: string | null; cancelledByLabel?: string | null; cancelNote?: string | null }): string | null {
  if (run.status !== 'cancelled' || !run.cancelledBy) return null;
  const who = run.cancelledBy === 'pipeline' ? 'the pipeline' : startedBy({ actor: run.cancelledBy, actorLabel: run.cancelledByLabel });
  return `Cancelled by ${who}${run.cancelNote ? `, ${run.cancelNote}` : ''}`;
}
