// The agent's log (docs/prd/targets-connect.md §11.7, FR30). Plain lines: `<iso time> <LEVEL> <event> key=value …`.
//
// What it never writes: an argv, an environment, a file name from a `put`, any content, a token, a key, a header value. That is kept by
// how the agent calls it (events and ids, never user text) and enforced twice here: every value is trimmed to 200 characters, and
// anything registered with `addSecret` (the enrollment token, the private key, the Kubernetes bearer, the Access headers) or shaped
// like one (`cpen_…`, a PKCS8 key, `Bearer …`, a PEM private key) is replaced in the finished line. A canary test runs every service
// with canary values and fails if one shows up (T-SEC).
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Registers a value that must never appear in any line (too short ones are ignored: they would mangle ordinary text). */
  addSecret(value: string | null | undefined): void;
  /** Where warnings and errors also go (the portal's `log` message while connected); null stops it. The caller rate-limits. */
  setRemote?(fn: ((level: 'warn' | 'error', message: string) => void) | null): void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export const isLogLevel = (s: string | undefined): s is LogLevel => s === 'debug' || s === 'info' || s === 'warn' || s === 'error';

/** Shapes that are secrets wherever they appear. */
const SHAPES: RegExp[] = [
  /cpen_[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9_+/=-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

export interface LoggerOptions {
  level?: LogLevel;
  /** Where finished lines go (stdout for containers, a test's array). */
  sink?: (line: string) => void;
  /** Also append to a file, rotated: `path`, `path.1` … (the host agent: 5 files of 5 MB). */
  file?: { path: string; maxBytes?: number; keep?: number };
  /** Warnings and errors, for the portal's `log` message (the caller rate-limits). Receives the redacted line body. */
  remote?: (level: 'warn' | 'error', message: string) => void;
  now?: () => Date;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  let remote = opts.remote ?? null;
  const min = ORDER[opts.level ?? 'info'];
  const secrets = new Set<string>();
  const now = opts.now ?? (() => new Date());
  const keep = opts.file?.keep ?? 5;
  const maxBytes = opts.file?.maxBytes ?? 5 * 1024 * 1024;
  let fileSize = -1;

  const scrub = (text: string) => {
    let out = text;
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join('[redacted]');
    for (const shape of SHAPES) out = out.replace(shape, '[redacted]');
    return out;
  };

  const value = (v: string | number | boolean | null | undefined) => {
    if (v === undefined || v === null) return 'null';
    const text = String(v).replace(/[\r\n\0]+/g, ' ').slice(0, 200);
    return /^[A-Za-z0-9_.:/@+-]*$/.test(text) && text !== '' ? text : JSON.stringify(text);
  };

  const rotate = () => {
    if (!opts.file) return;
    for (let i = keep - 1; i >= 1; i--) {
      try {
        if (i === keep - 1) rmSync(`${opts.file.path}.${i}`, { force: true });
        renameSync(i === 1 ? opts.file.path : `${opts.file.path}.${i - 1}`, `${opts.file.path}.${i}`);
      } catch {
        // a missing older file is fine
      }
    }
    fileSize = 0;
  };

  const toFile = (line: string) => {
    const file = opts.file;
    if (!file) return;
    try {
      if (fileSize < 0) {
        mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
        fileSize = (() => {
          try {
            return statSync(file.path).size;
          } catch {
            return 0;
          }
        })();
      }
      if (fileSize + line.length > maxBytes) rotate();
      appendFileSync(file.path, line, { mode: 0o600 });
      fileSize += line.length;
    } catch {
      // logging must never take the agent down
    }
  };

  const write = (level: LogLevel, event: string, fields?: LogFields) => {
    if (ORDER[level] < min) return;
    const parts = [now().toISOString(), level.toUpperCase().padEnd(5), event];
    if (fields) for (const [k, v] of Object.entries(fields)) if (v !== undefined) parts.push(`${k}=${value(v)}`);
    const body = scrub(parts.slice(2).join(' '));
    const line = `${parts[0]} ${parts[1]} ${body}\n`;
    (opts.sink ?? ((l) => process.stdout.write(l)))(line);
    toFile(line);
    if (level === 'warn' || level === 'error') remote?.(level, body);
  };

  return {
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
    addSecret: (v) => {
      if (v && v.length >= 6) secrets.add(v);
    },
    setRemote: (fn) => void (remote = fn),
  };
}

/** A logger that says nothing and keeps nothing (tests that don't look). */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, addSecret() {} };

/** A logger that collects lines, and everything it was told is secret, for the canary tests. */
export function collectingLogger(level: LogLevel = 'debug') {
  const lines: string[] = [];
  const logger = createLogger({ level, sink: (l) => lines.push(l) });
  return { logger, lines, text: () => lines.join('') };
}
