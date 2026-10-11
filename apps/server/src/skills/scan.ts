// The skill scanner (Skillset PRD §11.1, FR5, FR9): deterministic, offline, and biased toward flagging,
// since a false positive costs the reviewer one tick. It reads a skill's files as bytes and never runs
// anything. It also decides what the review shows per file (kind, interpreter, executable), which skills
// FR5 refuses outright, and what the listing estimate counts.

import { SKILL_LISTING_CAP, type SkillFileInfo, type SkillFileKind, type SkillFinding, type SkillFindingCode, type SkillFindingTier, type SkillRisk } from '@portal/contracts';
import { text } from './frontmatter.js';

export interface ScanFile {
  path: string;
  /** Permission bits from the upload (0o644 when it had none). */
  mode: number;
  data: Buffer;
}

export interface ScanInput {
  name: string;
  /** The folder the skill came from (the name it should match), or null for a converted command. */
  folder: string | null;
  frontmatter: Record<string, unknown>;
  /** Paths relative to the skill folder; SKILL.md at the top. */
  files: ScanFile[];
}

export interface ScanResult {
  files: (SkillFileInfo & { data: Buffer })[];
  findings: SkillFinding[];
  /** FR5: reasons the skill can't be imported at all. */
  refused: string[];
  /** FR5: loads, but may be truncated or misbehave (also listed as Low findings). */
  warnings: string[];
  scripted: boolean;
  risk: SkillRisk;
  network: boolean;
  hooks: boolean;
  description: string;
  listingChars: number;
  license: string | null;
  licenseFiles: string[];
  openSourceLicense: boolean;
  requirements: string[];
  allowedTools: boolean;
}

/** Names Claude Code reserves for claude.ai skills (FR5). */
const RESERVED_NAMES = new Set(['synced', 'anthropic-skills']);
const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.fish', '.py', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.rb', '.pl', '.php', '.lua', '.ps1', '.bat', '.cmd']);
const EXT_INTERPRETER: Record<string, string> = {
  '.sh': 'sh',
  '.bash': 'bash',
  '.zsh': 'zsh',
  '.fish': 'fish',
  '.py': 'python',
  '.js': 'node',
  '.cjs': 'node',
  '.mjs': 'node',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.rb': 'ruby',
  '.pl': 'perl',
  '.php': 'php',
  '.lua': 'lua',
  '.ps1': 'powershell',
  '.bat': 'cmd',
  '.cmd': 'cmd',
};
const BYTECODE_EXT = new Set(['.pyc', '.pyo', '.class', '.jar', '.wasm', '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.node']);
const ARCHIVE_EXT = new Set(['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.zst']);
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx']);
const BROAD_TOOLS = new Set(['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch']);
const LICENSE_FILE = /^(?:LICEN[CS]E|COPYING|NOTICE)(?:[.-][\w.-]*)?$/i;
const REQUIREMENT_FILES = new Set(['requirements.txt', 'package.json', 'pyproject.toml', 'Pipfile', 'Gemfile', 'go.mod', 'Cargo.toml', 'environment.yml']);
const MAX_FINDINGS = 400;
const MAX_PER_FILE_AND_CODE = 25;

const ext = (path: string) => {
  const base = path.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
};
const basename = (path: string) => path.split('/').pop() ?? path;

/**
 * UTF-8 text without NUL bytes and with few control characters (judged on the first 8 KB); anything
 * else is a binary asset, shown as its size only.
 */
export function isText(data: Buffer): boolean {
  if (data.includes(0)) return false;
  const head = data.subarray(0, 8192);
  let control = 0;
  for (const b of head) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) control++;
  if (control > head.length / 10) return false;
  return !data.toString('utf8').includes('\uFFFD') || Buffer.from(data.toString('utf8'), 'utf8').equals(data);
}

/** `#!/usr/bin/env -S python3 -u` → python3; `#!/bin/bash` → bash. */
export function shebangInterpreter(firstLine: string): string | null {
  if (!firstLine.startsWith('#!')) return null;
  const parts = firstLine.slice(2).trim().split(/\s+/).filter((p) => p && p !== '-S');
  if (!parts.length) return null;
  const prog = basename(parts[0]!);
  if (prog === 'env') {
    const next = parts.slice(1).find((p) => !p.startsWith('-') && !p.includes('='));
    return next ? basename(next) : 'env';
  }
  return prog;
}

