// Structured QA and review verdicts (tickets PRD FR36, T-325 S1). Pure rules, no database: the service gathers the facts and writes the rows.
// A verdict is bound to ONE full commit sha. Whoever reads it (S2's planner, a person) asks `evaluateVerdicts` with the CURRENT head: a verdict
// on any other commit is stale and never counts, so a branch that moved after a PASS is not passing.

export const VERDICT_ROLES = ['qa', 'review'] as const;
export type VerdictRole = (typeof VERDICT_ROLES)[number];
export const VERDICTS = ['pass', 'fail'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** A full sha: 40 lowercase hex characters. An abbreviation could match more than one commit, so it is refused. */
export const FULL_SHA = /^[0-9a-f]{40}$/;

export const normalizeSha = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return FULL_SHA.test(s) ? s : null;
};

/** The verdict role a session's agent (`.claude/agents/<name>.md`) stands for, or null (an implementer, a lead, no agent). */
export function verdictRoleOfAgent(agent: string | null | undefined): VerdictRole | null {
  const a = (agent ?? '').toLowerCase();
  if (/review/.test(a)) return 'review';
  if (/(^|[-_])qa([-_]|$)|verif/.test(a)) return 'qa';
  return null;
}

export type VerdictRefusal = 'not_a_verifier' | 'wrong_role' | 'is_author' | 'is_lead' | 'descends_from_author' | 'bad_commit';

export type VerdictDecision = { allow: true } | { allow: false; why: VerdictRefusal };

export const VERDICT_REFUSAL_TEXT: Record<VerdictRefusal, string> = {
  not_a_verifier: 'Only a QA or review session, or a person in the portal, records a verdict.',
  wrong_role: 'Your agent role is not the role you tried to record.',
  is_author: 'The author of this ticket’s work cannot verify it.',
  is_lead: 'The lead of this ticket’s work cannot record its verdict.',
  descends_from_author: 'This session descends from an author of this ticket’s work (it was started by one), so it cannot verify it.',
  bad_commit: 'A verdict names the full commit sha (40 hex characters).',
};

/**
 * THE rule for recording a verdict, the tickets module's `can()` for it. A person in the portal (`ui`) may. An agent may only as a QA or review
 * session of the role it claims, and never when it is the author of the ticket's work or its lead. Every other caller (the portal itself, an
 * admin's token, a trigger) is refused: a verdict needs an identity that can be compared with the author. Pure; the service gathers
 * `authors` (the ticket's holder, their lineage, every session that held it or works on it) and `leads` (those sessions' parents).
 *
 * T-325 S1b (QA F1): a session's agent name is chosen by whoever spawned it, so the role is only worth something when no one up the caller's
 * spawn `chain` (its parents and the sessions it continues) is an author: an author's child, grandchild or successor is refused whatever it is
 * named. The one ancestor allowed is a holder that LEADS the work (`leadHolders`: the holder and its lineage when it is the parent of another
 * author and was not itself started on the ticket), so the orchestrator that holds a ticket can still send its own QA worker.
 */
export function canRecordVerdict(facts: {
  callerKind: 'ui' | 'system' | 'token' | 'agent' | 'trigger';
  role: VerdictRole;
  /** The calling agent session, when it is one. */
  session: { id: string; agent: string | null | undefined } | null;
  authors: ReadonlySet<string>;
  leads: ReadonlySet<string>;
  commit: string | null;
  /** The caller's spawn chain: parents and continued-from predecessors, walked up (not the caller itself). */
  chain: readonly string[];
  /** Authors that may be in `chain`: the holder and its lineage when it leads the work. */
  leadHolders: ReadonlySet<string>;
}): VerdictDecision {
  if (!facts.commit) return { allow: false, why: 'bad_commit' };
  if (facts.callerKind === 'ui') return { allow: true };
  if (facts.callerKind !== 'agent' || !facts.session) return { allow: false, why: 'not_a_verifier' };
  const mine = verdictRoleOfAgent(facts.session.agent);
  if (!mine) return { allow: false, why: 'not_a_verifier' };
  if (facts.authors.has(facts.session.id)) return { allow: false, why: 'is_author' };
  if (facts.leads.has(facts.session.id)) return { allow: false, why: 'is_lead' };
  if (facts.chain.some((a) => facts.authors.has(a) && !facts.leadHolders.has(a))) return { allow: false, why: 'descends_from_author' };
  if (mine !== facts.role) return { allow: false, why: 'wrong_role' };
  return { allow: true };
}

/** One stored verdict. */
export interface StoredVerdict {
  id: number;
  role: VerdictRole;
  verdict: Verdict;
  commit: string;
  actor: string;
  at: string;
}

/** Whether a verdict's commit is the head being judged. Full shas, compared whole. */
export const sameCommit = (verdictCommit: string, head: string): boolean => verdictCommit === head;

export interface VerdictEvaluation {
  /** Every needed role has a current PASS on the head. */
  pass: boolean;
  /** Per needed role: `pass`, `fail` (the latest verdict on the head is a fail), `missing` (none yet) or `stale` (only on an older commit). */
  roles: Record<string, 'pass' | 'fail' | 'missing' | 'stale'>;
}

/**
 * Whether `head` is passing: for each needed role the LATEST verdict on exactly `head` is a pass. A verdict on another commit never counts
 * (`stale` when that is all there is). `matches` is the commit comparison; it is a parameter only so a test can swap in a broken one and
 * show the stale guard is tested (a mutation); the portal always uses {@link sameCommit}.
 */
export function evaluateVerdicts(
  verdicts: readonly StoredVerdict[],
  head: string,
  need: readonly VerdictRole[] = ['qa'],
  matches: (verdictCommit: string, head: string) => boolean = sameCommit,
): VerdictEvaluation {
  const roles: VerdictEvaluation['roles'] = {};
  for (const role of need) {
    const mine = verdicts.filter((v) => v.role === role);
    const onHead = mine.filter((v) => matches(v.commit, head));
    const latest = onHead.reduce<StoredVerdict | null>((a, v) => (!a || v.id > a.id ? v : a), null);
    roles[role] = latest ? latest.verdict : mine.length ? 'stale' : 'missing';
  }
  return { pass: need.length > 0 && need.every((r) => roles[r] === 'pass'), roles };
}
