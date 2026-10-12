// `pilot-agent` (docs/prd/targets-connect.md §11.3): `run` (the default) · `enroll [--token-stdin]` · `doctor [--json]` · `identity` · `version`.
// `bin.ts` is the entry of the generated bundle (`agent.mjs`) and calls `main` below. Configuration is `agent.json` plus the environment (`config.ts`). The token is
// read from stdin (`enroll --token-stdin`, how the installer hands it over) or from PILOT_ENROLL_TOKEN, never from an argument: an argument
// shows in the process list. Exit codes follow the installer's (`CONNECT_INSTALL_EXIT`): 11 the portal can't be reached, 12 the token was
// refused, 14 anything else that went wrong.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CONNECT_AGENT_VERSION, CONNECT_INSTALL_EXIT, CONNECT_PROTOCOL } from '@portal/contracts';
import { runAgent, type AgentHandle } from './client.js';
import { ConfigError, loadConfig, type AgentConfig } from './config.js';
import { formatReport, reportFailed, runDoctor } from './doctor.js';
import { enroll, EnrollError } from './enroll.js';
import { buildHello } from './hello.js';
import { FileIdentityStore, fingerprintOf, IdentityError, type IdentityStore } from './identity.js';
import { createLogger, type Logger } from './log.js';
import type { NetConfig } from './net.js';

export interface MainIo {
  stdout(text: string): void;
  stderr(text: string): void;
  stdin(): Promise<string>;
}

const realIo: MainIo = {
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
  stdin: () =>
    new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      process.stdin.on('data', (c: Buffer) => parts.push(c));
      process.stdin.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      process.stdin.on('error', reject);
    }),
};

/** The first 12 hex of the SHA-256 of the file this code runs from, when it is a bundle (`agent.mjs`); the zeros of a source checkout otherwise. */
export function selfBuild(moduleUrl: string): string {
  try {
    const path = fileURLToPath(moduleUrl);
    if (!path.endsWith('.mjs')) return '000000000000';
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12);
  } catch {
    return '000000000000';
  }
}

const USAGE = `pilot-agent ${CONNECT_AGENT_VERSION}
  run                    connect to the portal and serve it (the default)
  enroll [--token-stdin] use a token (stdin, or PILOT_ENROLL_TOKEN) to enroll this machine
  doctor [--json]        check this machine, the portal and the way between
  identity               print the node id and key fingerprint
  version                print the version and build
`;

async function netConfig(config: AgentConfig): Promise<NetConfig> {
  let ca: string | null = null;
  if (config.caFile) ca = await readFile(config.caFile, 'utf8');
  return { ca, headers: config.headers };
}

