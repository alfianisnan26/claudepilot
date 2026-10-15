// Chat sessions: folder trust (chat-sessions PRD FR43). In print mode Claude Code loads a folder's own
// project settings without asking (the hooks in .claude/settings*.json, the servers in .mcp.json), so
// the portal asks first. cp-session `trustscan` names what the folder would load and hashes those files;
// a session starts there only when there's nothing to load, or the person trusted that exact hash.

import { AppError, defineErrorCodes, isAppError } from '@isnanme/core';
import { CHAT_FOLDER_UNTRUSTED, type ChatFolderScan, type ChatTrustRequest } from '@portal/contracts';
import { cleanUrl } from '../repos/text.js';
import { defineSetting } from '../settings/registry.js';
import type { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { workspacePath } from './files.js';
import { CP_SESSION_PATH, HOST_REFUSED, TRUST_EMPTY_HASH, TRUST_FILES } from './host.js';
import { redact } from './redact.js';
import { ChatStore } from './store.js';

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    FOLDER_UNTRUSTED: true;
  }
}
defineErrorCodes({ [CHAT_FOLDER_UNTRUSTED]: { status: 409, message: 'Check this folder’s project settings and trust it first.' } });

/** Why a session in a folder trusted before won't start: its files changed since. */
export const FOLDER_CHANGED = "This folder's project settings changed since you trusted it. Check them and trust it again.";
/**
 * Folder trust without a person (T-38, T-366, D-55, D-62). Off: a folder with project settings waits for a person, and any change
 * to its files stops the next start, resume, wake or Move until a person trusts it again. On:
 * - the FIRST trust is by repository identity only (D-62): a folder never trusted before is trusted by itself only when it is the top
 *   of a git clone or worktree whose normalised origin ({@link repoIdentity}) is the one of a folder trusted in the same workspace, and
 *   its scanned files (settings, skills, commands, agents: the hash) are byte for byte that folder's, which is scanned again and must
 *   still be at the hash it was trusted at. Never by what the files say: in-folder edits plus any exact build or test rule are any
 *   command, which no reading of the rules can catch. A stranger's repository always waits for a person;
 * - a trusted folder whose hash changes is trusted again by itself only when the classifier finds permission rules only and no
 *   blanket or command-runner allow rule ({@link autoTrustRefusal}).
 * Each is audited (`trust.auto`, `same-repo` or `changed`). Rules can widen what runs without asking, so it asks to confirm.
 */
export const AUTO_TRUST_SETTING = 'chat.trust.autoPermissionOnly';

defineSetting({
  key: AUTO_TRUST_SETTING,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'sessions',
  order: 20,
  label: 'Trust folders by repository',
  help: 'A folder never trusted before is trusted by itself only when it is a git clone or worktree of a repository that already has a trusted folder in this workspace: the same origin remote, and Claude Code settings, skills, commands and agents byte for byte the ones of that folder, which must still be as it was trusted. A stranger’s repository always waits for you, whatever its settings say. A trusted folder whose settings change is trusted again by itself only when they hold permission rules only (allow, deny, ask) and no broad rule. Broad, so it waits for you: a hook, MCP server, plugin or env; a skill, command or agent that loads hooks, sets a permission mode, has a frontmatter key other than name, description, model, tools, color, argument-hint and allowed-tools, or cannot be checked; an allow rule (or a skill’s allowed-tools) that is a blanket (Bash, Edit, Read), a path outside the folder, an edit rule that may reach the folder’s .git or .claude unless the same file denies Edit(.git), Edit(.git/**) and Edit(.claude/**), a Bash rule with < or > or a path argument outside the folder, a wildcard command other than ls, pwd or echo, or an exact command that runs another (sudo, env, bash, flock, timeout, xargs, node -e and the like). Not caught in a change: an exact rule that runs code the folder controls (npm test, make, a script) plus editing inside the folder is the same as any command, so keep such rules out yourself. Rules can let tools run without asking.',
  protective: false,
});