/** Native executables and bytecode by their first bytes (only checked for binary files). */
function nativeMagic(data: Buffer): string | null {
  if (data.length < 4) return null;
  const head = data.readUInt32BE(0);
  if (head === 0x7f454c46) return 'an ELF executable';
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(head)) return 'a Mach-O executable';
  if (head === 0xcafebabe) return 'a Mach-O or Java class file';
  if (head === 0x0061736d) return 'WebAssembly';
  if (data[0] === 0x4d && data[1] === 0x5a) return 'a Windows executable';
  return null;
}

/** Masks a detected credential: its recognizable prefix only. */
function maskCredential(match: string): string {
  if (match.startsWith('-----BEGIN')) return match;
  const m = /^(sk-ant-|ghp_|github_pat_|AKIA|xox[abp]-)/.exec(match);
  return `${m ? m[1] : match.slice(0, 4)}…`;
}

const CREDENTIALS: { re: RegExp; what: string }[] = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, what: 'A private key' },
  { re: /sk-ant-[A-Za-z0-9_-]{8,}/g, what: 'An Anthropic API key' },
  { re: /\bghp_[A-Za-z0-9]{20,}/g, what: 'A GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, what: 'A GitHub token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, what: 'An AWS access key' },
  { re: /\bxox[abp]-[A-Za-z0-9-]{10,}/g, what: 'A Slack token' },
];

/** Replaces every credential shape in `s` with its masked form (findings, the file viewer, stored text). */
export function redactCredentials(s: string): string {
  let out = s;
  for (const { re } of CREDENTIALS) out = out.replace(new RegExp(re.source, 'g'), (m) => maskCredential(m));
  return out;
}

