// cp-jobrun-dispatcher (T-3542, epic PILOT-1127): scripts/job-run.sh --backend cf runs its job in a Cloudflare Container instead of a k3s Job.
//   Worker (this file's default export)  signed HTTP API for job-run.sh: POST /jobs, GET /jobs/:id, GET /jobs/:id/log?offset=,
//                                        POST /jobs/:id/heartbeat, DELETE /jobs/:id, GET /jobs/:id/artifacts, GET /jobs?chat=
//   Scheduler (one Durable Object)       caps (at once / per chat / per program), queue order, the daily cost ledger and budget
//   JobRunStd / JobRunBig (one per job)  the job's container (standard-3 / standard-4), its log in SQLite, deadline + heartbeat alarm
//   Egress (WorkerEntrypoint)            every HTTP(S) request the container makes: allow-list, the git credential for a clone (fetch phase
//                                        only, upload-pack only), artifacts into R2, the one-way switch from the fetch to the run phase
// The container never holds a credential: enableInternet is false, so only what Egress forwards leaves it, and the git token lives in
// Egress's props (memory) for the fetch phase alone. Plan: docs in deploy/cf-runner/README.md.

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { parseKeys, verify } from './auth';
import {
  type Active,
  admit,
  costUsd,
  DEFAULT_ALLOW,
  gitReadWithCredential,
  hostAllowed,
  JOB_ID,
  type Ledger,
  type Limits,
  SIZES,
  type Size,
  sizeOfId,
  utcDay,
  type Waiter,
  WAITER_TTL_MS,
} from './policy';

export interface Env {
  SCHEDULER: DurableObjectNamespace<Scheduler>;
  JOBRUN_STD: DurableObjectNamespace<JobRunStd>;
  JOBRUN_BIG: DurableObjectNamespace<JobRunBig>;
  ARTIFACTS: R2Bucket;
  JOBRUN_KEYS?: string; // secret: {"<workspace>": "<64 hex>"}
  GIT_GROUP: string; // the only GitLab group a job may clone (memorid)
  ALLOW_HOSTS?: string; // comma list, replaces DEFAULT_ALLOW
  MAX_AT_ONCE: string;
  MAX_PER_CHAT: string;
  MAX_PER_PROGRAM: string;
  BUDGET_USD_DAY: string;
  PROGRAM_USD_DAY: string;
  MAX_TIMEOUT_S: string;
  ARTIFACT_MAX_BYTES: string;
}

const LOG_CAP = 64 * 1024 * 1024;
const PULL_MAX = 1024 * 1024;
const HEARTBEAT_MS = 120_000;
const START_MS = 180_000;
const KEEP_MS = 24 * 3600_000;
const TICK_MS = 5_000;
const TERMINAL = new Set(['finished', 'cancelled', 'deadline', 'infra']);

const num = (v: string | undefined, d: number) => (v !== undefined && /^[0-9]+(\.[0-9]+)?$/.test(v) ? Number(v) : d);
const limits = (env: Env): Limits => ({
  max: num(env.MAX_AT_ONCE, 6),
  perChat: num(env.MAX_PER_CHAT, 4),
  perProgram: num(env.MAX_PER_PROGRAM, 6),
  budgetUsdDay: num(env.BUDGET_USD_DAY, 5),
  programUsdDay: num(env.PROGRAM_USD_DAY, 5),
});
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const nsOf = (env: Env, size: Size) => (size === 'big' ? env.JOBRUN_BIG : env.JOBRUN_STD);
const stubOf = (env: Env, id: string) => {
  const size = sizeOfId(id);
  return size ? nsOf(env, size).get(nsOf(env, size).idFromName(id)) : null;
};

// ---- Scheduler ------------------------------------------------------------------------------------------------------------------------

interface SchedState {
  active: Active[];
  waiters: Waiter[];
  ledger: Ledger;
  recent: { id: string; workspace: string; chat: string; at: number }[];
}