/** Why a folder never trusted is not trusted by itself (D-62): it isn't the top of a git repository with an origin remote. */
export const NOT_A_REPO = 'it is not the top folder of a git clone or worktree with an origin remote';
/** Why a folder never trusted is not trusted by itself (D-62): no folder of its repository is trusted with exactly these files. */
export const NO_SAME_REPO = 'no trusted folder of the same repository has exactly these settings, skills, commands and agents';
/** At most this many trusted folders at the same hash are scanned again to find one of the same repository. */
const SAME_REPO_CANDIDATES = 10;

/** Why a session in a folder never trusted won't start. */
export const FOLDER_NOT_TRUSTED = 'This folder has Claude Code project settings that load when a session starts. Check them and trust the folder first.';

/**
 * A scan as the API returns it: the contract's fields, plus which settings files are there (`files`) and
 * which of them couldn't be read for names (`invalid`: not a JSON object, too large, or leading outside
 * the home folder or into the portal's own files). Names only, never a value or a command.
 */
export interface FolderScan extends ChatFolderScan {
  files: string[];
  invalid: string[];
  rulesOnly: boolean;
  broadAllow: boolean;
  /** {@link HostScan.extras}; a scan without it counts as `unscanned` (fail closed). */
  extras?: string[];
  /** Set by the session launch when the policy is on and the folder can't be trusted by itself: why, by name ({@link autoTrustRefusal}). */
  autoRefusal?: string;
  /** {@link HostScan.origin}. */
  origin?: string;
}

/** What `trustscan` prints, checked and cleaned. */
export interface HostScan {
  hash: string;
  files: string[];
  invalid: string[];
  mcpServers: string[];
  hooks: string[];
  plugins: string[];
  allowRules: number;
  envNames: string[];
  /** Nothing but permission rules (`allow`, `deny`, `ask`) in files that were all read; false from a host older than this. */
  rulesOnly: boolean;
  /** An allow rule is a blanket or a command runner (T-366, host.ts `TRUST_BROAD_JQ`); true from a host older than this (fail closed). */
  broadAllow: boolean;
  /**
   * What the folder's skills, commands and agents load (T-366), from {@link EXTRAS} only: `skill:hooks`, `agent:mode`, `unreadable`
   * and the like; `unscanned` from a host older than this (fail closed).
   */
  extras: string[];
  /**
   * The repository the folder is the top of (T-366, D-62): its origin remote as {@link repoIdentity} reads it. Left out when the
   * folder isn't the top of a git work tree with an origin, the URL can't be read for sure, or the host is older than this.
   */
  origin?: string;
}

/** Each `extras` value and why it keeps a folder from being trusted by itself; anything else from the host is a fault. */
const EXTRAS: Record<string, string> = {
  'skill:hooks': 'a skill loads hooks',
  'command:hooks': 'a command loads hooks',
  'agent:hooks': 'an agent loads hooks',
  'skill:mode': 'a skill sets a permission mode',
  'command:mode': 'a command sets a permission mode',
  'agent:mode': 'an agent sets a permission mode',
  unreadable: 'a skill, command or agent file can’t be checked or has a frontmatter key beyond plain text',
  unscanned: 'the workspace’s chat host doesn’t check skills, commands and agents',
};

export interface TrustOptions {
  /** Brings cp-session up to date first (a host older than folder trust has no `trustscan`). */
  install?: (workspaceId: string) => Promise<void>;
  /** How long starting the scan, and then the scan itself, may each take. */
  timeoutMs?: number;
}

const SCAN_TIMEOUT_MS = 30_000;
/** Output kept from `trustscan` (names only, so far below this); more fails the scan. */
const SCAN_MAX_OUTPUT = 4_000_000;
/** Each list shows at most this many names, each at most this long. */
const MAX_NAMES = 1_000;
const MAX_NAME = 200;
const HASH = /^[0-9a-f]{64}$/;
const SCANNED = new Set<string>(TRUST_FILES);

