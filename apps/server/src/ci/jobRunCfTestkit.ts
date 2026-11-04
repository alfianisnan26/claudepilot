// T-3542: a fake cp-jobrun-dispatcher for scripts/job-run.sh --backend cf. A separate node process (job-run.sh's client must reach it while
// the test waits), on 127.0.0.1, that checks every request's signature with the test key, records each request (method, path, body) in
// requests.jsonl and plays the scenario in scenario.json: queue answers, a budget refusal, the log (served a few bytes at a time, so a
// line is split across reads), the final state, artifacts. Test helper only; nothing here reaches Cloudflare.

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CfScenario {
  submitStatus?: number; // instead of 201 (400, 401, 503...)
  queue429?: number; // answer 429 this many times first
  budget?: boolean; // answer 402
  log?: string;
  chunk?: number; // bytes per log read (default 7)
  state?: 'finished' | 'cancelled' | 'deadline' | 'infra';
  exit?: number | null;
  hang?: boolean; // the log never ends (state stays running) until DELETE
  artifactsB64?: string; // a tar.gz, base64
  location?: string;
}

const FAKE = String.raw`#!/usr/bin/env node
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const F = process.env.FAKE_CF, KEY = process.env.FAKE_CF_KEY;
const sc = () => JSON.parse(fs.readFileSync(path.join(F, 'scenario.json'), 'utf8'));
const st = () => { try { return JSON.parse(fs.readFileSync(path.join(F, 'cfstate.json'), 'utf8')); } catch { return { n429: 0, jobs: {} }; } };
const save = (s) => fs.writeFileSync(path.join(F, 'cfstate.json'), JSON.stringify(s));
http.createServer((req, res) => {
  const parts = [];
  req.on('data', (d) => parts.push(d));
  req.on('end', () => {
    const body = Buffer.concat(parts);
    const ts = req.headers['x-jobrun-ts'] || '', ws = req.headers['x-jobrun-key'] || '', sig = req.headers['x-jobrun-sig'] || '';
    const h = crypto.createHash('sha256').update(body).digest('hex');
    const want = crypto.createHmac('sha256', KEY).update(req.method + '\n' + req.url + '\n' + ts + '\n' + h).digest('hex');
    const ok = ws === 'kohilabs' && want === sig && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
    fs.appendFileSync(path.join(F, 'requests.jsonl'), JSON.stringify({ method: req.method, url: req.url, ok, body: body.toString('utf8') }) + '\n');
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!ok) return json({ error: 'unauthorized' }, 401);
    const s = st(), c = sc();
    const m = /^\/jobs\/(cp-cf-[sb][0-9a-f]{8})(\/[a-z]+)?/.exec(req.url);
    const info = (id) => { const j = s.jobs[id]; return { id, state: j.state, exit: j.exit, reason: j.state === 'infra' ? 'container stopped' : null, created: j.created, runPhase: j.created + 2000, costUsd: 0.0123, location: c.location || 'SIN', chat: j.chat, role: j.role, program: 'memorid' }; };
    if (req.method === 'POST' && req.url === '/jobs') {
      if (c.submitStatus) return json({ error: 'refused by the fake' }, c.submitStatus);
      if (c.budget) return json({ budget: true, scope: 'total', spentUsd: 5.0123, limitUsd: 5 }, 402);
      if ((c.queue429 || 0) > s.n429) { s.n429++; save(s); return json({ queued: true, ahead: 2, reason: 'at most 6 at once' }, 429); }
      const spec = JSON.parse(body.toString('utf8'));
      s.jobs[spec.id] = { state: 'running', exit: null, off: 0, created: Date.now(), chat: spec.chat, role: spec.role };
      save(s); return json(info(spec.id), 201);
    }
    if (req.method === 'GET' && req.url.startsWith('/jobs?') || req.url === '/jobs') return json(Object.keys(s.jobs).map(info));
    if (!m || !s.jobs[m[1]]) return json({ error: 'not found' }, 404);
    const id = m[1], j = s.jobs[id], what = m[2] || '';
    if (req.method === 'DELETE' && what === '') { if (j.state === 'running') { j.state = 'cancelled'; } save(s); return json(info(id)); }
    if (req.method === 'GET' && what === '') return json(info(id));
    if (req.method === 'POST' && what === '/heartbeat') return json(info(id));
    if (req.method === 'GET' && what === '/artifacts') {
      if (!c.artifactsB64) return json({ error: 'no artifacts' }, 404);
      res.writeHead(200, { 'content-type': 'application/gzip' }); return res.end(Buffer.from(c.artifactsB64, 'base64'));
    }
    if (req.method === 'GET' && what === '/log') {
      const off = Number(new URL(req.url, 'http://x').searchParams.get('offset'));
      const all = Buffer.from(c.log || '');
      const chunk = all.subarray(off, off + (c.chunk || 7));
      if (off + chunk.length >= all.length && !c.hang && j.state === 'running') { j.state = c.state || 'finished'; j.exit = c.exit === undefined ? null : c.exit; }
      save(s);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-next-offset': String(off + chunk.length), 'x-state': j.state, 'x-exit': j.exit === null ? '' : String(j.exit) });
      return res.end(chunk);
    }
    return json({ error: 'not found' }, 404);
  });
}).listen(0, '127.0.0.1', function () { fs.writeFileSync(path.join(F, 'port'), String(this.address().port)); });
`;

export interface FakeCf {
  url: string;
  requests: () => { method: string; url: string; ok: boolean; body: string }[];
  scenario: (s: CfScenario) => void;
  stop: () => void;
}

/** Starts the fake in `dir` with `key` (64 hex) and waits until it listens. */
export async function startFakeCf(dir: string, key: string, scenario: CfScenario = {}): Promise<FakeCf & { child: ChildProcess }> {
  const file = join(dir, 'fake-cf.cjs');
  writeFileSync(file, FAKE);
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  const child = spawn(process.execPath, [file], { env: { FAKE_CF: dir, FAKE_CF_KEY: key, PATH: process.env.PATH }, stdio: 'ignore' });
  const t = Date.now();
  while (!existsSync(join(dir, 'port'))) {
    if (Date.now() - t > 10_000) throw new Error('the fake dispatcher did not start');
    await new Promise((r) => setTimeout(r, 20));
  }
  const url = `http://127.0.0.1:${readFileSync(join(dir, 'port'), 'utf8')}`;
  return {
    child,
    url,
    requests: () =>
      existsSync(join(dir, 'requests.jsonl'))
        ? readFileSync(join(dir, 'requests.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    scenario: (s) => writeFileSync(join(dir, 'scenario.json'), JSON.stringify(s)),
    stop: () => child.kill('SIGKILL'),
  };
}