const NETWORK: { re: RegExp; what: string }[] = [
  { re: /\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, what: 'Pipes into a shell' },
  { re: /\b(?:curl|wget)\b/, what: 'Downloads with curl or wget' },
  { re: /\b(?:ncat|socat)\b|\bnc\s+-/, what: 'Opens raw network connections' },
  // Not `~/.ssh` (a path, flagged as outside the skill) but `ssh host`, `/usr/bin/scp`.
  { re: /(?<![\w.-])(?:ssh|scp|rsync)\b(?!\/)/, what: 'Uses ssh, scp or rsync' },
  { re: /\bpip3?\s+install\b|\bnpm\s+(?:install|i|add)\b|\b(?:npx|uvx|bunx)\b/, what: 'Installs or runs packages' },
  { re: /\brequests\.|\burllib\b|\bfetch\(|\baxios\b|Invoke-WebRequest/, what: 'Makes network requests' },
];
const MANIPULATION = /ignore (?:all )?(?:previous|prior) instructions|ignore all prior|disregard the above|do not tell the user/i;
// eslint-disable-next-line no-misleading-character-class
const HIDDEN_CHARS = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060]|[\u{E0000}-\u{E007F}]/u;
const OUTSIDE = /(?:^|[\s'"`(=:])\.\.\/|~\/\.(?:ssh|aws|claude)\b|(?:^|[\s'"`(=:])\/etc(?:\/|\b)/;
const WRITES_SKILL_DIR = /(?:>>?|\btee\b|\bcp\b|\bmv\b|\bmkdir\b|\btouch\b|\brm\b|writeFile\w*|open\([^)]*['"][wa]\+?['"])[^\n|;]*\$\{?CLAUDE_SKILL_DIR|>>?\s*\.\/[\w.-]/;

/** Entries of `allowed-tools`, whether a list or a comma- or space-separated string. */
export function allowedToolEntries(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => text(x).trim()).filter(Boolean);
  if (typeof v !== 'string') return [];
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  const sep = v.includes(',') ? ',' : ' ';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A pre-approval broad enough to be High (§11.1): powerful tools, any MCP tool, or a bare wildcard. */
export function broadTool(entry: string): boolean {
  const tool = entry.split('(')[0]!.trim();
  const spec = entry.includes('(') ? entry.slice(entry.indexOf('(') + 1, entry.lastIndexOf(')')).trim() : '';
  if (BROAD_TOOLS.has(tool) || tool.startsWith('mcp__') || tool.includes('*')) return true;
  return spec === '*' || spec === ':*' || spec === '**';
}

const OSS = [
  { id: 'MIT', re: /^mit(?: license)?$/i, text: /\bMIT License\b|Permission is hereby granted, free of charge/ },
  { id: 'Apache-2.0', re: /^apache(?:[- ]license)?[- ]?(?:version )?2(?:\.0)?$/i, text: /Apache License,?\s+Version 2\.0/i },
  { id: 'BSD', re: /^(?:0bsd|bsd-[234]-clause(?:-\w+)?)$/i, text: /Redistribution and use in source and binary forms/ },
  { id: 'ISC', re: /^isc(?: license)?$/i, text: /\bISC License\b/ },
  { id: 'MPL-2.0', re: /^mpl-?2\.0$/i, text: /Mozilla Public License,? (?:v\. |version )2\.0/i },
  { id: 'GPL', re: /^(?:a|l)?gpl-?[23](?:\.[01])?(?:-only|-or-later|\+)?$/i, text: /GNU (?:AFFERO |LESSER )?GENERAL PUBLIC LICENSE/i },
  { id: 'Unlicense', re: /^unlicense$/i, text: /This is free and unencumbered software released into the public domain/ },
  { id: 'CC0-1.0', re: /^cc0(?:-1\.0)?$/i, text: /CC0 1\.0 Universal/ },
  { id: 'CC-BY-4.0', re: /^cc-by-4\.0$/i, text: /Creative Commons Attribution 4\.0/ },
  { id: 'Zlib', re: /^zlib$/i, text: /\bzlib License\b/i },
  { id: 'BSL-1.0', re: /^bsl-1\.0$/i, text: /Boost Software License/i },
];

/** Agent Skills name rules beyond what FR5 refuses: warnings. */
function nameWarnings(name: string, folder: string | null): string[] {
  const out: string[] = [];
  if (name.length > 64) out.push('The name is longer than 64 characters.');
  if (!/^[a-z0-9-]+$/.test(name)) out.push('The name should use only lowercase letters, digits and dashes.');
  if (/^-|-$|--/.test(name)) out.push('The name should not start or end with a dash, or have two in a row.');
  if (folder !== null && folder !== name) out.push(`The name “${name}” differs from its folder “${folder}”; it is delivered as ${name}.`);
  return out;
}

/** Scans one skill. Pure: same input, same result. */
export function scanSkill(input: ScanInput): ScanResult {
  const findings: SkillFinding[] = [];
  const ids = new Set<string>();
  const perKey = new Map<string, number>();
  const add = (tier: SkillFindingTier, code: SkillFindingCode, title: string, file: string | null, line: number | null, excerpt: string | null, needsAck: boolean, part?: number) => {
    const id = `${code}:${file ?? ''}:${line ?? 0}${part === undefined ? '' : `:${part}`}`;
    if (ids.has(id) || findings.length >= MAX_FINDINGS) return;
    const key = `${code}:${file ?? ''}`;
    const n = perKey.get(key) ?? 0;
    perKey.set(key, n + 1);
    if (n >= MAX_PER_FILE_AND_CODE) return;
    ids.add(id);
    const shown = excerpt === null ? null : redactCredentials(excerpt.trim()).slice(0, 200);
    findings.push({ id, tier, code, title, file, line, excerpt: shown, needsAck });
  };

  const refused: string[] = [];
  const warnings: string[] = [];
  const fm = input.frontmatter;
  const name = input.name;

  // FR5 names.
  // eslint-disable-next-line no-control-regex
  if (!name || /[:/\s\u0000-\u001f\u007f]/.test(name)) refused.push(`The name “${name.slice(0, 80)}” has a colon, slash, space or control character.`);
  if (RESERVED_NAMES.has(name)) refused.push(`“${name}” is reserved by Claude Code for claude.ai skills.`);
  if (name === '.' || name === '..' || name.length > 128) refused.push('The name can’t be used as a folder name.');
  warnings.push(...nameWarnings(name, input.folder));

  const description = text(fm.description);
  const whenToUse = text(fm.when_to_use);
  if (!description.trim()) warnings.push('There is no description, so Claude can’t tell when to use it.');
  if (description.length + whenToUse.length > SKILL_LISTING_CAP)
    warnings.push(`The description and when_to_use run to ${(description.length + whenToUse.length).toLocaleString('en')} characters; Claude Code cuts them at ${SKILL_LISTING_CAP.toLocaleString('en')}.`);

  const files: ScanResult['files'] = [];
  let network = false;
  for (const f of input.files) {
    const e = ext(f.path);
    const base = basename(f.path);
    const binary = !isText(f.data);
    const content = binary ? '' : f.data.toString('utf8');
    const firstLine = content.split('\n', 1)[0] ?? '';
    const shebang = binary ? null : shebangInterpreter(firstLine);
    const execBit = (f.mode & 0o111) !== 0;
    if (binary) {
      const magic = nativeMagic(f.data);
      if (magic) refused.push(`${f.path} is ${magic}; native code can’t be reviewed.`);
    }
    if (BYTECODE_EXT.has(e)) refused.push(`${f.path} is compiled code (${e}); it can’t be reviewed.`);

    const executable = execBit || !!shebang || SCRIPT_EXT.has(e);
    const isSkillMd = f.path === 'SKILL.md';
    const kind: SkillFileKind = isSkillMd ? 'skill_md' : binary ? 'asset' : executable ? 'script' : MARKDOWN_EXT.has(e) ? 'markdown' : 'text';
    const interpreter = executable ? (shebang ?? EXT_INTERPRETER[e] ?? (binary ? null : 'sh')) : null;
    // Delivered executable only when the upload said so or the file names its interpreter (§10.2).
    const mode = !binary && (execBit || !!shebang) ? 0o755 : 0o644;
    files.push({ path: f.path, size: f.data.length, mode, kind, interpreter, binary, data: f.data });

    if (executable && !binary) add('high', 'executable', `Runs as a script${interpreter ? ` (${interpreter})` : ''} with the workspace user’s rights.`, f.path, null, shebang ? firstLine : null, true);
    if (executable && binary) add('high', 'executable', 'An executable binary file.', f.path, null, null, true);

    // Credential files can't be acknowledged.
    if (/^\.env(?:\..+)?$/.test(base) && !/^\.env\.(?:example|sample|template)$/.test(base)) add('high', 'credential', 'An .env file, which usually holds secrets.', f.path, null, null, false);

    // Dense or large files.
    if (/(?:^|\/)(?:node_modules|vendor|site-packages|bower_components)\//.test(f.path)) add('medium', 'dense_file', 'A vendored dependency: too large to read line by line.', f.path, null, null, false);
    else if (ARCHIVE_EXT.has(e)) add('medium', 'dense_file', 'An archive: its contents can’t be reviewed here.', f.path, null, null, false);
    else if (f.data.length > 1024 * 1024) add('medium', 'dense_file', 'Larger than 1 MB.', f.path, null, null, false);
    else if (!binary && (/\.min\.(?:js|css)$/.test(f.path) || (content.length > 5000 && content.length / Math.max(1, content.split('\n').length) > 500)))
      add('medium', 'dense_file', 'Minified: too dense to read line by line.', f.path, null, null, false);

    if (binary) continue;
    const lines = content.split('\n');
    const md = MARKDOWN_EXT.has(e) || isSkillMd;
    const lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length;
    if (isSkillMd && lineCount > 500) warnings.push(`SKILL.md has ${lineCount.toLocaleString('en')} lines; keep it under 500 and move detail to reference files.`);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const n = i + 1;
      if (md) {
        if (/^\s*```!/.test(line)) add('high', 'injected_command', 'A ```! block runs a command while the skill loads, without a prompt.', f.path, n, line, true);
        if (/!`/.test(line)) add('high', 'injected_command', 'An !`command` runs while the skill loads, without a prompt.', f.path, n, line, true);
        if (/mcp__[A-Za-z0-9_-]+/.test(line) || /\buse the [\w .-]{1,40}? (?:mcp )?server\b/i.test(line)) add('high', 'mcp_reference', 'Points Claude at an MCP server or tool outside the skill.', f.path, n, line, true);
      }
      for (const c of CREDENTIALS) {
        const m = new RegExp(c.re.source).exec(line);
        if (m) add('high', 'credential', `${c.what} in the file. Remove it and import again.`, f.path, n, maskCredential(m[0]), false);
      }
      for (const nw of NETWORK) {
        if (nw.re.test(line)) {
          network = true;
          add('high', 'network', `${nw.what}: it may download code or send data.`, f.path, n, line, true);
          break;
        }
      }
      if (MANIPULATION.test(line)) add('high', 'instruction_manipulation', 'Text that tries to override instructions or hide things from the user.', f.path, n, line, true);
      if (HIDDEN_CHARS.test(i === 0 ? line.replace(/^\uFEFF/, '') : line)) add('high', 'instruction_manipulation', 'Invisible or direction-changing characters that can hide text.', f.path, n, JSON.stringify(line.slice(0, 120)), true);
      if (OUTSIDE.test(line)) add('medium', 'outside_paths', 'Reaches outside the skill folder.', f.path, n, line, false);
      if (WRITES_SKILL_DIR.test(line)) add('medium', 'writes_skill_dir', 'Writes inside the skill folder, which is read-only; use ${CLAUDE_PLUGIN_DATA}.', f.path, n, line, false);
    }
    if (md) {
      // Instructions hidden in HTML comments.
      for (const m of content.matchAll(/<!--([\s\S]*?)-->/g)) {
        if (!/[A-Za-z]{3,}/.test(m[1] ?? '')) continue;
        const n = content.slice(0, m.index ?? 0).split('\n').length;
        add('high', 'instruction_manipulation', 'Text in an HTML comment: Claude reads it, people reading the page don’t.', f.path, n, (m[1] ?? '').slice(0, 160), true);
      }
    }
  }

  // Frontmatter.
  const fmLine = (key: string) => {
    const md = input.files.find((f) => f.path === 'SKILL.md');
    if (!md) return null;
    const idx = md.data.toString('utf8').split('\n').findIndex((l) => l.startsWith(`${key}:`));
    return idx >= 0 ? idx + 1 : null;
  };
  const hooks = fm.hooks !== undefined && fm.hooks !== null;
  if (hooks) add('high', 'hooks', 'Frontmatter hooks run commands for the rest of the session once the skill is used.', 'SKILL.md', fmLine('hooks'), text(fm.hooks).slice(0, 160), true);
  const tools = allowedToolEntries(fm['allowed-tools']);
  tools.forEach((t, n) => {
    if (broadTool(t)) add('high', 'broad_allowed_tools', `Pre-approves ${t} for the turn that uses the skill, without a prompt.`, 'SKILL.md', fmLine('allowed-tools'), t, true, n);
  });
  if (tools.length && !tools.some(broadTool)) add('low', 'spec', `Pre-approves ${tools.join(', ')}.`, 'SKILL.md', fmLine('allowed-tools'), null, false);
  if (fm.context === 'fork' || fm.agent !== undefined || fm.model !== undefined || fm.effort !== undefined) {
    const parts = ['context', 'agent', 'model', 'effort'].filter((k) => fm[k] !== undefined).map((k) => `${k}: ${text(fm[k])}`);
    add('medium', 'fork_context', `Changes who runs it, the cost or prompt caching (${parts.join(', ')}).`, 'SKILL.md', fmLine(fm.context === 'fork' ? 'context' : (['agent', 'model', 'effort'].find((k) => fm[k] !== undefined) ?? 'context')), null, false);
  }
  for (const w of warnings) add('low', 'spec', w, null, null, null, false);

  // License (FR9) and declared requirements.
  const licenseFiles = files.filter((f) => LICENSE_FILE.test(basename(f.path))).map((f) => f.path);
  const declared = typeof fm.license === 'string' ? fm.license.trim() : null;
  let spdx = declared ? OSS.find((o) => o.re.test(declared))?.id : undefined;
  if (!spdx)
    for (const p of licenseFiles) {
      const body = files.find((f) => f.path === p)!.data.toString('utf8');
      spdx = OSS.find((o) => o.text.test(body))?.id;
      if (spdx) break;
    }
  const requirements: string[] = [];
  for (const key of ['requirements', 'dependencies', 'compatibility']) if (fm[key] !== undefined) requirements.push(`${key}: ${text(fm[key]).slice(0, 300)}`);
  for (const f of files) {
    if (!REQUIREMENT_FILES.has(basename(f.path))) continue;
    if (basename(f.path) === 'requirements.txt') {
      const pkgs = f.data.toString('utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).slice(0, 30);
      requirements.push(`${f.path}: ${pkgs.join(', ') || '(empty)'}`);
    } else requirements.push(f.path);
  }

  const scripted = findings.some((f) => f.code === 'executable' || f.code === 'injected_command' || f.code === 'hooks');
  const risk: SkillRisk = findings.some((f) => f.tier === 'high') ? 'high' : findings.some((f) => f.tier === 'medium') ? 'medium' : 'low';
  return {
    files,
    findings,
    refused: [...new Set(refused)],
    warnings,
    scripted,
    risk,
    network,
    hooks,
    description,
    listingChars: name.length + Math.min(SKILL_LISTING_CAP, description.length + whenToUse.length),
    license: declared ?? spdx ?? null,
    licenseFiles,
    openSourceLicense: !!spdx,
    requirements,
    allowedTools: fm['allowed-tools'] !== undefined,
  };
}