const REFUSED =
  'Can’t use that folder. It may be gone or not a folder, and sessions run only in the workspace’s home folder, apart from the portal’s own files.';

const unexpected = () => new AppError('SERVICE_UNAVAILABLE', 'The workspace gave an unexpected answer about the folder’s project settings.', { expose: true });
const tooSlow = () => new AppError('SERVICE_UNAVAILABLE', 'The workspace took too long to check the folder. Try again.', { expose: true });
/** One line of a message, bounded, for showing. */
const oneLine = (e: unknown) => (e instanceof Error ? e.message.replace(/\s+/g, ' ').trim().slice(0, 300) : '');

/* ---------- Reading the host's answer ---------- */

/** A list of names as shown: strings only, one line each, redacted (a key can hold anything), bounded, unique. */
function names(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw unexpected();
  const out = new Set<string>();
  for (const raw of v as string[]) {
    if (out.size >= MAX_NAMES) break;
    // eslint-disable-next-line no-control-regex
    const name = redact(raw.replace(/[\x00-\x1f\x7f]+/g, ' ').trim());
    if (name) out.add(name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name);
  }
  return [...out];
}

/** Which of the scanned settings files a list names (anything else is a host fault). */
function fileNames(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && SCANNED.has(x))) throw unexpected();
  return [...new Set(v as string[])];
}

/** An origin URL longer than this is not read (never clipped: two clipped URLs could read as one repository). */
const MAX_ORIGIN = 300;
/** Ports a scheme uses anyway: `ssh://host:22/x` is `host/x`. */
const DEFAULT_PORTS = new Set(['22', '80', '443', '9418']);

/**
 * A repository's identity from its origin URL (T-366, D-62), so a clone over https, ssh or the scp form reads the same:
 * `github.com/owner/repo` (host in lower case, a default port, `user:password@`, a query, a fragment, a trailing `/` and `.git`
 * taken out; the path keeps its case), `file:/abs/path` for a local one (`/abs/path`, `file:///abs/path`). Null when it can't be
 * read for sure (a relative path, `..`, a space or control character, too long, no path): such a folder is never matched.
 */
export function repoIdentity(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_ORIGIN || /\s/.test(raw.trim())) return null;
  const url = cleanUrl(raw, MAX_ORIGIN * 2);
  if (!url) return null;
  let host = '';
  let path: string;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/.exec(url);
  if (scheme) {
    const proto = scheme[1]!.toLowerCase();
    if (proto === 'file') {
      if (scheme[2] && scheme[2].toLowerCase() !== 'localhost') return null;
      path = scheme[3] ?? '';
    } else {
      const authority = scheme[2]!.replace(/^.*@/, '').toLowerCase();
      const m = /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/.exec(authority);
      if (!m) return null;
      host = m[2] && !DEFAULT_PORTS.has(m[2]) ? `${m[1]}:${m[2]}` : m[1]!;
      path = scheme[3] ?? '';
    }
  } else if (url.startsWith('/')) {
    path = url;
  } else {
    // The scp form `[user@]host:path`: no slash before the first colon.
    const m = /^(?:[^@/]*@)?([A-Za-z0-9.-]+):(.+)$/.exec(url);
    if (!m) return null;
    host = m[1]!.toLowerCase();
    path = m[2]!.startsWith('/') ? m[2]! : `/${m[2]}`;
  }
  path = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!path || path === '/' || path.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return host ? `${host}${path}` : `file:${path}`;
}