function storeOf(config: AgentConfig): IdentityStore {
  return new FileIdentityStore(config.dataDir);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, build: string, io: MainIo = realIo): Promise<number> {
  const [command = 'run', ...args] = argv;
  if (command === 'version' || command === '--version') {
    io.stdout(`pilot-agent ${CONNECT_AGENT_VERSION} (build ${build}, protocol ${CONNECT_PROTOCOL})\n`);
    return 0;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    io.stdout(USAGE);
    return 0;
  }
  if (!['run', 'enroll', 'doctor', 'identity'].includes(command)) {
    io.stderr(`Unknown command “${command.slice(0, 40)}”.\n${USAGE}`);
    return 2;
  }
  let config: AgentConfig;
  try {
    config = loadConfig(env);
  } catch (e) {
    io.stderr(`${e instanceof ConfigError ? e.message : 'The configuration could not be read.'}\n`);
    return CONNECT_INSTALL_EXIT.preflight;
  }

  switch (command) {
    case 'identity': {
      try {
        const identity = await storeOf(config).load();
        if (!identity) {
          io.stderr(`This machine is not enrolled (no identity in ${config.dataDir}).\n`);
          return 1;
        }
        io.stdout(`node ${identity.node}\ntarget ${identity.target}\nportal ${identity.portalUrl}\nfingerprint ${fingerprintOf(identity)}\n`);
        return 0;
      } catch (e) {
        io.stderr(`${e instanceof IdentityError ? e.message : 'The identity could not be read.'}\n`);
        return 1;
      }
    }

    case 'doctor': {
      const json = args.includes('--json');
      const report = await runDoctor({ config, build, net: await netConfig(config), store: storeOf(config) });
      io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
      return reportFailed(report) ? 1 : 0;
    }

    case 'enroll': {
      const token = (args.includes('--token-stdin') ? (await io.stdin()).split(/\r?\n/)[0] : env.PILOT_ENROLL_TOKEN)?.trim();
      if (!token) {
        io.stderr('No token: pipe it in with --token-stdin, or set PILOT_ENROLL_TOKEN.\n');
        return CONNECT_INSTALL_EXIT.tokenRejected;
      }
      if (!config.url) {
        io.stderr('PILOT_URL is not set: the portal’s address is needed to enroll.\n');
        return CONNECT_INSTALL_EXIT.preflight;
      }
      const log = quietLog(config);
      try {
        const store = storeOf(config);
        if (await store.load().catch(() => null)) {
          io.stderr('This machine is already enrolled. Remove the identity (or revoke the node and uninstall) to enroll again.\n');
          return 0;
        }
        const identity = await enroll({
          url: config.url,
          token,
          hello: buildHello(config, { build, version: CONNECT_AGENT_VERSION, startedAt: new Date().toISOString() }),
          nodeName: config.nodeName,
          net: await netConfig(config),
          store,
          log,
          allowHttp: config.allowHttp,
        });
        io.stdout(`Enrolled as ${identity.node} (target ${identity.target}). Key fingerprint ${fingerprintOf(identity)}.\n`);
        return 0;
      } catch (e) {
        if (e instanceof EnrollError) {
          io.stderr(`${e.message}${e.hint ? ` ${e.hint}` : ''}\n`);
          return enrollExitCode(e);
        }
        io.stderr('Enrollment failed.\n');
        return CONNECT_INSTALL_EXIT.install;
      }
    }

    case 'run':
      return runForever(config, build);

    default:
      return 2;
  }
}

/**
 * The installer's exit codes for a failed enrollment: 11 the portal could not be reached, 12 the portal said no (the token, the target, the key or
 * the address: 401, 409, 422 and the rate limit), 14 anything else (a locked store, an answer that is not a portal's, an identity that could not be saved).
 */
export function enrollExitCode(e: EnrollError): number {
  if (e.reason === 'unreachable') return CONNECT_INSTALL_EXIT.unreachable;
  const refused = ['token_invalid', 'token_expired', 'token_used', 'token_revoked', 'target_enrolled', 'name_taken', 'bad_key', 'insecure_url', 'rate_limited'];
  return refused.includes(e.reason) ? CONNECT_INSTALL_EXIT.tokenRejected : CONNECT_INSTALL_EXIT.install;
}

/** A logger for one-shot commands: warnings and errors to stderr only. */
const quietLog = (config: AgentConfig): Logger => createLogger({ level: config.logLevel === 'debug' ? 'debug' : 'warn', sink: (l) => void process.stderr.write(l) });

async function runForever(config: AgentConfig, build: string): Promise<number> {
  const handle: AgentHandle = runAgent({
    config,
    build,
    net: await netConfig(config),
  });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    void handle.stop().finally(() => process.exit(signal === 'SIGINT' ? 130 : 0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  // An uncaught error logs (the logger redacts) and exits 1: a restart policy starts the agent again. A fatal rejection never gets here: it sleeps.
  const crash = (e: unknown) => {
    process.stderr.write(`${new Date().toISOString()} ERROR agent.crashed code=${(e as NodeJS.ErrnoException)?.code ?? 'ERR'}\n`);
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  await handle.done;
  return 0;
}
