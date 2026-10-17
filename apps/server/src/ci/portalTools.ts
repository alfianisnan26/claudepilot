// The CI tools of the Portal MCP (local-git-ci PRD §14). An admin's token reaches everything its scope allows; an agent's
// per-session token (interface I8) reaches only its own runs: those of the branch its session works on and of its ticket, in
// its workspace, never anyone else's. Text that came from a workspace (log lines, commit subjects, step names, diagnostics) is
// handed over labelled as untrusted. Nothing here returns a secret: logs were redacted when they were kept.
// Deployments (PRD FR41): an agent may START a pipeline that deploys (a job names an `environment:`) on any branch of its own workspace's
// remotes, because the portal holds each job for a protected environment until a PERSON approves it in the UI. T-476: a crew's lead may also start
// any pipeline on a dev/* or ticket/* branch of its program's remote, and a worker's folder branch counts as its own (ci/authz.ts, agentStart). No tool approves, rejects or
// changes an environment's protection: those are routes a signed-in person calls, and an agent's token reaches no route.
import { AppError } from '@isnanme/core';
import { BUMP_NOTE_MAX, BUMP_PRIORITY, BUMP_REFUSAL_LABEL, CI_BUMP_MODE_LABEL, CI_STATUSES, objectRef, sessionRef, type BumpMode, type CiRepo, type CiRun, type CiRunSummary, type CiStatus, type ManagerDeployRow } from '@portal/contracts';
import { actorOfPrincipal, can, requireCan } from '../authz/seam.js';
import { bumpNote } from '../chat/bump.js';
import { fullInput } from '../portalmcp/compact.js';
import { portalTools, z, type PortalToolContext, type ToolRegistry } from '../portalmcp/registry.js';
import { agentStart, declareCiPolicies, leadReadsRemote, NO_RUN, noRemote, ownsBranchOn } from './authz.js';
import type { CiService } from './service.js';
import type { CiSessionsPort } from './sessions.js';

/** Where a person approves a run's deployment: the run page of the portal. */
export const runLink = (id: string): string => `/admin/ci/runs/${encodeURIComponent(id)}`;

