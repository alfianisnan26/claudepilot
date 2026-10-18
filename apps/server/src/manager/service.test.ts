// T-968 review (2026-10-18, blocker 1): the General Manager's own runtime. prepare makes `kubernetes/general-manager` (1 CPU, 1536 MB) only
// when it is missing; enable refuses (CONFLICT) without that runtime and while it is not running, and on a running one makes the empty folder,
// the manager session (dontAsk) and its first message; one per person; status reports the runtime. Fakes for the chat and the workspaces.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import type { ChatSession } from '@portal/contracts';
import type { ChatController } from '../chat/controller.js';
import type { Workspaces } from '../workspaces/manager.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { MANAGER_DIR, MANAGER_RUNTIME_ID, ManagerService } from './service.js';

const OWNER = 'u_owner';

function fakes(o: { workspaces?: { id: string; status: string }[]; execOut?: string; execCode?: number } = {}) {
  const ws = [...(o.workspaces ?? [])];
  const created: unknown[] = [];
  const execs: { target: string; name: string; cmd: string[] }[] = [];
  const sessions: ChatSession[] = [];
  const calls: string[] = [];
  const workspaces = {
    list: async () => ws,
    create: async (req: { target: string; name: string }) => {
      created.push(req);
      ws.push({ id: `${req.target}/${req.name}`, status: 'creating' });
    },
    exec: async (target: string, name: string, cmd: string[]): Promise<ExecSession> => {
      execs.push({ target, name, cmd });
      let exit: (code: number | null) => void = () => undefined;
      let data: (d: Buffer) => void = () => undefined;
      // After the caller attached its handlers, as a real runtime's stream (I/O) would.
      setImmediate(() => (data(Buffer.from(o.execOut ?? 'ok\n')), exit(o.execCode ?? 0)));
      return { write: () => undefined, close: () => undefined, onData: (fn) => void (data = fn), onExit: (fn) => void (exit = fn) };
    },
  } as unknown as Workspaces;
  const chat = {
    managerOf: (ownerId: string) => [...sessions].reverse().find((s) => (s as ChatSession & { ownerId?: string }).ownerId === ownerId) ?? null,
    create: async (req: { workspaceId: string; cwd: string; title: string }, opts: { manager?: { ownerId: string } }) => {
      calls.push(`create ${req.workspaceId} ${req.cwd}`);
      const s = { id: `gm${sessions.length + 1}`, workspaceId: req.workspaceId, state: 'idle', title: req.title, ownerId: opts.manager?.ownerId } as unknown as ChatSession;
      sessions.push(s);
      return s;
    },
    control: async (id: string, what: string, args: { mode?: string }) => void calls.push(`control ${id} ${what} ${args.mode}`),
    send: async (id: string) => void calls.push(`send ${id}`),
    end: async (id: string) => {
      calls.push(`end ${id}`);
      const s = sessions.find((x) => x.id === id);
      if (s) (s as { state: string }).state = 'ended';
    },
  } as unknown as ChatController;
  return { svc: new ManagerService(chat, workspaces), ws, created, execs, sessions, calls };
}

const conflict = (re: RegExp) => (e: unknown) => e instanceof AppError && e.code === 'CONFLICT' && re.test(e.message);

test('prepare: makes kubernetes/general-manager with 1 CPU and 1536 MB only when it is missing; status reports the runtime', async () => {
  const f = fakes();
  assert.deepEqual(await f.svc.status(OWNER), { enabled: false, sessionId: null, state: null, workspaceId: null, runtime: null });
  const st = await f.svc.prepare(OWNER);
  assert.deepEqual(f.created, [{ target: 'kubernetes', name: 'general-manager', cpus: 1, memoryMb: 1536 }]);
  assert.deepEqual(st.runtime, { workspaceId: MANAGER_RUNTIME_ID, status: 'creating' });
  await f.svc.prepare(OWNER);
  assert.equal(f.created.length, 1, 'a second prepare makes nothing');

  const present = fakes({ workspaces: [{ id: MANAGER_RUNTIME_ID, status: 'running' }] });
  assert.deepEqual((await present.svc.prepare(OWNER)).runtime, { workspaceId: MANAGER_RUNTIME_ID, status: 'running' });
  assert.equal(present.created.length, 0, 'there already: nothing made');
});

test('enable: CONFLICT without the runtime and while it is not running; nothing is made', async () => {
  const none = fakes({ workspaces: [{ id: 'kubernetes/other', status: 'running' }] });
  await assert.rejects(none.svc.enable(OWNER), conflict(/Prepare/));
  const starting = fakes({ workspaces: [{ id: MANAGER_RUNTIME_ID, status: 'creating' }] });
  await assert.rejects(starting.svc.enable(OWNER), conflict(/not running/));
  for (const f of [none, starting]) {
    assert.deepEqual(f.execs, []);
    assert.deepEqual(f.calls, [], 'no session, no message');
  }
});

test('enable on a running runtime: the empty folder, the session there in dontAsk, its first message; once per person; disable ends it', async () => {
  const f = fakes({ workspaces: [{ id: MANAGER_RUNTIME_ID, status: 'running' }] });
  const st = await f.svc.enable(OWNER);
  assert.deepEqual([f.execs[0]?.target, f.execs[0]?.name], ['kubernetes', 'general-manager']);
  assert.match(f.execs[0]!.cmd.join(' '), new RegExp(`mkdir -p '${MANAGER_DIR}'.*rm -rf \\.claude \\.mcp\\.json CLAUDE\\.md`));
  assert.deepEqual(f.calls, [`create ${MANAGER_RUNTIME_ID} ${MANAGER_DIR}`, 'control gm1 mode dontAsk', 'send gm1']);
  assert.deepEqual(st, { enabled: true, sessionId: 'gm1', state: 'idle', workspaceId: MANAGER_RUNTIME_ID, runtime: { workspaceId: MANAGER_RUNTIME_ID, status: 'running' } });

  await f.svc.enable(OWNER);
  assert.equal(f.sessions.length, 1, 'a live manager is kept, not doubled');

  const off = await f.svc.disable(OWNER);
  assert.equal(off.enabled, false);
  assert.ok(f.calls.includes('end gm1'));
  // Enable again after a disable: a new manager (the ended one stays).
  assert.equal((await f.svc.enable(OWNER)).sessionId, 'gm2');
});

test('enable: a folder that could not be made refuses before any session is made', async () => {
  const f = fakes({ workspaces: [{ id: MANAGER_RUNTIME_ID, status: 'running' }], execCode: 1, execOut: '' });
  await assert.rejects(f.svc.enable(OWNER), (e: unknown) => e instanceof AppError && e.code === 'SERVICE_UNAVAILABLE');
  assert.deepEqual(f.calls, []);
});