/** Parses `trustscan`'s one JSON line; anything off is a 503, never a scan that reads as empty. */
export function parseTrustScan(out: string): HostScan {
  let v: unknown;
  try {
    v = JSON.parse(out.trim());
  } catch {
    throw unexpected();
  }
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.hash !== 'string' || !HASH.test(o.hash)) throw unexpected();
  const allowRules = o.allowRules;
  if (typeof allowRules !== 'number' || !Number.isSafeInteger(allowRules) || allowRules < 0) throw unexpected();
  if (o.rulesOnly !== undefined && typeof o.rulesOnly !== 'boolean') throw unexpected();
  if (o.broadAllow !== undefined && typeof o.broadAllow !== 'boolean') throw unexpected();
  const extras = o.extras === undefined ? ['unscanned'] : o.extras;
  if (!Array.isArray(extras) || !extras.every((x) => typeof x === 'string' && Object.hasOwn(EXTRAS, x))) throw unexpected();
  const scan: HostScan = {
    hash: o.hash,
    files: fileNames(o.files),
    invalid: fileNames(o.invalid),
    mcpServers: names(o.mcpServers),
    hooks: names(o.hooks),
    plugins: names(o.plugins),
    allowRules,
    envNames: names(o.envNames),
    rulesOnly: o.rulesOnly === true,
    broadAllow: o.broadAllow !== false,
    extras: [...new Set(extras as string[])],
  };
  // Nothing there must read exactly as nothing there.
  if ((scan.files.length === 0) !== (scan.hash === TRUST_EMPTY_HASH)) throw unexpected();
  if (o.origin !== undefined && typeof o.origin !== 'string') throw unexpected();
  // An origin that can't be read for sure is left out: that folder is never matched by repository (fail closed).
  const origin = repoIdentity(o.origin);
  if (origin) scan.origin = origin;
  return scan;
}

/* ---------- Running the scan ---------- */

/** A workspace id as `<target>/<name>`, trimmed; anything else is a 422. */
function workspaceKey(raw: unknown): [string, string, string] {
  const id = typeof raw === 'string' ? raw.trim() : '';
  const i = id.indexOf('/');
  if (i <= 0 || i === id.length - 1) throw new AppError('VALIDATION_FAILED', 'Pick a workspace.', { details: { workspaceId: 'Expected <target>/<name>.' } });
  return [id, id.slice(0, i), id.slice(i + 1)];
}

/** The folder to scan, absolute and tidied; anything else is a 400 that never reaches the workspace. */
function folderPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new AppError('BAD_REQUEST', 'Say which folder to check.');
  return workspacePath(raw.trim());
}

/** Waits at most `ms` for `p`; a value that only arrives later goes to `late` (to be closed). */
function within<T>(p: Promise<T>, ms: number, late: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(tooSlow());
    }, ms);
    p.then(
      (v) => {
        if (done) return late(v);
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Collects the command's output until it exits, then closes the exec; too much output or too long fails it. */
function collect(exec: ExecSession, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      exec.close();
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(tooSlow())), timeoutMs);
    exec.onData((b) => {
      if (done) return;
      size += b.length;
      if (size > SCAN_MAX_OUTPUT) return settle(() => reject(unexpected()));
      chunks.push(b);
    });
    // Let output already on its way land before the exit is acted on.
    exec.onExit((code) => setImmediate(() => settle(() => resolve({ code, out: Buffer.concat(chunks).toString('utf8') }))));
  });
}