export function registerCiTools(ci: CiService, sessions: CiSessionsPort | undefined, registry: ToolRegistry = portalTools): void {
  declareCiPolicies();
  /**
   * What an agent owns: runs of its session, of its session's ticket, and of its session's own branch on a remote where that branch counts as
   * its own (a worktree branch anywhere; a folder branch only on the folder's remote and only dev/* or ticket/*; T-476). `read` adds, for a
   * lead, every run on its program's remotes (read only: cancel and bump keep the strict rule).
   */
  const own = (ctx: PortalToolContext, run: Pick<CiRunSummary, 'workspaceId' | 'sessionId' | 'ticketId' | 'branch'>, repo: CiRepo | undefined, read = false): boolean => {
    if (!ctx.isAgent) return true;
    if (run.workspaceId !== ctx.workspaceId) return false;
    const me = ctx.sessionId ? sessions?.get(ctx.sessionId) : null;
    return run.sessionId === ctx.sessionId || (!!me?.ticketId && run.ticketId === me.ticketId) || ownsBranchOn(me, repo, run.branch) || (read && leadReadsRemote(me, repo));
  };
  const repoOf = async (run: Pick<CiRunSummary, 'workspaceId' | 'repoId'>): Promise<CiRepo | undefined> => (await ci.repos(run.workspaceId)).find((r) => r.id === run.repoId);

  const need = async (ctx: PortalToolContext, id: string, read = false): Promise<CiRun> => {
    const run = await ci.show(id).catch(() => {
      throw new AppError('NOT_FOUND', NO_RUN);
    });
    // An agent gets the same answer for a run that is not its own as for one that does not exist.
    if (!own(ctx, run, ctx.isAgent ? await repoOf(run) : undefined, read)) throw new AppError('NOT_FOUND', NO_RUN);
    return run;
  };

  const runView = (ctx: PortalToolContext, r: CiRunSummary) => ({
    id: r.id,
    number: r.number,
    workspace_id: r.workspaceId,
    repo: r.repo,
    pipeline: r.pipeline,
    branch: r.branch,
    tag: r.tag,
    sha: r.sha,
    subject: ctx.untrusted(r.subject, 'ci:commit', 200),
    trigger: r.trigger,
    status: r.status,
    reason: r.reason,
    actor: r.actor,
    actor_label: r.actorLabel,
    ticket_id: r.ticketId,
    session_id: r.sessionId,
    created_at: r.createdAt,
    finished_at: r.finishedAt,
    duration_ms: r.durationMs,
  });

  /** A run as a list row (T-282): enough to pick one; ci_run_get has the rest. */
  const runRow = (r: CiRunSummary) => ({
    id: r.id,
    number: r.number,
    pipeline: r.pipeline,
    branch: r.branch,
    sha: r.sha ? r.sha.slice(0, 12) : r.sha,
    status: r.status,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.ticketId ? { ticket_id: r.ticketId } : {}),
    created_at: r.createdAt,
    duration_ms: r.durationMs,
  });

  registry.register({
    name: 'ci_runs_list',
    title: 'List CI runs',
    description: 'Recent runs of the pipelines in workspace remotes, newest first, as short rows (id, pipeline, branch, short sha, status, ticket, when); full true for every field, ci_run_get for one run. An agent sees the runs of its own branch and ticket; a lead (has workers) also every run on its program\'s remotes, with stg_age_minutes per remote (minutes since the last stg deploy that passed, or "unavailable").',
    scope: 'agent',
    hints: { readOnly: true },
    input: z.object({
      workspace_id: z.string().max(200).optional().describe('Admin tokens: limit to one workspace, e.g. docker/api. An agent is always in its own.'),
      branch: z.string().max(200).optional(),
      ticket: z.string().max(20).optional().describe('A ticket id such as T-12.'),
      status: z.enum(CI_STATUSES).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      ...fullInput,
    }),
    async handler(ctx, args) {
      const limit = args.limit ?? 20;
      const status: CiStatus[] | undefined = args.status ? [args.status] : undefined;
      let items: CiRunSummary[];
      // T-558: minutes since the last stg deploy that went through, per program remote; "unavailable" when there is none, never a guess.
      let stgAge: { repo: string; minutes: number | 'unavailable' }[] = [];
      const ageOf = (r: CiRepo) => ({ repo: r.name, minutes: ci.stgAgeMinutes(r.id) ?? ('unavailable' as const) });
      if (ctx.isAgent) {
        const me = ctx.sessionId ? sessions?.get(ctx.sessionId) : null;
        const found = new Map<string, CiRunSummary>();
        const add = (list: CiRunSummary[]) => list.forEach((r) => found.set(r.id, r));
        if (ctx.sessionId) add(ci.list({ session: ctx.sessionId, status, limit }).items);
        if (me?.ticketId) add(ci.list({ ticket: me.ticketId, status, limit }).items);
        if (me?.branch && ctx.workspaceId) add(ci.list({ workspace: ctx.workspaceId, branch: me.branch, status, limit }).items);
        const repos = ctx.workspaceId ? await ci.repos(ctx.workspaceId) : [];
        // A lead reads every run of its program's remotes (T-476).
        for (const r of repos) if (leadReadsRemote(me, r)) add(ci.list({ repo: r.id, status, limit }).items);
        stgAge = repos.filter((r) => leadReadsRemote(me, r)).map(ageOf);
        items = [...found.values()]
          .filter((r) => own(ctx, r, repos.find((x) => x.id === r.repoId), true) &&(!args.branch || r.branch === args.branch) && (!args.ticket || r.ticketId === args.ticket))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit);
      } else {
        items = ci.list({ workspace: args.workspace_id, branch: args.branch, ticket: args.ticket, status, limit }).items;
      }
      return {
        summary: `${items.length} run${items.length === 1 ? '' : 's'}`,
        runs: items.map((r) => (args.full ? runView(ctx, r) : runRow(r))),
        ...(stgAge.length ? { stg_age_minutes: stgAge } : {}),
      };
    },
  });

  registry.register({
    name: 'ci_run_get',
    title: 'Get a CI run',
    description:
      'One run with its jobs and steps, their status, exit codes and durations, and what was wrong with the pipeline file when it was invalid. ' +
      'A job with status "waiting" is held for a person\'s approval (deployments): tell the person to approve it on the run page (`link`); you can not approve it.',
    scope: 'agent',
    hints: { readOnly: true },
    input: z.object({ id: z.string().max(40).describe('A run id from ci_runs_list.') }),
    async handler(ctx, { id }) {
      const run = await need(ctx, id, true);
      return {
        summary: `Run #${run.number} of ${run.pipeline} on ${run.branch ?? run.tag ?? '?'}: ${run.status}${run.reason ? ` (${run.reason})` : ''}`,
        run: runView(ctx, run),
        jobs: run.detail.map((j) => ({
          id: j.id,
          name: ctx.untrusted(j.name, 'ci:job', 80),
          status: j.status,
          reason: j.reason,
          duration_ms: j.durationMs,
          steps: j.steps.map((s) => ({ index: s.idx, name: ctx.untrusted(s.name, 'ci:step', 120), status: s.status, exit_code: s.exitCode, reason: s.reason, duration_ms: s.durationMs, log_truncated: s.logTruncated })),
          artifacts: j.artifacts.map((a) => ({ path: a.path, bytes: a.bytes })),
        })),
        diagnostics: run.diagnostics.map((d) => ({ file: d.file, line: d.line, column: d.column, code: d.code, message: ctx.untrusted(d.message, 'ci:diagnostic', 300), hint: ctx.untrusted(d.hint ?? null, 'ci:diagnostic', 300) })),
        deployments: run.deployments.map((d) => ({ job: d.job, environment: d.environment, approval: d.approval, decided_by: d.decidedBy, decided_at: d.decidedAt, outcome: d.outcome })),
        waiting_for_approval: run.deployments.filter((d) => d.approval === 'waiting').map((d) => `${d.job} → ${d.environment}`),
        link: runLink(run.id),
      };
    },
  });

  registry.register({
    name: 'deploy_status',
    title: 'Deploy status',
    description:
      'The latest runs that deploy (a job tied to an environment), newest first, of the runs you may view: pipeline, branch, sha, status, the job running or held now (stage), ' +
      'the status of the job named gate ("unavailable" when the run has none), and which environments wait for a person\'s approval. Read only: you can not approve; a person approves on the run page (link).',
    scope: 'read',
    hints: { readOnly: true, idempotent: true },
    input: z.object({
      pipeline: z.string().min(1).max(100).optional().describe('Only this pipeline\'s runs, e.g. deploy.'),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    async handler(ctx, args) {
      const actor = actorOfPrincipal(ctx.principal);
      const limit = args.limit ?? 5;
      const rows: ManagerDeployRow[] = [];
      // Newest first; a run is opened only when the caller may view it, and kept only when it deploys.
      for (const r of ci.list({ pipeline: args.pipeline, limit: 50 }).items) {
        if (rows.length >= limit) break;
        if (!can(actor, 'view', objectRef('ci_run', r.id)).allow) continue;
        const run = await ci.show(r.id).catch(() => null);
        if (!run?.deployments.length) continue;
        const now = run.detail.find((j) => j.status === 'running' || j.status === 'waiting');
        const gate = run.detail.find((j) => j.id === 'gate');
        rows.push({
          id: run.id,
          number: run.number,
          pipeline: ctx.untrusted(run.pipeline, 'ci', 100),
          branch: ctx.untrusted(run.branch, 'ci', 200),
          sha: run.sha ? run.sha.slice(0, 12) : null,
          status: run.status,
          stage: ctx.untrusted(now?.id, 'ci', 100),
          gate: gate?.status ?? 'unavailable',
          waiting_for_approval: run.deployments.filter((d) => d.approval === 'waiting').map((d) => d.environment),
          created_at: run.createdAt,
          link: runLink(run.id),
        });
      }
      const waiting = rows.filter((r) => r.waiting_for_approval.length).length;
      return { summary: `${rows.length} deploy run${rows.length === 1 ? '' : 's'}${waiting ? `, ${waiting} waiting for approval` : ''}`, deploys: rows };
    },
  });

  registry.register({
    name: 'ci_run_logs',
    title: 'Read a CI step log',
    description: 'A piece of one step\'s log, from an offset. Finished runs come from the portal\'s copy (the first part and the last part of a long log); a running step is read live. Secrets are redacted.',
    scope: 'agent',
    hints: { readOnly: true },
    input: z.object({
      id: z.string().max(40).describe('A run id.'),
      job: z.string().max(64).describe('The job id from ci_run_get.'),
      step: z.number().int().min(0).max(100).describe('The step index from ci_run_get.'),
      offset: z.number().int().min(0).optional().describe('Where to start; pass the previous next_offset to continue.'),
    }),
    async handler(ctx, { id, job, step, offset }) {
      await need(ctx, id, true);
      const chunk = await ci.log(id, job, step, offset ?? 0);
      return {
        summary: `${chunk.text.length} characters of log${chunk.done ? ', the end' : ''}`,
        log: ctx.untrusted(chunk.text, 'ci:log', 8_000),
        next_offset: chunk.next,
        done: chunk.done,
        truncated: chunk.truncated,
      };
    },
  });

  registry.register({
    name: 'ci_validate',
    title: 'Check pipeline files',
    description: 'Checks .pilot pipeline files you give as text against the pipeline format, and says what is wrong with each, with its line and a suggestion. Reads nothing from any workspace; use it before you push.',
    scope: 'agent',
    hints: { readOnly: true },
    maxArgsBytes: 200_000,
    input: z.object({ files: z.record(z.string().max(200), z.string().max(131_072)).describe('Repository path (.pilot/ci.yml) to the file\'s text.') }),
    handler(ctx, { files }) {
      const r = ci.validate({ files });
      const bad = r.pipelines.filter((p) => !p.valid).length;
      return {
        summary: r.pipelines.length === 0 ? 'No pipeline files among those given.' : bad === 0 ? `${r.pipelines.length} pipeline file${r.pipelines.length === 1 ? '' : 's'} valid.` : `${bad} of ${r.pipelines.length} pipeline files have errors.`,
        pipelines: r.pipelines.map((p) => ({
          file: p.file,
          valid: p.valid,
          triggers: p.triggers,
          jobs: p.jobs,
          diagnostics: p.diagnostics.map((d) => ({ severity: d.severity, line: d.line, column: d.column, path: d.path, code: d.code, message: d.message, hint: d.hint ?? null })),
        })),
        problems: r.diagnostics,
      };
    },
  });

  registry.register({
    name: 'ci_run_trigger',
    title: 'Start a CI run',
    description:
      'Starts a pipeline that has a manual trigger, on a branch or tag of a workspace remote. An agent: on its own branch (worktree, or a worker\'s folder ' +
      'branch at start); a lead (has workers) also on dev/* or ticket/* of its program\'s remote (its folder), and on its branch stg only a pipeline ' +
      'that deploys to exactly the environment stg (e.g. stg-deploy); or a DEPLOYMENT pipeline (names an ' +
      'environment) on any branch of its workspace, whose deploying job waits for a person\'s approval. ' +
      'To deploy ClaudePilot from its development workspace: repo "claudepilot", pipeline "deploy", ref "integration"; inputs: images ("portal", "portal,workspace", ' +
      '"portal,workspace,workspace-dev" or "none"), gate (true: run the release gate first), deploy (false: build only), dry_run (true: print every action, change nothing). ' +
      'Then poll ci_run_get: say "waiting for approval" with the link when a job waits, and report the result.',
    scope: 'agent',
    rate: { perHour: 20 },
    input: z.object({
      repo: z.string().max(64).describe('The remote\'s name, e.g. app.'),
      pipeline: z.string().max(64).describe('The pipeline\'s file name without .yml, e.g. ci.'),
      ref: z.string().max(200).describe('A branch or tag.'),
      inputs: z.record(z.string().max(64), z.union([z.string().max(1000), z.boolean()])).optional(),
      workspace_id: z.string().max(200).optional().describe('Admin tokens: the workspace of the remote. An agent is always in its own.'),
    }),
    async handler(ctx, args) {
      const workspaceId = ctx.isAgent ? ctx.workspaceId! : args.workspace_id;
      if (!workspaceId) throw new AppError('VALIDATION_FAILED', 'Say which workspace: workspace_id.');
      const repo = (await ci.repos(workspaceId)).find((r) => r.name === args.repo);
      if (!repo || !can(actorOfPrincipal(ctx.principal), 'operate', objectRef('ci_repo', repo.id)).allow) throw noRemote(args.repo, workspaceId);
      // An agent (ci/authz.ts, agentStart): its own branch, a lead's dev/* or ticket/* branch of its program's remote, else deployments only
      // (the service checks the file it reads: their deploying jobs wait for a person).
      const start = ctx.isAgent ? agentStart(ctx.sessionId ? (sessions?.get(ctx.sessionId) ?? null) : null, repo, args.ref) : null;
      const run = await ci.startRun({ repoId: repo.id, pipeline: args.pipeline, ref: start?.ref ?? args.ref, inputs: args.inputs }, ctx.actor, {
        sessionId: ctx.isAgent ? ctx.sessionId : null,
        deploymentOnly: start?.rule === 'deployment' ? start.refusal : undefined,
        // T-558: a lead on `stg` of its program's remote: only a pipeline that deploys to exactly stg (its file decides), else a missing remote.
        stgOnly: start?.rule === 'program_stg' ? start.refusal : undefined,
        actorLabel: ctx.actorLabel ?? null,
        rule: start?.rule ?? 'token',
      });
      ctx.affected(`ci-run:${run.id}`);
      const held = run.deployments.filter((d) => d.approval === 'pending').map((d) => d.environment);
      return {
        summary: `Started run #${run.number} of ${run.pipeline} on ${run.branch ?? run.tag ?? args.ref}.${held.length ? ` Deploying to ${[...new Set(held)].join(', ')} waits for a person's approval in the portal.` : ''}`,
        run: runView(ctx, run),
        link: runLink(run.id),
      };
    },
  });

  registry.register({
    name: 'ci_run_cancel',
    title: 'Cancel a CI run',
    description: 'Cancels a queued or running run: its processes are stopped and its checkout deleted. An agent can cancel only its own runs.',
    scope: 'agent',
    rate: { perHour: 60 },
    input: z.object({ id: z.string().max(40).describe('A run id.') }),
    async handler(ctx, { id }) {
      await need(ctx, id);
      const run = await ci.cancel(id, { actor: ctx.actor, label: ctx.actorLabel ?? null });
      ctx.affected(`ci-run:${id}`);
      return { summary: `Run #${run.number} of ${run.pipeline}: ${run.status}.`, run: runView(ctx, run) };
    },
  });

  registry.register({
    name: 'ci_run_bump',
    title: 'Bump a CI run into a session',
    description:
      'Pushes a run into a live session: the one that started it first, then its workspace\'s, then its ticket\'s. mode fix: CI\'s report of the run goes in to be acted on now (it steers the turn in progress). mode ask: a question (it waits for the turn). An optional one-line note. Asks for confirmation first (shows the session and the mode). Without session_id it lists the sessions that can take it. Needs session control to be on.',
    scope: 'operate',
    requires: 'session_control',
    input: z.object({
      id: z.string().max(40).describe('A run id.'),
      session_id: z.string().max(80).optional().describe('The session to bump it into. Leave out to list the sessions that can take it.'),
      mode: z.enum(['fix', 'ask']).optional().describe('fix (default) or ask.'),
      note: z.string().max(BUMP_NOTE_MAX).optional().describe('One line for the session.'),
      confirm_token: z.string().optional(),
    }),
    async handler(ctx, args) {
      const run = await need(ctx, args.id);
      const actor = actorOfPrincipal(ctx.principal);
      requireCan(actor, 'operate', objectRef('ci_run', run.id));
      const targets = ci.bumpTargets(run.id);
      if (!args.session_id) {
        return {
          summary: `${targets.filter((t) => !t.refusal).length} sessions can take run #${run.number}.`,
          sessions: targets.map((t) => ({ id: t.id, title: ctx.untrusted(t.title, 'agent', 120), state: t.state, workspace_id: t.workspaceId, started_it: t.preferred, can_bump: !t.refusal, why_not: t.refusal ? BUMP_REFUSAL_LABEL[t.refusal] : null })),
        };
      }
      requireCan(actor, 'operate', sessionRef(args.session_id));
      const mode: BumpMode = args.mode === 'ask' ? 'ask' : 'prioritise';
      const note = bumpNote(args.note);
      const target = targets.find((t) => t.id === args.session_id);
      // The token is bound to the session's state and the run's status: if either moved, the person is asked again.
      const gate = ctx.confirm(
        args,
        {
          run: `#${run.number} ${run.pipeline} (${run.status})`,
          session: args.session_id,
          session_title: ctx.untrusted(target?.title ?? null, 'agent', 120),
          session_state: target?.state ?? 'not offered',
          mode: CI_BUMP_MODE_LABEL[mode],
          priority: BUMP_PRIORITY[mode],
          note: note || null,
        },
        `${run.id}:${run.status}:${args.session_id}:${target?.state ?? 'none'}`,
      );
      if (gate) return gate;
      const after = await ci.bump(run.id, { sessionId: args.session_id, mode, note }, { actor: ctx.actor, label: ctx.actorLabel ?? null, userId: actor.kind === 'system' || actor.kind === 'anonymous' ? null : actor.userId });
      ctx.affected(`ci-run:${run.id}`, `session:${args.session_id}`);
      return { summary: `Bumped run #${after.number} into session ${args.session_id} (${CI_BUMP_MODE_LABEL[mode]}).`, run: runView(ctx, after), link: runLink(after.id) };
    },
  });
}
