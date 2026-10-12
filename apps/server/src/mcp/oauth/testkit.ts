import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecSession, ShellSession } from '../../workspaces/runtime.js';
import type { OAuthHost } from './signin.js';

/**
 * A stand-in for `claude mcp login --no-browser <name>` that prints and reads what Claude Code 2.1.296 does (the
 * grammar in parse.test.ts), so the sign-in can be tested without a workspace. The server's name picks the behaviour:
 *   plugin:cpm-ok:<key>        waits for a good address (`code=goodcode`), refuses others, ends on `error=`
 *   plugin:cpm-none:<key>      "No MCP server named …" and exit 1
 *   plugin:cpm-selfdone:<key>  signs in by itself after 200 ms (the browser reached its listener)
 *   plugin:cpm-silent:<key>    prints nothing at all
 *   plugin:cpm-nourl:<key>     fails before it prints a URL
 *   plugin:cpm-garbled:<key>   an older Claude Code that doesn't know the flag
 *   plugin:cpm-http:<key>      prints an http:// sign-in page
 *   plugin:cpm-stubborn:<key>  like cpm-ok, but ignores Ctrl-C (only a signal from `kill <pid>` stops it)
 */
const FAKE_LOGIN = String.raw`
const fs = require('fs');
const name = process.argv[1];
const mode = name.split(':')[1];
const out = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'));
out('cp-pid:' + process.pid + '\n');
if (mode === 'cpm-silent') setInterval(() => {}, 1000);
else if (mode === 'cpm-none') { out('No MCP server named "' + name + '". Configured servers: other\n'); process.exit(1); }
else if (mode === 'cpm-garbled') { out('error: unknown option \'--no-browser\'\n'); process.exit(1); }
else if (mode === 'cpm-nourl') { out('Starting authentication for "' + name + '"…\nCouldn\'t complete authentication for "' + name + '": SDK auth failed: Incompatible auth server: does not support dynamic client registration\n'); process.exit(1); }
else {
  const port = 24819;
  const state = 'st' + Math.random().toString(36).slice(2, 10);
  const base = mode === 'cpm-http' ? 'http://git.example.com' : 'https://git.example.com';
  const auth = base + '/login/oauth/authorize?response_type=code&client_id=pub-1&code_challenge=abc&code_challenge_method=S256&redirect_uri=' + encodeURIComponent('http://localhost:' + port + '/callback') + '&state=' + state + '&scope=read';
  out('Starting authentication for "' + name + '"…\n[mcp-sdk] SEP-2352: stored OAuth credential has no \'issuer\' stamp\nVisit this URL to authorize:\n  \x1b]8;;' + auth + '\x07\x1b[94m' + auth + '\x1b[39m\x1b]8;;\x07\n\nWaiting for authorization… (^C to cancel)\n');
  const prompt = () => out('\x1b[1G\x1b[0JOr paste the redirect URL here: ');
  prompt();
  if (mode === 'cpm-selfdone') setTimeout(() => { out('Authenticated with "' + name + '". Its tools are now available in Claude Code.\n'); process.exit(0); }, 200);
  let buf = '';
  const handle = (line) => {
    if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, line + '\n');
    out(line + '\n');
    let u = null;
    try { u = new URL(line); } catch {}
    if (u && u.port === String(port) && u.pathname === '/callback' && u.searchParams.get('state') === state) {
      if (u.searchParams.get('error')) { out('Couldn\'t complete authentication for "' + name + '": OAuth error: ' + u.searchParams.get('error') + ' - ' + u.searchParams.get('error_description') + '\n'); process.exit(1); }
      if (u.searchParams.get('code') === 'goodcode') { out('\nAuthenticated with "' + name + '". Its tools are now available in Claude Code.\n'); process.exit(0); }
      // A provider that echoes the address back in its complaint.
      out('Couldn\'t complete authentication for "' + name + '": invalid_grant at ' + line + '\n'); process.exit(1);
    }
    out('That doesn\'t look like a redirect URL for this sign-in — paste the full address from the browser page this sign-in opened.\n');
    prompt();
  };
  process.stdin.on('data', (d) => {
    for (const ch of d.toString()) {
      if (ch === '\x03' && mode !== 'cpm-stubborn') { out('^C\n'); process.exit(130); }
      if (ch === '\r' || ch === '\n') { const l = buf; buf = ''; if (l) handle(l); } else buf += ch;
    }
  });
}
process.on('SIGTERM', () => process.exit(143));
`;

/** What the fake runtime saw: what the login read, and what it was asked to stop. */
export class FakeLoginHost implements OAuthHost {
  readonly dir = mkdtempSync(join(tmpdir(), 'cp-oauth-'));
  readonly log = join(this.dir, 'read.log');
  readonly shells: { target: string; name: string; command: string[]; child: ChildProcess }[] = [];
  readonly kills: string[][] = [];
  /** Stops a PID by SIGTERM when asked, like `kill`. Off: the process ignores the request (a stuck login). */
  killWorks = true;

  /** The lines the login read from its terminal. */
  read(): string[] {
    return existsSync(this.log) ? readFileSync(this.log, 'utf8').split('\n').filter(Boolean) : [];
  }

  alive(): ChildProcess[] {
    return this.shells.map((s) => s.child).filter((c) => c.exitCode === null && c.signalCode === null);
  }

  async shell(target: string, name: string, _size: { cols: number; rows: number }, command?: string[]): Promise<ShellSession> {
    // The portal's command is `sh -c SCRIPT sh <dir> <server>`: the fake takes the server.
    const server = command?.at(-1) ?? '';
    const child = spawn(process.execPath, ['-e', FAKE_LOGIN, server], { env: { ...process.env, FAKE_LOG: this.log }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => undefined);
    this.shells.push({ target, name, command: command ?? [], child });
    const data: ((d: Buffer) => void)[] = [];
    const exit: ((code: number | null) => void)[] = [];
    child.stdout.on('data', (d: Buffer) => data.forEach((fn) => fn(d)));
    child.stderr.on('data', (d: Buffer) => data.forEach((fn) => fn(d)));
    child.on('close', (code) => exit.forEach((fn) => fn(code)));
    return {
      write: (d) => void child.stdin.write(d),
      resize: () => undefined,
      close: () => void child.kill('SIGKILL'),
      onData: (fn) => void data.push(fn),
      onExit: (fn) => void exit.push(fn),
    };
  }

  async exec(_target: string, _name: string, command: string[]): Promise<ExecSession> {
    this.kills.push(command);
    if (this.killWorks && command[0] === 'kill') {
      try {
        process.kill(Number(command[1]), 'SIGTERM');
      } catch {
        // already gone
      }
    }
    const exit: ((code: number | null) => void)[] = [];
    queueMicrotask(() => exit.forEach((fn) => fn(0)));
    return { write: () => undefined, close: () => undefined, onData: () => undefined, onExit: (fn) => void exit.push(fn) };
  }

  done() {
    for (const s of this.shells) s.child.kill('SIGKILL');
    rmSync(this.dir, { recursive: true, force: true });
  }
}