/** Runs `cp-session trustscan` on a folder. 400 when the policy refuses it, 503 when the workspace can't answer. */
export async function readTrustScan(workspaces: Workspaces, workspaceId: string, folder: string, opts: TrustOptions = {}): Promise<HostScan> {
  const [id, target, name] = workspaceKey(workspaceId);
  const path = folderPath(folder);
  const timeoutMs = opts.timeoutMs ?? SCAN_TIMEOUT_MS;
  let installError: unknown = null;
  if (opts.install) await within(opts.install(id), timeoutMs, () => undefined).catch((e: unknown) => void (installError = e ?? new Error('')));
  let exec: ExecSession;
  try {
    exec = await within(workspaces.exec(target, name, ['sh', CP_SESSION_PATH, 'trustscan', path]), timeoutMs, (late) => late.close());
  } catch (e) {
    // Already readable (no such workspace, or too slow): as it is.
    if (isAppError(e) && (e.status < 500 || e.expose)) throw e;
    const why = oneLine(e);
    throw new AppError('SERVICE_UNAVAILABLE', why ? `Couldn’t reach the workspace: ${why}` : 'Couldn’t reach the workspace. Is it running?', { expose: true, cause: e });
  }
  const { code, out } = await collect(exec, timeoutMs);
  if (code === 0) return parseTrustScan(out);
  // A host that couldn't be brought up to date refuses `trustscan` as an unknown command: say why.
  if (installError) throw new AppError('SERVICE_UNAVAILABLE', oneLine(installError) || 'Couldn’t bring the workspace’s chat host up to date.', { expose: true, cause: installError });
  if (code === HOST_REFUSED) throw new AppError('BAD_REQUEST', REFUSED);
  throw new AppError('SERVICE_UNAVAILABLE', `Couldn’t check the folder’s project settings (exit ${code ?? 'unknown'}).`, { expose: true });
}

/* ---------- Scanning and trusting ---------- */

/**
 * What a folder's own project settings would load (by name), with `empty` (none of the settings files
 * is there, so nothing needs confirming) and `trusted` (this workspace and folder were trusted at this
 * very hash). Any settings file that is there counts, even one that can't be read for names: what it
 * runs can't be shown, and Claude Code may still load it.
 */
export async function scanFolder(workspaces: Workspaces, store: Store, workspaceId: string, folder: string, opts: TrustOptions = {}): Promise<FolderScan> {
  const [id] = workspaceKey(workspaceId);
  const path = folderPath(folder);
  const host = await readTrustScan(workspaces, id, path, opts);
  const trust = new ChatStore(store).folderTrust(id, path);
  return {
    workspaceId: id,
    folder: path,
    hash: host.hash,
    empty: host.files.length === 0,
    mcpServers: host.mcpServers,
    hooks: host.hooks,
    plugins: host.plugins,
    allowRules: host.allowRules,
    envNames: host.envNames,
    trusted: trust !== null && trust.hash === host.hash,
    files: host.files,
    invalid: host.invalid,
    rulesOnly: host.rulesOnly,
    broadAllow: host.broadAllow,
    extras: host.extras,
    ...(host.origin ? { origin: host.origin } : {}),
  };
}

/**
 * Why a scan can't be trusted without a person (T-38, T-366, D-55), by name only, never a rule or a value; null when it can:
 * every file read, no `.mcp.json`, no server, hook, plugin or env name, no skill, command or agent that loads hooks, sets a
 * permission mode or can't be checked, nothing but permission rules (the host's word), and no allow rule that is a blanket or a
 * command runner. The names are checked too, not only the host's word.
 */
export function autoTrustRefusal(scan: FolderScan): string | null {
  const why: string[] = [];
  if (scan.invalid.length) why.push('a settings file can’t be read');
  if (scan.mcpServers.length || scan.files.includes('.mcp.json')) why.push('it starts MCP servers');
  if (scan.hooks.length) why.push('it loads hooks');
  if (scan.plugins.length) why.push('it enables plugins');
  if (scan.envNames.length) why.push('it sets environment variables');
  // A scan without the field (built before T-366's skills check) is one nobody checked.
  for (const x of scan.extras ?? ['unscanned']) why.push(EXTRAS[x] ?? EXTRAS.unreadable!);
  if (!scan.rulesOnly && why.length === 0) why.push('it holds more than permission rules');
  if (scan.broadAllow) why.push('an allow rule runs any command or covers everything');
  return why.length ? why.join('; ') : null;
}

/**
 * Whether a CHANGED scan may be trusted again without a person (under {@link AUTO_TRUST_SETTING}, T-38): a folder with settings,
 * trusted before at another hash, with nothing {@link autoTrustRefusal} names. A folder never trusted is never trusted by what its
 * files say (D-62): only by repository ({@link findSameRepo}).
 */
