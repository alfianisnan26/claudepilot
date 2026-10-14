// CI deployments waiting for a person's approval (Needs you, docs/prd/attention.md; CI PRD FR41): a held job of a running run whose
// deployment is `waiting`. Class: production or uat (a protected environment). Risk: the environment, the jobs before it and how they
// ended (the gate's verdict), the run and its commit, and the auto-approve rule's dry verdict when it looked. Who decides: a PERSON with
// manage on the run, as the approve route (tokens and agents never approve, so they never see it here either).

import { objectRef, type AttentionItem } from '@portal/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { can } from '../authz/seam.js';
import { clip, isPerson, present, sessionWho, ticketWho, whoOf, type AttentionSource } from '../attention/registry.js';

interface Row {
  id: string;
  run_id: string;
  run_number: number;
  job: string;
  environment: string;
  pipeline: string;
  sha: string;
  created_at: string;
  auto_line: string | null;
  repo: string;
  branch: string | null;
  tag: string | null;
  actor: string;
  ticket_id: string | null;
  session_id: string | null;
  state: string | null;
  session_title: string | null;
}

/** The jobs that ran before the held one, and how they ended: `gate passed, build passed`. */
export function gateVerdict(state: string | null, held: string): string {
  let jobs: { id?: unknown; status?: unknown }[] = [];
  try {
    const s = state ? (JSON.parse(state) as { jobs?: unknown }) : null;
    jobs = Array.isArray(s?.jobs) ? (s.jobs as typeof jobs) : [];
  } catch {
    // an unreadable state says nothing
  }
  const before = jobs.filter((j) => typeof j.id === 'string' && j.id !== held && j.status !== 'pending' && j.status !== 'waiting');
  return before.length ? before.map((j) => `${clip(String(j.id), 24)} ${clip(String(j.status), 12)}`).join(', ') : 'no jobs before it';
}

export function ciAttentionSource(db: () => DatabaseSync | null): AttentionSource {
  return {
    kind: 'ci_deploy',
    list(actor) {
      const d = db();
      if (!d) throw new Error('the database is not available');
      if (!isPerson(actor)) return [];
      // One query: the waiting deployments of running runs, with the run's facts and its session's title.
      const rows = d
        .prepare(
          `SELECT dep.id, dep.run_id, dep.run_number, dep.job, dep.environment, dep.pipeline, dep.sha, dep.created_at, dep.auto_line,
                  r.repo, r.branch, r.tag, r.actor, r.ticket_id, r.session_id, r.state, s.title AS session_title
           FROM ci_deployments dep JOIN ci_runs r ON r.id = dep.run_id
           LEFT JOIN chat_sessions s ON s.id = r.session_id
           WHERE dep.approval = 'waiting' AND r.status = 'running'
           ORDER BY dep.created_at, dep.id LIMIT 500`,
        )
        .all() as unknown as Row[];
      return rows
        .filter((r) => can(actor, 'manage', objectRef('ci_run', r.run_id)).allow)
        .map((r): AttentionItem => {
          const ref = r.tag ?? r.branch ?? '';
          return {
            kind: 'ci_deploy',
            id: r.id,
            title: `${clip(r.repo, 40)} #${r.run_number}: ${clip(r.job, 30)} to ${clip(r.environment, 30)}`,
            who: present([sessionWho(r.session_id, r.session_title), ticketWho(r.ticket_id), !r.session_id ? whoOf(r.actor) : null]),
            why: 'production_uat',
            risk: [clip(r.environment, 30), gateVerdict(r.state, r.job), `${clip(r.pipeline, 30)} ${clip(ref, 30)}@${r.sha.slice(0, 7)}`, r.auto_line ? clip(r.auto_line, 80) : null].filter(Boolean).join(' · '),
            since: r.created_at,
            link: `/admin/ci/runs/${encodeURIComponent(r.run_id)}?job=${encodeURIComponent(r.job)}`,
            action: { label: 'Approve', method: 'POST', path: `/api/ci/runs/${encodeURIComponent(r.run_id)}/approve` },
          };
        });
    },
  };
}
