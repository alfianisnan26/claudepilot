// A background command's short label for the Agents panel (ticket T-149): Claude Code names a command task by its whole command line
// when the call had no description of its own, and a row that prints `cd … && timeout 300 node --import tsx --test … | grep …` takes ten
// lines of a phone. The label is the first command that does the work plus its first meaningful argument (`node test: imageBuild.test.ts`,
// `git push origin`, `scripts/image-build.sh`), the middle of a long path elided; the whole command stays one tap away (CommandDetail).
// Pure, display only, built on the transcript's own shell tokenizer. Defence in depth: what it is given was redacted by the portal, and
// it still never takes a flag's value, an assignment, a `user:password` pair or a credential-shaped word into a label.
import { tokenizeShell, visibly } from './shellTokens';

/** A label never runs longer than this (the row truncates it further). */
export const LABEL_MAX = 60;
/** Paths longer than this lose their middle. */
const PATH_MAX = 32;

interface Word {
  text: string;
  /** The tokenizer's kind of its first token (`command`, `flag`, `keyword`, `variable`, `string`, `text`). */
  kind: string;
}
interface Segment {
  words: Word[];
  /** Where its output goes (`> file`), when it does. */
  out: string | null;
}

/** Operators that end one simple command and start the next. */
const BREAKS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '(', ')', '`', '$(', '$((']);
/** Redirections whose next word is a file. */
const REDIRECTS = new Set(['>', '>>', '&>', '&>>', '>|', '2>', '<', '<<<']);
/** Keywords a command may follow in the same segment (`do make`, `then git push`). */
const LEAD_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time']);
/** Commands that set the stage rather than do the work: a label skips them when a later command does more. */
const SETUP = new Set([
  'cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', '.', 'true', 'false', ':', 'sleep', 'wait', 'trap', 'umask', 'shopt', 'ulimit',
  'alias', 'declare', 'local', 'readonly', 'echo', 'printf', 'mkdir', 'test', '[',
]);
/** Commands that run another one: the label is the inner command's. Their flags that take a value, and how many positionals they eat. */
const WRAPPERS: Record<string, { values: readonly string[]; positionals: number }> = {
  sudo: { values: ['-u', '-g', '-C', '-D', '-h', '-p', '-U'], positionals: 0 },
  env: { values: ['-u', '-C', '-S', '--unset', '--chdir'], positionals: 0 },
  timeout: { values: ['-s', '-k', '--signal', '--kill-after'], positionals: 1 },
  nice: { values: ['-n', '--adjustment'], positionals: 0 },
  ionice: { values: ['-c', '-n', '-p', '--class', '--classdata'], positionals: 0 },
  nohup: { values: [], positionals: 0 },
  setsid: { values: [], positionals: 0 },
  exec: { values: ['-a'], positionals: 0 },
  command: { values: [], positionals: 0 },
  builtin: { values: [], positionals: 0 },
  stdbuf: { values: ['-i', '-o', '-e'], positionals: 0 },
  flock: { values: ['-w', '-E', '--timeout', '--conflict-exit-code'], positionals: 1 },
  xargs: { values: ['-n', '-I', '-P', '-d', '-L', '-s', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file'], positionals: 0 },
  watch: { values: ['-n', '--interval', '-d'], positionals: 0 },
  npx: { values: ['-p', '--package', '-c', '--call'], positionals: 0 },
  bunx: { values: ['-p', '--package'], positionals: 0 },
  caffeinate: { values: ['-t', '-w'], positionals: 0 },
};
/** Commands whose first positional is a subcommand (`git push origin`, `npm run build`, `kubectl get pods`), and their value flags. */
const SUBCOMMANDS: Record<string, readonly string[]> = {
  git: ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '-m', '--message', '-b', '-B', '-o', '--format', '--author', '--since', '--until', '-n'],
  npm: ['-w', '--workspace', '--prefix', '-C', '--registry', '--cache', '--tag'],
  pnpm: ['-C', '--dir', '-F', '--filter', '-w'],
  yarn: ['--cwd'],
  bun: ['--cwd', '-e', '--eval'],
  docker: ['-H', '--host', '--context', '-c', '--config', '-f', '--file', '-p', '--project-name', '-e', '--env', '-u', '--user', '-w', '--workdir', '--name', '-v', '--volume', '--network', '-t', '--tag', '--platform'],
  podman: ['-H', '--url', '--connection', '-f', '--file', '-e', '--env', '-u', '--user', '-w', '--workdir', '--name', '-v', '--volume', '-t', '--tag'],
  kubectl: ['-n', '--namespace', '--context', '--kubeconfig', '-l', '--selector', '-o', '--output', '-c', '--container', '-f', '--filename', '--field-selector', '--sort-by', '--since', '--tail', '-p', '--patch', '--type'],
  helm: ['-n', '--namespace', '--kube-context', '-f', '--values', '--set', '--set-string', '--version', '-o', '--output'],
  gh: ['-R', '--repo', '-b', '--body', '-t', '--title', '-B', '--base', '-H', '--head', '-q', '--jq', '-L', '--limit', '-f', '--field', '-F', '--raw-field', '-X', '--method', '--json', '-s', '--state', '-l', '--label'],
  cargo: ['-p', '--package', '--manifest-path', '--target', '-j', '--jobs', '--features'],
  go: ['-C', '-o', '-run', '-tags', '-ldflags', '-timeout'],
  systemctl: ['-H', '--host', '-M', '--machine'],
  apt: ['-o', '-t'],
  'apt-get': ['-o', '-t'],
  pip: ['-r', '--requirement', '-c', '--constraint', '-i', '--index-url', '--target'],
  pip3: ['-r', '--requirement', '-c', '--constraint', '-i', '--index-url', '--target'],
  brew: [],
  terraform: ['-var', '-var-file', '-chdir', '-target'],
  argocd: ['--server', '--auth-token', '-o', '--output', '--grpc-web-root-path'],
};
/** Runtimes: `--test` makes the label "<runtime> test: <files>"; their value flags. */
const RUNTIMES: Record<string, readonly string[]> = {
  node: ['--import', '-r', '--require', '--loader', '--experimental-loader', '--env-file', '--input-type', '-C', '--conditions', '--disable-warning', '--test-name-pattern', '--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-timeout', '--watch-path', '--title', '--max-old-space-size'],
  tsx: ['--import', '-r', '--require', '--tsconfig', '--env-file', '--test-name-pattern', '--test-reporter', '--test-concurrency'],
  deno: ['--config', '-c', '--import-map', '--allow-read', '--allow-write', '--allow-net', '--allow-env', '--filter'],
  bun: ['--cwd', '-r', '--preload', '--filter'],
};
/** Value flags of any other command that can carry a credential or a request body (`curl -u user:password`, `-H "Authorization: …"`). */
const SECRET_FLAGS = new Set([
  '--password', '--pass', '--passwd', '--token', '--secret', '--key', '--api-key', '--apikey', '--auth', '--client-secret', '--header',
  '--cookie', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--form', '--user', '--proxy-user', '--oauth2-bearer',
]);
const NET_TOOLS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'mysql', 'mysqldump', 'psql', 'redis-cli', 'mongo', 'mongosh', 'sshpass', 'htpasswd', 'openssl', 'ssh', 'scp']);
const NET_VALUE_FLAGS = new Set([
  '-u', '-H', '-d', '-b', '-c', '-C', '-F', '-p', '-P', '-a', '-x', '-U', '-o', '-X', '-A', '-e', '-i', '-l', '-W', '-w', '-E', '-m', '-T', '-r', '-z',
  '-h', '--host', '--username', '--dbname', '--max-time', '--connect-timeout', '--retry', '--output', '--request', '--user-agent', '--write-out',
  '--resolve', '--cacert', '--cert',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

const unquote = (t: string, kind: string): string => {
  if (kind !== 'string') return t;
  if (t.startsWith("$'")) return t.slice(2, t.endsWith("'") && t.length > 2 ? -1 : undefined);
  if ((t.startsWith("'") || t.startsWith('"')) && t.length >= 2 && t.endsWith(t[0]!)) return t.slice(1, -1);
  return t.slice(1);
};

/** The command line cut into simple commands: their words (quotes taken off) and where each one's output goes. */
function segments(src: string): Segment[] {
  const out: Segment[] = [];
  let seg: Segment = { words: [], out: null };
  let word: Word | null = null;
  let target: 'out' | 'in' | 'delim' | null = null;
  let skipDelimiter = false;
  const endWord = () => {
    if (!word) return;
    if (target === 'out') seg.out = word.text;
    else if (target === null) seg.words.push(word);
    target = null;
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (seg.words.length || seg.out) out.push(seg);
    seg = { words: [], out: null };
  };
  for (const tok of tokenizeShell(src)) {
    if (tok.kind === 'heredoc') {
      skipDelimiter = true;
      continue;
    }
    if (tok.kind === 'keyword' && skipDelimiter) {
      skipDelimiter = false;
      continue;
    }
    if (tok.kind === 'comment') {
      endWord();
      continue;
    }
    // A line break ends a command; a continued one (`\` at the end) and blanks only end a word.
    if (tok.kind === 'text' && (/^\s+$/.test(tok.text) || tok.text === '\\\n')) {
      if (tok.text.includes('\n') && tok.text !== '\\\n') endSegment();
      else endWord();
      continue;
    }
    if (tok.kind === 'operator') {
      if (BREAKS.has(tok.text)) endSegment();
      else {
        endWord();
        // Where the output goes names the work (`cat > notes.md`); what is read in, or the errors' file, does not.
        if (REDIRECTS.has(tok.text)) target = tok.text.startsWith('<') || tok.text === '2>' ? 'in' : 'out';
        else if (tok.text === '<<' || tok.text === '<<-') target = 'delim';
      }
      continue;
    }
    const text = unquote(tok.text, tok.kind);
    if (word) word.text += text;
    else word = { text, kind: tok.kind };
  }
  endSegment();
  return out;
}

const basename = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p;

/** A path with its middle elided when long: `/workspaces/…/coordinator/ph.sh`; a long name keeps its two ends. */
export function elidePath(p: string, max = PATH_MAX): string {
  if (p.length <= max) return p;
  const parts = p.split('/');
  const base = parts.pop() ?? '';
  if (base.length + 2 > max) {
    const half = Math.max(4, Math.floor((max - 1) / 2));
    return `${base.slice(0, half)}…${base.slice(-half)}`;
  }
  const head = p.startsWith('/') ? `/${parts[1] ?? ''}` : (parts[0] ?? '');
  const dirs = parts.slice(p.startsWith('/') ? 2 : 1);
  const tail: string[] = [];
  for (let i = dirs.length - 1; i >= 0; i--) {
    const next = [dirs[i]!, ...tail];
    if (`${head}/…/${next.join('/')}/${base}`.length > max) break;
    tail.unshift(dirs[i]!);
  }
  const withHead = `${head}/…/${tail.length ? `${tail.join('/')}/` : ''}${base}`;
  if (head && withHead.length <= max) return withHead;
  return `…/${base}`;
}

/** Whether a word could be a credential or a request body rather than something worth naming. */
export function looksSecret(w: string): boolean {
  if (/\s/.test(w)) return true; // a quoted script, a message, a header: never a label
  if (/redacted/i.test(w)) return true;
  // A URL is named by its host and path (its query never shows), unless it carries a user and password.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(w);
  if (/=/.test(w)) return true; // key=value
  if (/^[^/:@\s]+:[^/\s]+$/.test(w) && !/:\d+$/.test(w)) return true; // user:password (host:port is fine)
  // A long run of letters and digits with no separators a name or a path would have, mixed case or digits: a generated secret.
  if (w.length >= 16 && !/[/.]/.test(w) && /\d/.test(w) && /[A-Za-z]/.test(w)) return true;
  if (w.length >= 24 && !/[/.]/.test(w) && /[a-z]/.test(w) && /[A-Z]/.test(w)) return true;
  return false;
}

/** A URL without its scheme, query and fragment, its path elided when long: `api.example.com/…/items`. */
function shortUrl(u: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(u);
  if (!m) return u;
  const host = m[1]!;
  const path = m[2]!.replace(/\/+$/, '');
  return path ? elidePath(`${host}${path}`) : host;
}

/** A positional worth naming: a URL by its host and path, a path or a long name with its middle elided. */
const shown = (w: string): string => (/^[a-z][a-z0-9+.-]*:\/\//i.test(w) ? shortUrl(w) : w.length > PATH_MAX ? elidePath(w) : w);

/** The positionals after `from`, skipping flags (and the value of a flag in `values`). */
function positionals(words: Word[], from: number, values: ReadonlySet<string>): { list: string[]; flags: string[] } {
  const list: string[] = [];
  const flags: string[] = [];
  for (let i = from; i < words.length; i++) {
    const w = words[i]!.text;
    if (w === '--') {
      list.push(...words.slice(i + 1).map((x) => x.text));
      break;
    }
    if (/^-/.test(w) && w.length > 1) {
      flags.push(w);
      if (!w.includes('=') && values.has(w)) i++;
      continue;
    }
    list.push(w);
  }
  return { list, flags };
}

/** One simple command's label, or null when it only sets the stage (`cd`, `export`) or is no command (`done`, `fi`). */
function segmentLabel(seg: Segment, depth: number): { label: string; setup: boolean } | null {
  const words = seg.words;
  let i = 0;
  while (i < words.length && words[i]!.kind === 'keyword' && LEAD_KEYWORDS.has(words[i]!.text)) i++;
  if (i < words.length && words[i]!.kind === 'keyword') return null;
  while (i < words.length && ASSIGNMENT.test(words[i]!.text)) i++;
  // Wrappers run the command after them.
  for (let guard = 0; guard < 8 && i < words.length; guard++) {
    const name = basename(words[i]!.text);
    const wrap = WRAPPERS[name];
    if (!wrap) break;
    const values = new Set(wrap.values);
    let j = i + 1;
    let eaten = 0;
    while (j < words.length) {
      const w = words[j]!.text;
      if (name === 'env' && ASSIGNMENT.test(w)) {
        j++;
        continue;
      }
      if (/^-/.test(w) && w.length > 1) {
        j += !w.includes('=') && values.has(w) ? 2 : 1;
        continue;
      }
      if (eaten < wrap.positionals) {
        eaten++;
        j++;
        continue;
      }
      break;
    }
    if (j >= words.length) return { label: name, setup: false };
    i = j;
  }
  if (i >= words.length) return seg.out ? { label: `> ${shown(seg.out)}`, setup: true } : null;
  const cmdWord = words[i]!.text;
  const name = basename(cmdWord);
  const cmd = cmdWord.includes('/') ? elidePath(cmdWord) : cmdWord;
  const rest = i + 1;

  // `bash -c '<script>'`: the script's own label.
  if (/^(ba|z|da|k)?sh$/.test(name) && depth < 2) {
    for (let j = rest; j < words.length - 1; j++) {
      if (/^-[a-z]*c[a-z]*$/.test(words[j]!.text)) {
        const inner = commandLabel(words[j + 1]!.text, depth + 1);
        if (inner) return { label: inner, setup: false };
      }
    }
  }

  const runtime = RUNTIMES[name];
  if (runtime) {
    const { list, flags } = positionals(words, rest, new Set(runtime));
    if (flags.includes('--test') || flags.some((f) => f.startsWith('--test='))) {
      const files = list.filter((w) => !looksSecret(w));
      return { label: files.length ? `${cmd} test: ${shown(basename(files[0]!))}${files.length > 1 ? ` +${files.length - 1}` : ''}` : `${cmd} test`, setup: false };
    }
    const evalFlag = flags.find((f) => ['-e', '--eval', '-p', '--print'].includes(f));
    if (evalFlag) return { label: `${cmd} ${evalFlag}`, setup: false };
    const first = list.find((w) => !looksSecret(w));
    // bun's subcommands (`bun run build`, `bun test`) read like npm's.
    if (name === 'bun' && first && !first.includes('/') && !first.includes('.')) {
      const next = list.slice(list.indexOf(first) + 1).find((w) => !looksSecret(w));
      return { label: next ? `${cmd} ${first} ${shown(next)}` : `${cmd} ${first}`, setup: false };
    }
    return { label: first ? `${cmd} ${shown(first)}` : cmd, setup: false };
  }

  if (/^python(\d(\.\d+)?)?$/.test(name)) {
    const { list, flags } = positionals(words, rest, new Set(['-m', '-W', '-X']));
    const m = words.findIndex((w, j) => j >= rest && w.text === '-m');
    if (m !== -1 && words[m + 1] && !looksSecret(words[m + 1]!.text)) return { label: `${cmd} -m ${words[m + 1]!.text}`, setup: false };
    if (flags.includes('-c')) return { label: `${cmd} -c`, setup: false };
    const first = list.find((w) => !looksSecret(w));
    return { label: first ? `${cmd} ${shown(first)}` : cmd, setup: false };
  }

  const sub = SUBCOMMANDS[name];
  if (sub) {
    const { list } = positionals(words, rest, new Set([...sub, ...SECRET_FLAGS]));
    const [first, ...more] = list.filter((w) => !looksSecret(w));
    if (!first) return { label: cmd, setup: false };
    // `docker compose up`, `gh pr view`: two words of subcommand; else the subcommand and its first argument.
    const next = more[0];
    return { label: next ? `${cmd} ${first} ${shown(next)}` : `${cmd} ${first}`, setup: false };
  }

  const values = new Set<string>(SECRET_FLAGS);
  if (NET_TOOLS.has(name)) for (const f of NET_VALUE_FLAGS) values.add(f);
  const { list } = positionals(words, rest, values);
  const first = list.find((w) => !looksSecret(w));
  const label = first ? `${cmd} ${shown(first)}` : seg.out && !looksSecret(seg.out) ? `${cmd} > ${shown(seg.out)}` : cmd;
  return { label, setup: SETUP.has(name) };
}

/**
 * The label of a command line: the first simple command that does the work (past `cd x &&`, env prefixes, `timeout`, `flock`, `nice`,
 * a pipe's later stages and heredoc bodies) with its first meaningful argument; a setup command only when nothing else runs. Disguising
 * characters stay visible (`⟦U+202E⟧`). Empty for an empty line.
 */
export function commandLabel(command: string, depth = 0): string {
  let fallback: string | null = null;
  for (const seg of segments(command)) {
    const got = segmentLabel(seg, depth);
    if (!got) continue;
    if (!got.setup) return clip(got.label);
    fallback ??= got.label;
  }
  return fallback ? clip(fallback) : '';
}

const clip = (label: string): string => {
  const v = visibly(label.replace(/\s+/g, ' ').trim());
  return v.length > LABEL_MAX ? `${v.slice(0, LABEL_MAX - 1)}…` : v;
};

/** Whether a task's text reads as a shell command line rather than a description someone wrote (`Run the unit tests`). */
export function looksLikeCommand(text: string): boolean {
  return /&&|\|\||[|;<>`$\n]|^\s*[A-Za-z_][A-Za-z0-9_]*=|(^|\s)--?[A-Za-z]|^\s*[.~]?\//.test(text);
}