export function autoTrustable(scan: FolderScan, before: { hash: string | null } | null): boolean {
  if (scan.empty || scan.trusted || !before?.hash || before.hash === scan.hash) return false;
  return autoTrustRefusal(scan) === null;
}

/**
 * The trusted folder of the same repository a folder never trusted may take its trust from (T-366, D-62): in the same workspace,
 * trusted at the folder's very hash (its settings, skills, commands and agents byte for byte), scanned again now and still at that
 * hash, with the same {@link repoIdentity} of its origin. `{ refusal }` names why not, for the 409 ({@link NOT_A_REPO},
 * {@link NO_SAME_REPO}); a candidate that can't be scanned (gone, refused, slow) is skipped.
 */
export async function findSameRepo(
  workspaces: Workspaces,
  store: Store,
  scan: FolderScan,
  opts: TrustOptions = {},
): Promise<{ matched: string } | { refusal: string }> {
  if (scan.empty || !scan.origin) return { refusal: NOT_A_REPO };
  const candidates = new ChatStore(store).foldersTrustedAt(scan.workspaceId, scan.hash, SAME_REPO_CANDIDATES + 1).filter((f) => f !== scan.folder);
  for (const folder of candidates.slice(0, SAME_REPO_CANDIDATES)) {
    const other = await readTrustScan(workspaces, scan.workspaceId, folder, { timeoutMs: opts.timeoutMs }).catch(() => null);
    if (other && other.hash === scan.hash && other.files.length > 0 && other.origin === scan.origin) return { matched: folder };
  }
  return { refusal: NO_SAME_REPO };
}

/**
 * Trusts a folder as the person checked it: scans again and stores the trust (the hash, the names, the
 * time, who) only when the hash is still the one they confirmed. Otherwise a 409 `FOLDER_UNTRUSTED`
 * carries the new scan, to check again.
 */
export async function trustFolder(
  workspaces: Workspaces,
  store: Store,
  req: Partial<ChatTrustRequest>,
  opts: TrustOptions & { actor?: string | null } = {},
): Promise<FolderScan> {
  const [workspaceId] = workspaceKey(req.workspaceId);
  const folder = folderPath(req.folder);
  const hash = typeof req.hash === 'string' ? req.hash.trim().toLowerCase() : '';
  if (!HASH.test(hash)) throw new AppError('VALIDATION_FAILED', 'Say which scan you checked.', { details: { hash: 'Expected the scan’s hash.' } });
  const scan = await scanFolder(workspaces, store, workspaceId, folder, opts);
  if (scan.hash !== hash) throw new AppError(CHAT_FOLDER_UNTRUSTED, 'This folder’s project settings changed while you checked them. Check them again.', { details: scan });
  saveTrust(store, scan, opts.actor ?? null);
  return { ...scan, trusted: true };
}

/** Stores the trust of a scan: its hash and what it named (names only), when and by whom. */
export function saveTrust(store: Store, scan: FolderScan, actor: string | null): void {
  const { files, invalid, mcpServers, hooks, plugins, allowRules, envNames } = scan;
  new ChatStore(store).saveFolderTrust(scan.workspaceId, scan.folder, scan.hash, { files, invalid, mcpServers, hooks, plugins, allowRules, envNames }, actor);
}

/**
 * The refusal a session start gets in a folder that needs trusting: 409 `FOLDER_UNTRUSTED`, the scan as details. When the
 * policy was on and refused to trust it by itself, the message says why (names only).
 */
export function untrustedError(scan: ChatFolderScan & { autoRefusal?: string }, changed: boolean): AppError {
  const base = changed ? FOLDER_CHANGED : FOLDER_NOT_TRUSTED;
  return new AppError(CHAT_FOLDER_UNTRUSTED, scan.autoRefusal ? `${base} Not trusted by itself: ${scan.autoRefusal}.` : base, { details: scan });
}