export class Scheduler extends DurableObject<Env> {
  #now: () => number = () => Date.now();
  /** Tests only: a fake clock. */
  async setClock(ms: number | null) {
    this.#now = ms === null ? () => Date.now() : () => ms;
  }
  async #load(): Promise<SchedState> {
    const s = (await this.ctx.storage.get<SchedState>('s')) ?? {
      active: [],
      waiters: [],
      ledger: { day: utcDay(this.#now()), total: 0, byProgram: {} },
      recent: [],
    };
    const now = this.#now();
    if (s.ledger.day !== utcDay(now)) s.ledger = { day: utcDay(now), total: 0, byProgram: {} };
    // A job that never released (its object lost) leaves after the longest possible run plus slack.
    s.active = s.active.filter((a) => now - a.since < 2 * 3600_000);
    s.waiters = s.waiters.filter((w) => now - w.seen <= WAITER_TTL_MS);
    s.recent = s.recent.filter((r) => now - r.at < KEEP_MS);
    return s;
  }
  async admit(req: { id: string; workspace: string; chat: string; program: string; size: Size }) {
    const s = await this.#load();
    const now = this.#now();
    if (s.active.some((a) => a.id === req.id)) return { kind: 'go' as const };
    const d = admit(req, s.active, s.waiters, s.ledger, limits(this.env), now);
    if (d.kind === 'go') {
      s.active.push({ id: req.id, chat: req.chat, program: req.program, size: req.size, since: now });
      s.waiters = s.waiters.filter((w) => w.id !== req.id);
      s.recent.push({ id: req.id, workspace: req.workspace, chat: req.chat, at: now });
    } else if (d.kind === 'wait') {
      const w = s.waiters.find((x) => x.id === req.id);
      if (w) w.seen = now;
      else s.waiters.push({ id: req.id, chat: req.chat, program: req.program, first: now, seen: now });
    }
    await this.ctx.storage.put('s', s);
    return d;
  }
  /** A job ended (any way): it leaves the active set and its cost goes into today's ledger. Idempotent. */
  async release(id: string, usd: number, program: string) {
    const s = await this.#load();
    const was = s.active.find((a) => a.id === id);
    if (!was) return false;
    s.active = s.active.filter((a) => a.id !== id);
    const v = Number.isFinite(usd) && usd > 0 ? usd : 0;
    s.ledger.total += v;
    s.ledger.byProgram[program] = (s.ledger.byProgram[program] ?? 0) + v;
    await this.ctx.storage.put('s', s);
    return true;
  }
  async snapshot() {
    const s = await this.#load();
    return { active: s.active, waiting: s.waiters.length, ledger: s.ledger, limits: limits(this.env) };
  }
  async list(workspace: string, chat: string | null) {
    const s = await this.#load();
    return s.recent.filter((r) => r.workspace === workspace && (chat === null || r.chat === chat)).map((r) => r.id);
  }
}

// ---- JobRun ---------------------------------------------------------------------------------------------------------------------------

export interface JobSpec {
  id: string;
  workspace: string;
  chat: string;
  role: string;
  program: string;
  repoUrl: string;
  ref: string;
  subs: { path: string; ref: string }[];
  steps: 'npm-ci' | 'none';
  cmd: string; // base64
  artifacts: string; // space-separated paths
  timeout: number; // s
}
interface Meta extends Omit<JobSpec, 'cmd'> {
  size: Size;
  state: 'starting' | 'fetching' | 'running' | 'finished' | 'cancelled' | 'deadline' | 'infra';
  created: number;
  kicked?: number;
  runPhase?: number;
  ended?: number;
  exit?: number;
  reason?: string;
  lastBeat: number;
  logSize: number;
  costUsd?: number;
  location?: string;
  notes: number;
  logAgent?: number; // bytes read from the container's own log so far
}

class JobRunBase extends DurableObject<Env> {
  protected size: Size = 'std';
  #pulling = false;
  #cmd: string | null = null; // the base64 command, in memory until the container has it

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS log (off INTEGER PRIMARY KEY, data BLOB NOT NULL)');
    if (ctx.container?.running) void ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(10 * 60_000).catch(() => {}));
  }
  async #meta() {
    return (await this.ctx.storage.get<Meta>('meta')) ?? null;
  }
  async #save(m: Meta) {
    await this.ctx.storage.put('meta', m);
  }
  #append(m: Meta, bytes: Uint8Array) {
    if (bytes.length === 0) return;
    if (m.logSize >= LOG_CAP) return;
    const b = m.logSize + bytes.length > LOG_CAP ? bytes.slice(0, LOG_CAP - m.logSize) : bytes;
    this.ctx.storage.sql.exec('INSERT INTO log (off, data) VALUES (?, ?)', m.logSize, b);
    m.logSize += b.length;
  }
  #line(m: Meta, text: string) {
    this.#append(m, new TextEncoder().encode(`${text}\n`));
  }
  #egress(m: Meta, phase: 'fetch' | 'run', auth: string | null) {
    const allow = this.env.ALLOW_HOSTS ? this.env.ALLOW_HOSTS.split(',').map((h) => h.trim()).filter(Boolean) : DEFAULT_ALLOW;
    // biome-ignore lint: ctx.exports is typed loosely in workers-types
    return (this.ctx as any).exports.Egress({
      props: { job: m.id, size: this.size, phase, allow, group: this.env.GIT_GROUP, auth },
    }) as Fetcher;
  }
  async #intercept(m: Meta, phase: 'fetch' | 'run', auth: string | null) {
    const c = this.ctx.container!;
    const e = this.#egress(m, phase, auth);
    await c.interceptOutboundHttps('*', e);
    await c.interceptAllOutboundHttp(e);
  }

  /** Starts the job (the Worker calls it once the Scheduler said go). `creds` is the git credential for the clone: memory only. */
  async begin(spec: JobSpec, creds: { user: string; token: string } | null) {
    const old = await this.#meta();
    if (old) return this.#info(old);
    const now = Date.now();
    const m: Meta = {
      ...spec,
      size: this.size,
      state: 'starting',
      created: now,
      lastBeat: now,
      logSize: 0,
      notes: 0,
    };
    delete (m as Partial<JobSpec>).cmd;
    this.#cmd = spec.cmd;
    const c = this.ctx.container;
    if (!c) throw new Error('no container binding');
    this.#line(m, `=== JOB-RUN PLACEMENT backend=cf instance=${SIZES[this.size].instance} job=${m.id} decision=started`);
    await this.#save(m);
    c.start({ enableInternet: false, env: { JR_JOB: m.id } });
    const auth = creds ? `Basic ${btoa(`${creds.user}:${creds.token}`)}` : null;
    await this.#intercept(m, 'fetch', auth);
    await c.setInactivityTimeout(10 * 60_000).catch(() => {});
    this.ctx.waitUntil(
      c.monitor().then(
        () => this.#onExit(null),
        (e: unknown) => this.#onExit(String((e as Error)?.message ?? e).slice(0, 200)),
      ),
    );
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return this.#info(m);
  }

  async #onExit(err: string | null) {
    const m = await this.#meta();
    if (!m || TERMINAL.has(m.state)) return;
    await this.#pull(m).catch(() => {});
    if (TERMINAL.has(m.state)) return;
    this.#line(m, `=== JOB-RUN PLATFORM-STOP the container stopped before the job ended${err ? ` (${err.replace(/[\r\n]/g, ' ')})` : ''}`);
    await this.#finish(m, 'infra', undefined, 'container stopped');
  }

  /** Egress calls this when the container asks to leave the fetch phase: the credential goes, for good, before any repository code runs. */
  async toRunPhase() {
    const m = await this.#meta();
    if (!m || TERMINAL.has(m.state)) return false;
    if (m.state === 'running') return true;
    await this.#intercept(m, 'run', null);
    m.state = 'running';
    m.runPhase = Date.now();
    await this.#save(m);
    return true;
  }

  async note(text: string) {
    const m = await this.#meta();
    if (!m || TERMINAL.has(m.state) || m.notes >= 50) return;
    m.notes++;
    this.#line(m, `=== JOB-RUN EGRESS ${text.replace(/[^\x20-\x7e]/g, '?').slice(0, 200)}`);
    await this.#save(m);
  }

  async #pull(m: Meta) {
    const c = this.ctx.container;
    if (!c?.running || this.#pulling) return;
    this.#pulling = true;
    try {
      const port = c.getTcpPort(8080);
      for (let i = 0; i < 16; i++) {
        const r = await port.fetch(`http://c/log?offset=${m.logAgent ?? 0}&max=${PULL_MAX}`);
        if (!r.ok) break;
        const b = new Uint8Array(await r.arrayBuffer());
        m.logAgent = (m.logAgent ?? 0) + b.length;
        this.#append(m, b);
        if (b.length < PULL_MAX) break;
      }
      const st = await port.fetch('http://c/status');
      if (st.ok) {
        const s = (await st.json()) as { done: boolean; exit: number | null; location?: string };
        if (s.location) m.location = s.location;
        if (s.done) {
          await this.#save(m);
          await this.#finish(m, 'finished', s.exit ?? 1);
          return;
        }
      }
      await this.#save(m);
    } finally {
      this.#pulling = false;
    }
  }

  async #finish(m: Meta, state: Meta['state'], exit?: number, reason?: string) {
    if (TERMINAL.has(m.state)) return;
    m.state = state;
    m.exit = exit;
    m.reason = reason;
    m.ended = Date.now();
    m.costUsd = costUsd(this.size, (m.ended - m.created) / 1000);
    this.#line(
      m,
      `=== JOB-RUN CF state=${state}${exit === undefined ? '' : ` exit=${exit}`} seconds=${Math.round((m.ended - m.created) / 1000)} est_usd=${m.costUsd.toFixed(4)}${reason ? ` reason=${reason.replace(/\s+/g, '-')}` : ''}`,
    );
    await this.#save(m);
    const sch = this.env.SCHEDULER.get(this.env.SCHEDULER.idFromName('global'));
    await sch.release(m.id, m.costUsd, m.program);
    if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => {});
    await this.ctx.storage.setAlarm(Date.now() + KEEP_MS);
  }

  async alarm() {
    const m = await this.#meta();
    if (!m) return;
    if (TERMINAL.has(m.state)) {
      // Kept a day so a late reader still gets the log and the exit; then everything goes.
      if (Date.now() - (m.ended ?? 0) >= KEEP_MS - 1000) await this.ctx.storage.deleteAll();
      return;
    }
    const now = Date.now();
    const c = this.ctx.container;
    if (m.state === 'starting') {
      if (c?.running) {
        try {
          const h = await c.getTcpPort(8080).fetch('http://c/health');
          if (h.ok && this.#cmd !== null) {
            const r = await c.getTcpPort(8080).fetch('http://c/run', {
              method: 'POST',
              body: JSON.stringify({
                job: m.id,
                repoUrl: m.repoUrl,
                ref: m.ref,
                subs: m.subs,
                steps: m.steps,
                cmd: this.#cmd,
                artifacts: m.artifacts,
                artifactMax: num(this.env.ARTIFACT_MAX_BYTES, 96 * 1024 * 1024),
              }),
            });
            if (r.ok) {
              this.#cmd = null;
              m.state = 'fetching';
              m.kicked = now;
              await this.#save(m);
            }
          } else if (h.ok && this.#cmd === null) {
            // The object restarted between begin() and the kick: the command (memory only) is gone. Infra failure, never a guess.
            this.#line(m, '=== JOB-RUN the dispatcher restarted before the job was handed over: no command (infra)');
            await this.#finish(m, 'infra', undefined, 'restart before start');
            return;
          }
        } catch {
          /* not listening yet */
        }
      }
      if (m.state === 'starting' && now - m.created > START_MS) {
        this.#line(m, `=== JOB-RUN the container did not start in ${START_MS / 1000}s`);
        await this.#finish(m, 'infra', undefined, 'start timeout');
        return;
      }
    } else {
      await this.#pull(m).catch(() => {});
      if (TERMINAL.has(m.state)) return;
    }
    if (now - m.lastBeat > HEARTBEAT_MS) {
      this.#line(m, `=== JOB-RUN no heartbeat from job-run.sh for ${HEARTBEAT_MS / 1000}s: stopping`);
      await this.#finish(m, 'cancelled', undefined, 'no heartbeat');
      return;
    }
    if (now - m.created > m.timeout * 1000) {
      this.#line(m, `=== JOB-RUN past the deadline (${m.timeout}s): stopping`);
      await this.#finish(m, 'deadline', 124, 'deadline');
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  #info(m: Meta) {
    return {
      id: m.id,
      state: m.state,
      exit: m.exit ?? null,
      reason: m.reason ?? null,
      size: m.size,
      instance: SIZES[m.size].instance,
      created: m.created,
      runPhase: m.runPhase ?? null,
      ended: m.ended ?? null,
      logSize: m.logSize,
      costUsd: m.costUsd ?? null,
      location: m.location ?? null,
      chat: m.chat,
      role: m.role,
      program: m.program,
    };
  }
  async info(workspace: string) {
    const m = await this.#meta();
    return m && m.workspace === workspace ? this.#info(m) : null;
  }
  async heartbeat(workspace: string) {
    const m = await this.#meta();
    if (!m || m.workspace !== workspace) return null;
    if (!TERMINAL.has(m.state)) {
      m.lastBeat = Date.now();
      await this.#save(m);
    }
    return this.#info(m);
  }
  async readLog(workspace: string, offset: number) {
    const m = await this.#meta();
    if (!m || m.workspace !== workspace) return null;
    if (!TERMINAL.has(m.state) && m.state !== 'starting') await this.#pull(m).catch(() => {});
    const rows = this.ctx.storage.sql
      .exec<{ off: number; data: ArrayBuffer }>('SELECT off, data FROM log WHERE off + length(data) > ? ORDER BY off LIMIT 64', offset)
      .toArray();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (const r of rows) {
      const d = new Uint8Array(r.data);
      const from = Math.max(0, offset - r.off);
      const p = d.slice(from);
      parts.push(p);
      size += p.length;
      if (size >= PULL_MAX) break;
    }
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return { data: out, next: offset + size, info: this.#info(m) };
  }
  async cancel(workspace: string, reason: string) {
    const m = await this.#meta();
    if (!m || m.workspace !== workspace) return null;
    if (!TERMINAL.has(m.state)) {
      await this.#pull(m).catch(() => {});
      if (!TERMINAL.has(m.state)) {
        this.#line(m, `=== JOB-RUN stopped: ${reason.replace(/[^\x20-\x7e]/g, '?').slice(0, 100)}`);
        await this.#finish(m, 'cancelled', undefined, 'stopped');
      }
    }
    return this.#info(m);
  }
}
export class JobRunStd extends JobRunBase {
  protected override size: Size = 'std';
}
export class JobRunBig extends JobRunBase {
  protected override size: Size = 'big';
}

// ---- Egress ---------------------------------------------------------------------------------------------------------------------------

interface EgressProps {
  job: string;
  size: Size;
  phase: 'fetch' | 'run';
  allow: string[];
  group: string;
  auth: string | null;
}

export class Egress extends WorkerEntrypoint<Env, EgressProps> {
  async fetch(req: Request): Promise<Response> {
    const p = this.ctx.props;
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    const job = nsOf(this.env, p.size).get(nsOf(this.env, p.size).idFromName(p.job));
    if (host === 'control.jobrun') {
      if (req.method === 'POST' && url.pathname === '/phase/run') {
        const ok = await job.toRunPhase();
        return new Response(ok ? 'run\n' : 'no\n', { status: ok ? 200 : 409 });
      }
      return new Response('no\n', { status: 404 });
    }
    if (host === 'artifacts.jobrun') {
      if (req.method !== 'PUT' || url.pathname !== '/upload' || !req.body) return new Response('no\n', { status: 405 });
      const max = num(this.env.ARTIFACT_MAX_BYTES, 96 * 1024 * 1024);
      const len = Number(req.headers.get('content-length') ?? 'NaN');
      if (!Number.isFinite(len) || len <= 0 || len > max) return new Response(`artifacts over ${max} bytes\n`, { status: 413 });
      await this.env.ARTIFACTS.put(`jobs/${p.job}/artifacts.tgz`, req.body, { httpMetadata: { contentType: 'application/gzip' } });
      return new Response('stored\n', { status: 201 });
    }
    if (url.protocol !== 'https:' || !hostAllowed(host, p.allow)) {
      this.ctx.waitUntil(job.note(`denied ${req.method} ${url.protocol}//${host}`).catch(() => {}));
      return new Response(`job-run cf: ${host} is not on the egress allow-list\n`, { status: 403 });
    }
    const out = new Request(req);
    out.headers.delete('authorization'); // the container never chooses a credential
    if (p.phase === 'fetch' && p.auth && gitReadWithCredential(req.method, url, p.group)) out.headers.set('authorization', p.auth);
    return fetch(out);
  }
}

// ---- Worker ---------------------------------------------------------------------------------------------------------------------------

const LABEL = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SUBPATH = /^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,199}$/;
const ART = /^[A-Za-z0-9_.][A-Za-z0-9_./*-]*$/;

/** The job spec job-run.sh sends, checked field by field: anything else is a 400 and nothing starts. */
export function parseSpec(o: unknown, env: Env, workspace: string): { spec: JobSpec; size: Size; creds: { user: string; token: string } | null } | string {
  if (!o || typeof o !== 'object') return 'body: a JSON object';
  const b = o as Record<string, unknown>;
  const id = String(b.id ?? '');
  const size = sizeOfId(id);
  if (!JOB_ID.test(id) || !size) return 'id: cp-cf-<s|b><8 hex>';
  const group = env.GIT_GROUP;
  const repoUrl = String(b.repoUrl ?? '');
  const repoRe = new RegExp(`^https://gitlab\\.com/${group.replace(/[^A-Za-z0-9_.-]/g, '')}/(?:[A-Za-z0-9_.-]+/){0,3}[A-Za-z0-9_.-]+\\.git$`);
  if (!repoRe.test(repoUrl) || repoUrl.includes('..')) return `repoUrl: https://gitlab.com/${group}/<path>.git`;
  const ref = String(b.ref ?? '');
  if (!REF.test(ref) || ref.includes('..')) return 'ref: a branch or commit';
  const subs = Array.isArray(b.subs) ? b.subs : [];
  if (subs.length > 8) return 'subs: at most 8';
  const subsOk: { path: string; ref: string }[] = [];
  for (const s of subs) {
    const path = String((s as Record<string, unknown>)?.path ?? '');
    const sref = String((s as Record<string, unknown>)?.ref ?? '');
    if (!SUBPATH.test(path) || path.includes('..') || !REF.test(sref) || sref.includes('..')) return 'subs: {path, ref}';
    subsOk.push({ path, ref: sref });
  }
  const steps = b.steps === 'none' ? 'none' : b.steps === 'npm-ci' ? 'npm-ci' : null;
  if (!steps) return 'steps: npm-ci or none';
  const cmd = String(b.cmd ?? '');
  if (!/^[A-Za-z0-9+/=]{1,65536}$/.test(cmd)) return 'cmd: base64, at most 64 KiB';
  const artifacts = String(b.artifacts ?? '').trim();
  if (artifacts && !artifacts.split(/\s+/).every((a) => ART.test(a) && !/(^|\/)\.\.(\/|$)/.test(a))) return 'artifacts: paths in the repository';
  const timeout = Number(b.timeout);
  const maxT = num(env.MAX_TIMEOUT_S, 3600);
  if (!Number.isInteger(timeout) || timeout < 60 || timeout > maxT) return `timeout: 60 to ${maxT} seconds`;
  const chat = String(b.chat ?? '');
  const role = String(b.role ?? '');
  const program = String(b.program ?? '');
  if (!LABEL.test(chat) || !LABEL.test(role) || !LABEL.test(program)) return 'chat, role, program: labels';
  let creds: { user: string; token: string } | null = null;
  if (b.creds !== undefined && b.creds !== null) {
    const c = b.creds as Record<string, unknown>;
    const user = String(c.user ?? '');
    const token = String(c.token ?? '');
    if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(user) || !/^[\x21-\x7e]{8,256}$/.test(token)) return 'creds: {user, token}';
    creds = { user, token };
  }
  return {
    spec: { id, workspace, chat, role, program, repoUrl, ref, subs: subsOk, steps, cmd, artifacts, timeout },
    size,
    creds,
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok\n');
    const body = req.method === 'POST' ? await req.arrayBuffer() : new ArrayBuffer(0);
    if (body.byteLength > 128 * 1024) return json({ error: 'body too large' }, 413);
    const auth = await verify(req, body, parseKeys(env.JOBRUN_KEYS), Math.floor(Date.now() / 1000));
    if (!auth.ok) return json({ error: 'unauthorized' }, 401);
    const ws = auth.workspace;
    const sch = env.SCHEDULER.get(env.SCHEDULER.idFromName('global'));

    if (url.pathname === '/jobs' && req.method === 'POST') {
      let parsed: ReturnType<typeof parseSpec>;
      try {
        parsed = parseSpec(JSON.parse(new TextDecoder().decode(body)), env, ws);
      } catch {
        return json({ error: 'body: JSON' }, 400);
      }
      if (typeof parsed === 'string') return json({ error: parsed }, 400);
      const { spec, size, creds } = parsed;
      const stub = nsOf(env, size).get(nsOf(env, size).idFromName(spec.id));
      const known = await stub.info(ws);
      if (known) return json(known, 200);
      const d = await sch.admit({ id: spec.id, workspace: ws, chat: spec.chat, program: spec.program, size });
      if (d.kind === 'wait') return json({ queued: true, ahead: d.ahead, reason: d.reason }, 429);
      if (d.kind === 'budget') return json({ budget: true, scope: d.scope, spentUsd: d.spentUsd, limitUsd: d.limitUsd }, 402);
      try {
        return json(await stub.begin(spec, creds), 201);
      } catch (e) {
        await sch.release(spec.id, 0, spec.program);
        return json({ error: `start failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` }, 503);
      }
    }
    if (url.pathname === '/jobs' && req.method === 'GET') {
      const chat = url.searchParams.get('chat');
      const ids = await sch.list(ws, chat);
      const out = [];
      for (const id of ids) {
        const i = await stubOf(env, id)?.info(ws);
        if (i) out.push(i);
      }
      return json(out);
    }
    if (url.pathname === '/budget' && req.method === 'GET') return json(await sch.snapshot());
    const m = /^\/jobs\/(cp-cf-[sb][0-9a-f]{8})(\/[a-z]+)?$/.exec(url.pathname);
    const stub = m ? stubOf(env, m[1]!) : null;
    if (!m || !stub) return json({ error: 'not found' }, 404);
    const what = m[2] ?? '';
    if (what === '' && req.method === 'GET') {
      const i = await stub.info(ws);
      return i ? json(i) : json({ error: 'not found' }, 404);
    }
    if (what === '' && req.method === 'DELETE') {
      const i = await stub.cancel(ws, url.searchParams.get('reason') ?? 'job-run.sh');
      return i ? json(i) : json({ error: 'not found' }, 404);
    }
    if (what === '/heartbeat' && req.method === 'POST') {
      const i = await stub.heartbeat(ws);
      return i ? json(i) : json({ error: 'not found' }, 404);
    }
    if (what === '/log' && req.method === 'GET') {
      const off = Number(url.searchParams.get('offset') ?? '0');
      if (!Number.isInteger(off) || off < 0) return json({ error: 'offset' }, 400);
      const r = await stub.readLog(ws, off);
      if (!r) return json({ error: 'not found' }, 404);
      return new Response(r.data, {
        headers: {
          'content-type': 'application/octet-stream',
          'x-next-offset': String(r.next),
          'x-state': r.info.state,
          'x-exit': r.info.exit === null ? '' : String(r.info.exit),
          'x-log-size': String(r.info.logSize),
        },
      });
    }
    if (what === '/artifacts' && req.method === 'GET') {
      const i = await stub.info(ws);
      if (!i) return json({ error: 'not found' }, 404);
      const o = await env.ARTIFACTS.get(`jobs/${m[1]}/artifacts.tgz`);
      return o ? new Response(o.body, { headers: { 'content-type': 'application/gzip' } }) : json({ error: 'no artifacts' }, 404);
    }
    return json({ error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
